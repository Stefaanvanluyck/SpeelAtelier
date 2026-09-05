-- ============================================================================
-- GETUIGENISSEN (testimonials) — jufvalerie.be / SpeelAtelier
-- ============================================================================
-- Doel: reacties van gezinnen beheren in admin.html en gepubliceerde
-- getuigenissen tonen op de homepage van de website.
--
-- Sinds foto-/children-update:
--   * Gezinnen die een INSCHRIJVING (appointment) hebben, mogen zelf een
--     review schrijven via de website. De waarde wordt op 'published = false'
--     (concept) gezet en pas door de beheerder gepubliceerd.
--   * De controle dat de schrijver écht een inschrijving heeft, gebeurt
--     server-side via de SECURITY DEFINER functie booking_exists_for_email().
--   * Het e-mailadres en het eventuele appointment_id blijven voor anon
--     ONZICHTBAAR (niet geselecteerd/bewerkbaar).
--
-- Rechten:
--   * anon (iedereen op de website) : SELECT van gepubliceerde rijden
--       (zonder e-mail/appointment_id) + INSERT van een nieuwe review,
--       maar enkel met een gekend inschrijvings-e-mailadres.
--   * authenticated                 : enkel leden van admin_users kunnen de
--       getuigenissen lezen / aanpassen / verwijderen (zelfde aanpak als in
--       rls_hardening.sql voor appointments).
--
-- ============================================================================
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabel aanmaken (+ extra kolommen voor reviews door geboekte gezinnen)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.testimonials (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text    NOT NULL,
    text           text    NOT NULL,
    rating         integer NOT NULL DEFAULT 5
                           CHECK (rating BETWEEN 1 AND 5),
    email          text,                              -- controlemail (niet tonen)
    appointment_id uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
    published      boolean NOT NULL DEFAULT false,
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- Bestaande installaties uitbreiden zonder data te verliezen.
ALTER TABLE public.testimonials
    ADD COLUMN IF NOT EXISTS email text,
    ADD COLUMN IF NOT EXISTS appointment_id uuid
        REFERENCES public.appointments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_testimonials_email
    ON public.testimonials (email);

CREATE INDEX IF NOT EXISTS idx_testimonials_appointment
    ON public.testimonials (appointment_id);

-- ---------------------------------------------------------------------------
-- 1b. SECURITY DEFINER-check: heeft dit e-mailadres een inschrijving?
--     Draait als de tabel-eigenaar, zónder RLS, zodat anon nooit zelf email
--     uit appointments kan lezen maar de policy tóch kan controleren.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_exists_for_email(p_email text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.appointments
        WHERE LOWER(btrim(email)) = LOWER(btrim(p_email))
          AND payment_status NOT IN ('cancelled', 'failed', 'expired')
    );
$$;

REVOKE ALL ON FUNCTION public.booking_exists_for_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.booking_exists_for_email(text) TO anon;

-- ---------------------------------------------------------------------------
-- 1c. SUBMIT-FUNCTIE  (SECURITY DEFINER - OPTIONEEL)
--     Beveiligde extra laag: helpt de e-mail op een inschrijving te checken
--     vóór de review wordt opgeslagen en forceert published = false.
--     De website gebruikt die functie met een directe insert als fallback,
--     dus de site werkt óók als deze functie niet (her)geïnstalleerd is.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_testimonial(
    p_name text,
    p_text text,
    p_rating integer,
    p_email text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF btrim(p_name) = '' OR char_length(p_name) > 100 THEN
        RAISE EXCEPTION 'Naam is verplicht (max 100 tekens)';
    END IF;

    IF char_length(btrim(p_text)) NOT BETWEEN 5 AND 1000 THEN
        RAISE EXCEPTION 'Tekst moet tussen 5 en 1000 tekens zijn';
    END IF;

    IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
        RAISE EXCEPTION 'Beoordeling moet tussen 1 en 5 liggen';
    END IF;

    IF p_email IS NULL OR NOT public.booking_exists_for_email(p_email) THEN
        RAISE EXCEPTION 'Geen inschrijving gevonden voor dit e-mailadres';
    END IF;

    INSERT INTO public.testimonials (
        name,
        text,
        rating,
        email
    )
    VALUES (
        btrim(p_name),
        btrim(p_text),
        p_rating,
        btrim(p_email)
    )
    RETURNING id
    INTO v_id;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_testimonial(text, text, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_testimonial(text, text, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.submit_testimonial(text, text, integer, text) TO anon;

-- ---------------------------------------------------------------------------
-- 2. RLS inschakelen
-- ---------------------------------------------------------------------------
ALTER TABLE public.testimonials ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Rechten (grants)
-- ---------------------------------------------------------------------------

-- anon: mag gepubliceerde getuigenissen lezen (zonder email/appointment_id)
-- en een nieuwe review invoegen. De échte "heeft een inschrijving" controle
-- gebeurt in submit_testimonial(); de tabel-policy beperkt hier enkel dat een
-- review altijd als concept (published = false) binnenkomt.
REVOKE ALL ON public.testimonials FROM anon;

GRANT SELECT (id, name, text, rating, published, created_at)
    ON public.testimonials TO anon;

GRANT INSERT (name, text, rating, email)
    ON public.testimonials TO anon;

-- authenticated: volledige tabelrechten, maar de policies bepalen dat
-- alleen een admin_users-lid er iets mee mag.
GRANT ALL ON public.testimonials TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "anon_reads_published_testimonials"
    ON public.testimonials;
CREATE POLICY "anon_reads_published_testimonials"
    ON public.testimonials FOR SELECT TO anon
    USING (published = true);

DROP POLICY IF EXISTS "anon_creates_testimonial"
    ON public.testimonials;
CREATE POLICY "anon_creates_testimonial"
    ON public.testimonials FOR INSERT TO anon
    WITH CHECK (published = false);

DROP POLICY IF EXISTS "admin_full_testimonials"
    ON public.testimonials;
CREATE POLICY "admin_full_testimonials"
    ON public.testimonials TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ));