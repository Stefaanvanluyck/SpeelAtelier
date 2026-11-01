-- ============================================================================
-- SPECIALE SESSIES (bv. Kerstspecial)
-- ============================================================================
-- Per datum in `themes` kunnen afwijkende instellingen gelden. Laat een kolom
-- leeg (NULL) om de standaardwaarde te gebruiken:
--   price_per_child  NULL = standaard (€18 eerste kind, €15 extra kind)
--   allow_pass       standaard true (beurtenkaart toegestaan)
--   max_children     NULL = 12
--   start_time       NULL = 10:00
--   end_time         NULL = 11:00
--   visual_theme     NULL = normaal, 'kerst' = kerstlook op de website
--   announcement     tekst voor de aankondiging op de homepage (optioneel)
--
-- Vereist: security_hardening_2026.sql werd eerder uitgevoerd.
-- UITVOEREN IN: Supabase Dashboard → SQL Editor → Run   (idempotent)
-- ============================================================================

-- 1. Kolommen ---------------------------------------------------------------
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS price_per_child numeric(6,2);
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS allow_pass      boolean NOT NULL DEFAULT true;
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS max_children    integer;
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS start_time      time;
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS end_time        time;
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS visual_theme    text;
ALTER TABLE public.themes ADD COLUMN IF NOT EXISTS announcement    text;

ALTER TABLE public.themes DROP CONSTRAINT IF EXISTS themes_price_check;
ALTER TABLE public.themes ADD CONSTRAINT themes_price_check
    CHECK (price_per_child IS NULL OR (price_per_child >= 0 AND price_per_child <= 500));
ALTER TABLE public.themes DROP CONSTRAINT IF EXISTS themes_max_children_check;
ALTER TABLE public.themes ADD CONSTRAINT themes_max_children_check
    CHECK (max_children IS NULL OR (max_children BETWEEN 1 AND 100));
ALTER TABLE public.themes DROP CONSTRAINT IF EXISTS themes_visual_theme_check;
ALTER TABLE public.themes ADD CONSTRAINT themes_visual_theme_check
    CHECK (visual_theme IS NULL OR visual_theme IN ('kerst'));
ALTER TABLE public.themes DROP CONSTRAINT IF EXISTS themes_announcement_len;
ALTER TABLE public.themes ADD CONSTRAINT themes_announcement_len
    CHECK (announcement IS NULL OR char_length(announcement) <= 600);

-- Bezoekers mogen deze kolommen lezen
GRANT SELECT (date, theme, price_per_child, allow_pass, max_children,
              start_time, end_time, visual_theme, announcement)
    ON public.themes TO anon;


-- 2. Validatie-trigger (vervangt versie uit security_hardening_2026.sql) -----
CREATE OR REPLACE FUNCTION public.validate_appointment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    c_default_max  constant integer := 12;
    c_price_first  constant numeric := 18;
    c_price_extra  constant numeric := 15;
    c_online_fee   constant numeric := 0.40;

    v_max_children integer := c_default_max;
    v_price_child  numeric := NULL;
    v_allow_pass   boolean := true;
    v_session      record;

    v_booked   integer := 0;
    v_is_admin boolean := public.is_admin();
    v_recent   integer := 0;
