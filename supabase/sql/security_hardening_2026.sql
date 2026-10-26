-- ============================================================================
-- SECURITY HARDENING 2026 — jufvalerie.be / SpeelAtelier
-- ============================================================================
-- Draai dit script NA alle andere scripts in supabase/sql/ (het overschrijft
-- een aantal functies/policies daaruit). Het script is idempotent.
--
-- Wat het oplost:
--   1. consume_beurtenkaart() was publiek oproepbaar via /rest/v1/rpc
--      -> iedereen kon elke beurtenkaart leegmaken.
--   2. Bezoekers konden met payment_method = 'pass' en andermans e-mail
--      boeken op diens beurtenkaart (boeking meteen 'paid').
--      -> Publieke kaart-aanvragen worden nu 'pass_requested' (pending);
--         de beheerder bevestigt ze in admin.html ("Betaal met beurtenkaart"),
--         pas dan worden beurten afgetrokken.
--   3. Geblokkeerde datums / sessies zonder thema werden alleen in de edge
--      function gecontroleerd -> nu ook in de trigger.
--   4. anon mocht ELKE kolom van appointments invullen -> kolomrechten.
--   5. Eenvoudige flood-bescherming (dubbele boekingen, globale limiet).
--   6. Race condition op capaciteit -> advisory lock per datum.
--   7. children: anon kon kinderen toevoegen aan andermans boeking.
--   8. testimonials: directe insert omzeilde de inschrijvingscontrole;
--      booking_exists_for_email lekte of een e-mailadres klant is.
--   9. Storage 'gallery': elke ingelogde gebruiker kon schrijven/verwijderen;
--      geen limiet op grootte/type.
--  10. waitlist: geen invoervalidatie.
--
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 0. Helpers: is_admin() / is_service_role()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jwt_claim(p_claim text)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claims', true), '')::json ->> p_claim,
        ''
    );
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.jwt_claim('role') = 'authenticated'
       AND EXISTS (
           SELECT 1 FROM public.admin_users
           WHERE email = LOWER(public.jwt_claim('email'))
       );
$$;

CREATE OR REPLACE FUNCTION public.is_service_role()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
    SELECT public.jwt_claim('role') = 'service_role'
        OR current_user IN ('postgres', 'supabase_admin', 'service_role');
$$;

