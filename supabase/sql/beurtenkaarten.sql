-- ============================================================================
-- BEURTENKAARTEN — jufvalerie.be / SpeelAtelier
-- ============================================================================
-- Doel: 5- en 10-beurtenkaarten bijhouden, gekoppeld aan het e-mailadres van
-- het gezin. Wanneer een beheerder in het adminpaneel een inschrijving
-- "betaalt met beurtenkaart" (payment_method = 'pass'), wordt er automatisch
-- 1 beurt per kind afgetrokken van de kaart.
--
-- Rechten:
--   * anon (iedereen op de website) : GEEN rechten. Beurtenkaarten zijn privé.
--   * authenticated                : enkel leden van admin_users kunnen kaarten
--                                      lezen / aanpassen (zelfde aanpak als in
--                                      rls_hardening.sql / children.sql).
--
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabel aanmaken
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.beurtenkaarten (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text        NOT NULL,
    type          smallint    NOT NULL CHECK (type IN (5, 10)),
    aantal_starts integer     NOT NULL CHECK (aantal_starts >= 0),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

-- index om snel per e-mailadres de kaart te vinden.
-- ÉÉN kaart per gezin: uniek op het (lowercased) e-mailadres.
CREATE UNIQUE INDEX IF NOT EXISTS idx_beurtenkaarten_email
    ON public.beurtenkaarten (LOWER(email));

-- ---------------------------------------------------------------------------
-- 2. RLS inschakelen
-- ---------------------------------------------------------------------------
ALTER TABLE public.beurtenkaarten ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Rechten (grants)
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.beurtenkaarten FROM anon;

GRANT ALL ON public.beurtenkaarten TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------

-- alleen admin_users mogen beurtenkaarten beheren
DROP POLICY IF EXISTS "admin_full_beurtenkaarten" ON public.beurtenkaarten;
CREATE POLICY "admin_full_beurtenkaarten"
    ON public.beurtenkaarten TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ));

-- ---------------------------------------------------------------------------
-- 5. Helperfunctie: beurten aftrekken bij een beurtenkaart-betaling
-- ---------------------------------------------------------------------------
-- Wordt aangeroepen vanuit de trigger op appointments. De trigger werkt als
-- tabel-eigenaar (SECURITY DEFINER), zodat hij ook rijen in beurtenkaarten
-- kan wijzigen die de anonieme/gebruiker anders niet zou mogen zien.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_beurtenkaart(
    p_email        text,
    p_aantal_beurten integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_aantal integer;
BEGIN
    IF p_aantal_beurten <= 0 THEN
        RETURN;
    END IF;

    -- kaart opvragen (en vergrendelen voor gelijktijdige inserts)
    SELECT aantal_starts INTO v_aantal
    FROM public.beurtenkaarten
    WHERE LOWER(email) = LOWER(p_email)
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE;

    IF v_aantal IS NULL THEN
        RAISE EXCEPTION 'Geen beurtenkaart gevonden voor e-mail %', p_email
            USING ERRCODE = 'P0001';
    END IF;

    IF v_aantal < p_aantal_beurten THEN
        RAISE EXCEPTION 'Onvoldoende beurten op de kaart (resterend %, nodig %)',
               v_aantal, p_aantal_beurten
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.beurtenkaarten
    SET aantal_starts = aantal_starts - p_aantal_beurten,
        updated_at    = now()
    WHERE LOWER(email) = LOWER(p_email);

END;
$$;

-- ---------------------------------------------------------------------------
-- 6. RPC-functies voor het adminpaneel
-- ---------------------------------------------------------------------------
-- 6.1 Kaart aanmaken of (indien al bestaand op dit e-mailadres) beurten
--     bijtekenen / aanpassen. Enkel voor admin_users (SECURITY DEFINER +
--     handheld check op auth.jwt email).
CREATE OR REPLACE FUNCTION public.admin_set_beurtenkaart(
    p_email         text,
    p_type          smallint,
    p_aantal_starts integer
)
RETURNS public.beurtenkaarten
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.beurtenkaarten;
BEGIN
    -- Enkel beheerders mogen deze functie oproepen
    IF NOT EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(
            COALESCE(current_setting('request.jwt.claims', true)::json ->> 'email', '')
        )
    ) THEN
        RAISE EXCEPTION 'Niet toegelaten: enkel beheerders'
            USING ERRCODE = '42501';
    END IF;

    IF p_type NOT IN (5, 10) THEN
        RAISE EXCEPTION 'type moet 5 of 10 zijn'
            USING ERRCODE = '23514';
    END IF;

    IF p_aantal_starts < 0 THEN
        RAISE EXCEPTION 'aantal_starts mag niet negatief zijn'
            USING ERRCODE = '23514';
    END IF;

    -- bestaande kaart? dan overschrijven (één kaart per gezin)
    UPDATE public.beurtenkaarten
    SET type          = p_type,
        aantal_starts = p_aantal_starts,
        updated_at    = now()
    WHERE LOWER(email) = LOWER(p_email)
    RETURNING * INTO v_row;

    IF v_row.id IS NOT NULL THEN
        RETURN v_row;
    END IF;

    -- anders een nieuwe kaart aanmaken
    INSERT INTO public.beurtenkaarten (email, type, aantal_starts)
    VALUES (LOWER(p_email), p_type, p_aantal_starts)
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

-- 6.2 Rechten toekennen zodat de beheerderbezoek via rpc (authenticated)
--     de functies kan oproepen.
GRANT EXECUTE ON FUNCTION
    public.admin_set_beurtenkaart(text, smallint, integer)
    TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. Trigger: automatisch beurten aftrekken bij payment_method = 'pass'
-- ---------------------------------------------------------------------------
-- 8.1 Validatiefunctie (past de rijen aan vóór INSERT/UPDATE)
CREATE OR REPLACE FUNCTION public.apply_beurtenkaart_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Alleen relevant bij een beurtenkaart-betaling.
    -- Bij INSERT: eerste aanmaak van de boeking.
    -- Bij UPDATE: enkel eenmalig wanneer de betaalwijze nu pas naar 'pass'
    --   omgezet wordt (bv. ter plaatse -> beurtenkaart). Zo worden er geen
    --   extra beurten afgetrokken bij latere wijzigingen aan de boeking.
    IF NEW.payment_method = 'pass'
       AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND COALESCE(OLD.payment_method, 'onsite') <> 'pass')) THEN

        -- Beurten aftrekken (1 per kind)
        PERFORM public.consume_beurtenkaart(
            NEW.email,
            NEW.children_count
        );

        -- Kaartbetaling is meteen betaald en kost niets extra
        NEW.amount         := 0;
        NEW.payment_status := 'paid';

    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_beurtenkaart_payment ON public.appointments;

CREATE TRIGGER trg_apply_beurtenkaart_payment
    BEFORE INSERT OR UPDATE ON public.appointments
    FOR EACH ROW
    EXECUTE FUNCTION public.apply_beurtenkaart_payment();