BEGIN
    IF NEW.children_count IS NULL
       OR NEW.children_count < 1
       OR NEW.children_count > 4 THEN
        RAISE EXCEPTION 'Ongeldig aantal kinderen (1-4)'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.name IS NULL OR btrim(NEW.name) = '' OR char_length(NEW.name) > 100 THEN
        RAISE EXCEPTION 'Naam ontbreekt of is te lang'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.email IS NULL
       OR char_length(NEW.email) > 254
       OR NEW.email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RAISE EXCEPTION 'Ongeldig e-mailadres'
            USING ERRCODE = '23514';
    END IF;
    NEW.email := LOWER(btrim(NEW.email));
    NEW.name  := btrim(NEW.name);

    -- Sessie-instellingen ophalen
    SELECT price_per_child, allow_pass, max_children
    INTO   v_session
    FROM   public.themes
    WHERE  date::text = NEW.appointment_date::text
    LIMIT  1;

    IF FOUND THEN
        v_price_child  := v_session.price_per_child;
        v_allow_pass   := COALESCE(v_session.allow_pass, true);
        v_max_children := COALESCE(v_session.max_children, c_default_max);
    END IF;

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

        IF NOT v_is_admin AND NOT public.is_service_role() THEN
            NEW.mollie_payment_id := NULL;
            NEW.created_at        := now();
        END IF;

        IF NOT v_is_admin THEN

            IF EXISTS (SELECT 1 FROM public.blocked_dates
                       WHERE date::text = NEW.appointment_date::text) THEN
                RAISE EXCEPTION 'Deze datum is geblokkeerd' USING ERRCODE = '23514';
            END IF;

            IF v_session IS NULL THEN
                RAISE EXCEPTION 'Voor deze datum is geen sessie gepland' USING ERRCODE = '23514';
            END IF;

            -- Beurtenkaart niet geldig voor deze (speciale) sessie
            IF NOT v_allow_pass
               AND COALESCE(NEW.payment_method, 'onsite') IN ('pass', 'pass_requested') THEN
                RAISE EXCEPTION 'Beurtenkaarten zijn niet geldig voor deze speciale sessie'
                    USING ERRCODE = '23514';
            END IF;

            IF COALESCE(NEW.payment_method, 'onsite') = 'online'
               AND NOT public.is_service_role() THEN
                RAISE EXCEPTION 'Online betalen kan enkel via de betaalpagina'
                    USING ERRCODE = '42501';
            END IF;

            IF EXISTS (
                SELECT 1 FROM public.appointments
                WHERE email = NEW.email
                  AND appointment_date = NEW.appointment_date
                  AND payment_status NOT IN ('cancelled', 'failed', 'expired')
            ) THEN
                RAISE EXCEPTION 'Er bestaat al een inschrijving met dit e-mailadres voor deze sessie'
                    USING ERRCODE = '23505';
            END IF;

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
            IF v_price_child IS NOT NULL THEN
                NEW.amount := v_price_child * NEW.children_count;
            ELSE
                NEW.amount := c_price_first
                            + GREATEST(0, NEW.children_count - 1) * c_price_extra;
            END IF;
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

            IF v_booked + NEW.children_count > v_max_children THEN
                RAISE EXCEPTION 'Nog % plaats(en) beschikbaar voor deze sessie',
                       GREATEST(0, v_max_children - v_booked)
                    USING ERRCODE = '23514';
            END IF;
        END IF;

    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.payment_status = 'paid'
           AND NEW.payment_status IN ('pending', 'open')
           AND NOT v_is_admin THEN
            NEW.payment_status := OLD.payment_status;
        END IF;

        IF NEW.amount IS NULL
           AND COALESCE(NEW.payment_method, 'onsite') NOT IN ('pass', 'pass_requested') THEN
            IF v_price_child IS NOT NULL THEN
                NEW.amount := v_price_child * NEW.children_count;
            ELSE
                NEW.amount := c_price_first
                            + GREATEST(0, NEW.children_count - 1) * c_price_extra;
            END IF;
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


-- 3. Kerstspecial 12 december 2026 ----------------------------------------
-- (zonder ON CONFLICT, zodat dit ook werkt als `date` geen unieke sleutel heeft)
UPDATE public.themes
SET price_per_child = 25,
    allow_pass      = false,
    max_children    = 15,
    start_time      = '10:00',
    end_time        = '11:30',
    visual_theme    = 'kerst',
    announcement    = COALESCE(announcement,
        'Een magisch kerstavontuur voor kleine ontdekkers! Een extra lange kerstsessie vol gezelligheid.')
WHERE date::text = '2026-12-12';

INSERT INTO public.themes (date, theme, price_per_child, allow_pass, max_children,
                           start_time, end_time, visual_theme, announcement)
SELECT '2026-12-12', 'Kerstspecial', 25, false, 15, '10:00', '11:30', 'kerst',
       'Een magisch kerstavontuur voor kleine ontdekkers! Een extra lange kerstsessie vol gezelligheid.'
WHERE NOT EXISTS (SELECT 1 FROM public.themes WHERE date::text = '2026-12-12');

-- Controle: dit moet 1 rij tonen
SELECT date, theme, price_per_child, allow_pass, max_children,
       start_time, end_time, visual_theme
FROM public.themes WHERE date::text = '2026-12-12';
