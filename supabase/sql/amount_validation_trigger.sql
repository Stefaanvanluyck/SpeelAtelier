-- ============================================================================
-- OPTIE 2 — DATABASE TRIGGER: BEDRAG & INVOERVALIDATIE
-- ============================================================================
--
-- Doel:
--   1. Het bedrag wordt ALTIJD server-side herberekend op basis van
--      children_count. Een bezoeker kan dus nooit een eigen (lager) bedrag
--      invoeren via de Supabase API.
--   2. children_count wordt beperkt tot 1..4 per inschrijving.
--   3. Een nieuwe inschrijving krijgt altijd payment_status = 'pending',
--      zodat een bezoeker zichzelf nooit als 'paid' kan markeren.
--   4. Datumcontroles: niet in het verleden + enkel zaterdagen.
--   5. E-mailformaat wordt gecontroleerd.
--   6. Capaciteit van maximaal 10 kinderen per sessie wordt bewaakt.
--
-- UITVOEREN IN:  Supabase Dashboard  →  SQL Editor  →  Run
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 2. Validatiefunctie aanmaken (idempotent).
--    SECURITY DEFINER = draait als tabel-eigenaar, zodat de capaciteitscheck
--    ALLE rijen ziet, ook als RLS het anonieme lezen beperkt.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_appointment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_booked integer := 0;
BEGIN

    -- 2.1  children_count geldig (1..4)
    IF NEW.children_count IS NULL
       OR NEW.children_count < 1
       OR NEW.children_count > 4 THEN
        RAISE EXCEPTION 'children_count moet tussen 1 en 4 liggen (gekregen: %)',
               NEW.children_count
            USING ERRCODE = '23514';
    END IF;

    -- 2.2  E-mailformaat (basiscontrole)
    IF NEW.email IS NULL
       OR NEW.email !~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' THEN
        RAISE EXCEPTION 'Ongeldig e-mailadres: %', NEW.email
            USING ERRCODE = '23514';
    END IF;

    -- ----------------------------------------------------------------------
    -- Alleen bij een NIEUWE inschrijving
    -- ----------------------------------------------------------------------
    IF TG_OP = 'INSERT' THEN

        -- 2.3  Datum mag niet in het verleden liggen
        IF NEW.appointment_date IS NULL
           OR NEW.appointment_date < CURRENT_DATE THEN
            RAISE EXCEPTION 'appointment_date mag niet in het verleden liggen'
                USING ERRCODE = '23514';
        END IF;

        -- 2.4  Alleen zaterdagen
        IF EXTRACT(ISODOW FROM NEW.appointment_date) <> 6 THEN
            RAISE EXCEPTION 'appointment_date moet een zaterdag zijn (gekregen: %)',
                   NEW.appointment_date
                USING ERRCODE = '23514';
        END IF;

        -- 2.5  Bedrag server-side herberekenen (clientwaarde wordt genegeerd)
        --      Prijzen: 1e kind €18, elk extra kind €15.
        NEW.amount := 18 + GREATEST(0, NEW.children_count - 1) * 15;

        -- 2.6  Transactiekost van €0,40 bij online betaling
        IF COALESCE(NEW.payment_method, 'onsite') = 'online' THEN
            NEW.amount := NEW.amount + 0.40;
        END IF;

        -- 2.7  Nieuwe inschrijvingen beginnen altijd als 'pending'
        NEW.payment_status := 'pending';

        -- 2.8  Capaciteit: maximaal 10 kinderen per sessie
        SELECT COALESCE(SUM(children_count), 0)::integer
        INTO   v_booked
        FROM   public.appointments
        WHERE  appointment_date = NEW.appointment_date
          AND  payment_status NOT IN ('cancelled', 'failed', 'expired');

        IF v_booked + NEW.children_count > 10 THEN
            RAISE EXCEPTION 'Maximaal 10 kinderen per sessie (nog % plaats(en) vrij)',
                   GREATEST(0, 10 - v_booked)
                USING ERRCODE = '23514';
        END IF;

    END IF;

    -- ----------------------------------------------------------------------
    -- Bij UPDATE: bedrag herberekenen, TENZIJ de beheerder bewust een
    -- afwijkend bedrag heeft ingevoerd (bv. korting).
    -- ----------------------------------------------------------------------
    IF TG_OP = 'UPDATE' AND NEW.amount IS NULL THEN
        NEW.amount := 18 + GREATEST(0, NEW.children_count - 1) * 15;
        IF COALESCE(NEW.payment_method, 'onsite') = 'online' THEN
            NEW.amount := NEW.amount + 0.40;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;


-- ----------------------------------------------------------------------------
-- 3. Trigger monteren (idempotent)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_validate_appointment ON public.appointments;

CREATE TRIGGER trg_validate_appointment
    BEFORE INSERT OR UPDATE ON public.appointments
    FOR EACH ROW
    EXECUTE FUNCTION public.validate_appointment();