REVOKE ALL ON FUNCTION public.jwt_claim(text)   FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_service_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_admin()        FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.jwt_claim(text)   TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_service_role() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin()        TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- 1. Beurtenkaart-functies afschermen
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_beurtenkaart(
    p_email          text,
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

    SELECT aantal_starts INTO v_aantal
    FROM public.beurtenkaarten
    WHERE LOWER(email) = LOWER(btrim(p_email))
    FOR UPDATE;

    -- Generieke melding: verraadt niet of er een kaart bestaat of hoeveel
    -- beurten er nog op staan.
    IF v_aantal IS NULL OR v_aantal < p_aantal_beurten THEN
        RAISE EXCEPTION 'Betalen met beurtenkaart is niet mogelijk voor deze inschrijving'
            USING ERRCODE = 'P0001';
    END IF;

    UPDATE public.beurtenkaarten
    SET aantal_starts = aantal_starts - p_aantal_beurten,
        updated_at    = now()
    WHERE LOWER(email) = LOWER(btrim(p_email));
END;
$$;

-- Enkel intern (vanuit de trigger) bruikbaar.
REVOKE ALL ON FUNCTION public.consume_beurtenkaart(text, integer)
    FROM PUBLIC, anon, authenticated;

-- admin_set_beurtenkaart controleert zelf op admin; anon hoeft er niet bij.
REVOKE ALL ON FUNCTION public.admin_set_beurtenkaart(text, smallint, integer)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_beurtenkaart(text, smallint, integer)
    TO authenticated;


-- ---------------------------------------------------------------------------
-- 2. payment_method: toegelaten waarden
-- ---------------------------------------------------------------------------
ALTER TABLE public.appointments
    DROP CONSTRAINT IF EXISTS appointments_payment_method_check;
ALTER TABLE public.appointments
    ADD CONSTRAINT appointments_payment_method_check
    CHECK (payment_method IS NULL
           OR payment_method IN ('onsite', 'online', 'pass', 'pass_requested'))
    NOT VALID;   -- bestaande (oude) rijen worden niet gecontroleerd


-- ---------------------------------------------------------------------------
-- 3. Trigger: beurten enkel aftrekken door beheerder / server
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_beurtenkaart_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.payment_method = 'pass' THEN

        -- Bezoeker (anon / geen admin): niet automatisch afboeken, want de
        -- eigenaar van de kaart is niet geverifieerd. Markeer als aanvraag;
        -- de beheerder bevestigt in admin.html.
        IF NOT (public.is_admin() OR public.is_service_role()) THEN
            NEW.payment_method := 'pass_requested';
            RETURN NEW;
        END IF;

        IF TG_OP = 'INSERT'
           OR COALESCE(OLD.payment_method, 'onsite') <> 'pass' THEN

            PERFORM public.consume_beurtenkaart(NEW.email, NEW.children_count);

            NEW.amount         := 0;
            NEW.payment_status := 'paid';
        END IF;

    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_beurtenkaart_payment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_apply_beurtenkaart_payment ON public.appointments;
CREATE TRIGGER trg_apply_beurtenkaart_payment
    BEFORE INSERT OR UPDATE ON public.appointments
    FOR EACH ROW
    EXECUTE FUNCTION public.apply_beurtenkaart_payment();


-- ---------------------------------------------------------------------------
-- 4. Validatie-trigger (vervangt amount_validation_trigger.sql)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_appointment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    c_max_children constant integer := 12;
    c_price_first  constant numeric := 18;
    c_price_extra  constant numeric := 15;
    c_online_fee   constant numeric := 0.40;

    v_booked   integer := 0;
    v_is_admin boolean := public.is_admin();
    v_recent   integer := 0;
BEGIN
    -- children_count 1..4
    IF NEW.children_count IS NULL
       OR NEW.children_count < 1
       OR NEW.children_count > 4 THEN
        RAISE EXCEPTION 'Ongeldig aantal kinderen (1-4)'
            USING ERRCODE = '23514';
    END IF;

    -- naam
    IF NEW.name IS NULL OR btrim(NEW.name) = '' OR char_length(NEW.name) > 100 THEN
        RAISE EXCEPTION 'Naam ontbreekt of is te lang'
            USING ERRCODE = '23514';
    END IF;

    -- e-mail
    IF NEW.email IS NULL
       OR char_length(NEW.email) > 254
       OR NEW.email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RAISE EXCEPTION 'Ongeldig e-mailadres'
            USING ERRCODE = '23514';
    END IF;
    NEW.email := LOWER(btrim(NEW.email));
    NEW.name  := btrim(NEW.name);

    IF TG_OP = 'INSERT' THEN

        IF NEW.appointment_date IS NULL THEN
            RAISE EXCEPTION 'Datum is verplicht' USING ERRCODE = '23514';
        END IF;

        IF NEW.appointment_date < CURRENT_DATE AND NOT v_is_admin THEN
            RAISE EXCEPTION 'Deze datum ligt in het verleden' USING ERRCODE = '23514';
        END IF;

        IF EXTRACT(ISODOW FROM NEW.appointment_date) <> 6 THEN
            RAISE EXCEPTION 'Alleen zaterdagen zijn toegestaan' USING ERRCODE = '23514';
        END IF;

        -- Velden die een bezoeker nooit zelf mag zetten
        IF NOT v_is_admin AND NOT public.is_service_role() THEN
            NEW.mollie_payment_id := NULL;
            NEW.created_at        := now();
        END IF;

        IF NOT v_is_admin THEN

            -- Geblokkeerde datum?
            IF EXISTS (SELECT 1 FROM public.blocked_dates
                       WHERE date::text = NEW.appointment_date::text) THEN
                RAISE EXCEPTION 'Deze datum is geblokkeerd' USING ERRCODE = '23514';
            END IF;

            -- Sessie gepland (thema)?
            IF NOT EXISTS (SELECT 1 FROM public.themes
                           WHERE date::text = NEW.appointment_date::text) THEN
                RAISE EXCEPTION 'Voor deze datum is geen sessie gepland' USING ERRCODE = '23514';
            END IF;

            -- Online betalingen kunnen enkel via de edge function.
            IF COALESCE(NEW.payment_method, 'onsite') = 'online'
               AND NOT public.is_service_role() THEN
                RAISE EXCEPTION 'Online betalen kan enkel via de betaalpagina'
                    USING ERRCODE = '42501';
            END IF;

            -- Flood-bescherming: max. 1 actieve boeking per e-mail per sessie
            IF EXISTS (
                SELECT 1 FROM public.appointments
                WHERE email = NEW.email
                  AND appointment_date = NEW.appointment_date
                  AND payment_status NOT IN ('cancelled', 'failed', 'expired')
            ) THEN
                RAISE EXCEPTION 'Er bestaat al een inschrijving met dit e-mailadres voor deze sessie'
                    USING ERRCODE = '23505';
            END IF;

            -- Globale limiet: max. 30 publieke inschrijvingen per 10 minuten
            SELECT count(*) INTO v_recent
            FROM public.appointments
            WHERE created_at > now() - interval '10 minutes';
            IF v_recent >= 30 THEN
                RAISE EXCEPTION 'Te veel inschrijvingen op korte tijd, probeer later opnieuw'
                    USING ERRCODE = '54000';
            END IF;
        END IF;

        -- Bedrag server-side (behalve bij beurtenkaart)
        IF COALESCE(NEW.payment_method, 'onsite') <> 'pass' THEN
            NEW.amount := c_price_first
                        + GREATEST(0, NEW.children_count - 1) * c_price_extra;
            IF NEW.payment_method = 'online' THEN
                NEW.amount := NEW.amount + c_online_fee;
            ELSIF NEW.payment_method = 'pass_requested' THEN
                NEW.amount := 0;
            END IF;
            NEW.payment_status := 'pending';
        END IF;

        -- Capaciteit (met lock tegen gelijktijdige boekingen)
        IF NOT v_is_admin THEN
            PERFORM pg_advisory_xact_lock(hashtext('appointments:' || NEW.appointment_date::text));

            SELECT COALESCE(SUM(children_count), 0)::integer
            INTO   v_booked
            FROM   public.appointments
            WHERE  appointment_date = NEW.appointment_date
              AND  payment_status NOT IN ('cancelled', 'failed', 'expired');

            IF v_booked + NEW.children_count > c_max_children THEN
                RAISE EXCEPTION 'Nog % plaats(en) beschikbaar voor deze sessie',
                       GREATEST(0, c_max_children - v_booked)
                    USING ERRCODE = '23514';
            END IF;
        END IF;

    END IF;

    IF TG_OP = 'UPDATE' THEN
        -- Een betaalde boeking nooit terugzetten naar open/pending, tenzij
        -- de beheerder dat bewust doet.
        IF OLD.payment_status = 'paid'
           AND NEW.payment_status IN ('pending', 'open')
           AND NOT v_is_admin THEN
            NEW.payment_status := OLD.payment_status;
        END IF;

        IF NEW.amount IS NULL
           AND COALESCE(NEW.payment_method, 'onsite') NOT IN ('pass', 'pass_requested') THEN
            NEW.amount := c_price_first
                        + GREATEST(0, NEW.children_count - 1) * c_price_extra;
            IF NEW.payment_method = 'online' THEN
                NEW.amount := NEW.amount + c_online_fee;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_appointment() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_validate_appointment ON public.appointments;
CREATE TRIGGER trg_validate_appointment
    BEFORE INSERT OR UPDATE ON public.appointments
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_appointment();

CREATE INDEX IF NOT EXISTS idx_appointments_date_status
    ON public.appointments (appointment_date, payment_status);
CREATE INDEX IF NOT EXISTS idx_appointments_email
    ON public.appointments (LOWER(email));


-- ---------------------------------------------------------------------------
-- 5. appointments: anon mag enkel deze kolommen invullen
-- ---------------------------------------------------------------------------
REVOKE INSERT ON public.appointments FROM anon;
GRANT INSERT (appointment_date, name, email, children_count,
              amount, payment_method, payment_status)
    ON public.appointments TO anon;


-- ---------------------------------------------------------------------------
-- 6. children: enkel toevoegen aan een VERSE eigen boeking
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_add_child(p_appointment_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.appointments a
        WHERE a.id = p_appointment_id
          AND a.created_at > now() - interval '15 minutes'
          AND (SELECT count(*) FROM public.children c
               WHERE c.appointment_id = a.id) < a.children_count
    );
$$;

REVOKE ALL ON FUNCTION public.can_add_child(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_add_child(uuid) TO anon;

REVOKE INSERT ON public.children FROM anon;
GRANT INSERT (appointment_id, name, photo_allowed) ON public.children TO anon;

ALTER TABLE public.children DROP CONSTRAINT IF EXISTS children_name_len;
ALTER TABLE public.children ADD CONSTRAINT children_name_len
    CHECK (char_length(btrim(name)) BETWEEN 1 AND 100) NOT VALID;

DROP POLICY IF EXISTS "anon_creates_children" ON public.children;
CREATE POLICY "anon_creates_children"
    ON public.children FOR INSERT TO anon
    WITH CHECK (public.can_add_child(appointment_id));


-- ---------------------------------------------------------------------------
-- 7. testimonials: enkel via submit_testimonial()
-- ---------------------------------------------------------------------------
REVOKE INSERT ON public.testimonials FROM anon;
DROP POLICY IF EXISTS "anon_creates_testimonial" ON public.testimonials;

REVOKE ALL ON FUNCTION public.booking_exists_for_email(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.submit_testimonial(
    p_name   text,
    p_text   text,
    p_rating integer,
    p_email  text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id uuid;
BEGIN
    IF p_name IS NULL OR btrim(p_name) = '' OR char_length(p_name) > 100 THEN
        RAISE EXCEPTION 'Naam is verplicht (max 100 tekens)';
    END IF;

    IF p_text IS NULL OR char_length(btrim(p_text)) NOT BETWEEN 5 AND 1000 THEN
        RAISE EXCEPTION 'Tekst moet tussen 5 en 1000 tekens zijn';
    END IF;

    IF p_rating IS NULL OR p_rating NOT BETWEEN 1 AND 5 THEN
        RAISE EXCEPTION 'Beoordeling moet tussen 1 en 5 liggen';
    END IF;

    -- max. 3 reviews per e-mailadres per dag
    IF (SELECT count(*) FROM public.testimonials
        WHERE LOWER(email) = LOWER(btrim(p_email))
          AND created_at > now() - interval '1 day') >= 3 THEN
        RAISE EXCEPTION 'Review kon niet worden opgeslagen';
    END IF;

    -- Generieke melding: verraadt niet of het e-mailadres klant is
    IF p_email IS NULL OR NOT public.booking_exists_for_email(p_email) THEN
        RAISE EXCEPTION 'Review kon niet worden opgeslagen';
    END IF;

    INSERT INTO public.testimonials (name, text, rating, email, published)
    VALUES (btrim(p_name), btrim(p_text), p_rating, LOWER(btrim(p_email)), false)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_testimonial(text, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_testimonial(text, text, integer, text) TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- 8. Storage 'gallery': enkel beheerders, enkel afbeeldingen, max 10 MB
-- ---------------------------------------------------------------------------
UPDATE storage.buckets
SET file_size_limit    = 10485760,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/gif']
WHERE id = 'gallery';

DROP POLICY IF EXISTS "authenticated_write_gallery_objects"  ON storage.objects;
DROP POLICY IF EXISTS "authenticated_update_gallery_objects" ON storage.objects;
DROP POLICY IF EXISTS "authenticated_delete_gallery_objects" ON storage.objects;
DROP POLICY IF EXISTS "admin_write_gallery_objects"  ON storage.objects;
DROP POLICY IF EXISTS "admin_update_gallery_objects" ON storage.objects;
DROP POLICY IF EXISTS "admin_delete_gallery_objects" ON storage.objects;

CREATE POLICY "admin_write_gallery_objects"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'gallery' AND public.is_admin());

CREATE POLICY "admin_update_gallery_objects"
    ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'gallery' AND public.is_admin())
    WITH CHECK (bucket_id = 'gallery' AND public.is_admin());

CREATE POLICY "admin_delete_gallery_objects"
    ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'gallery' AND public.is_admin());


-- ---------------------------------------------------------------------------
-- 9. waitlist: validatie + idempotente policies
-- ---------------------------------------------------------------------------
ALTER TABLE public.waitlist DROP CONSTRAINT IF EXISTS waitlist_valid;
ALTER TABLE public.waitlist ADD CONSTRAINT waitlist_valid CHECK (
        char_length(btrim(parent_name)) BETWEEN 1 AND 100
    AND char_length(email) <= 254
    AND email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
    AND children_count BETWEEN 1 AND 4
    AND (child_names IS NULL OR char_length(child_names) <= 500)
    AND appointment_date ~ '^\d{4}-\d{2}-\d{2}$'
) NOT VALID;

REVOKE INSERT ON public.waitlist FROM anon;
GRANT INSERT (appointment_date, parent_name, email, children_count, child_names)
    ON public.waitlist TO anon;

CREATE OR REPLACE FUNCTION public.waitlist_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF public.is_admin() THEN
        RETURN NEW;
    END IF;
    NEW.status     := 'pending';
    NEW.created_at := now();
    NEW.email      := LOWER(btrim(NEW.email));
    IF EXISTS (SELECT 1 FROM public.waitlist
               WHERE email = NEW.email
                 AND appointment_date = NEW.appointment_date
                 AND status = 'pending') THEN
        RAISE EXCEPTION 'Je staat al op de wachtlijst voor deze sessie'
            USING ERRCODE = '23505';
    END IF;
    IF (SELECT count(*) FROM public.waitlist
        WHERE created_at > now() - interval '10 minutes') >= 30 THEN
        RAISE EXCEPTION 'Te veel aanvragen, probeer later opnieuw'
            USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.waitlist_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_waitlist_guard ON public.waitlist;
CREATE TRIGGER trg_waitlist_guard
    BEFORE INSERT ON public.waitlist
    FOR EACH ROW EXECUTE FUNCTION public.waitlist_guard();

DROP POLICY IF EXISTS "anon_creates_waitlist" ON public.waitlist;
CREATE POLICY "anon_creates_waitlist"
    ON public.waitlist FOR INSERT TO anon
    WITH CHECK (status = 'pending');

DROP POLICY IF EXISTS "admin_full_waitlist" ON public.waitlist;
CREATE POLICY "admin_full_waitlist"
    ON public.waitlist TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());
