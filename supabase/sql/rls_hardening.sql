-- ============================================================================
-- RLS HARDENING — jufvalerie.be / SpeelAtelier
-- ============================================================================
-- Doel: anon (iedereen op de website) mag alleen het minimale:
--
--   * appointments  : anon mag een reservatie AANMAKEN (onsite-flow met
--                     Payconiq/cash) en mag alleen de "veilige" kolommen
--                     (id, appointment_date, children_count, payment_status,
--                     amount, payment_method) LEZEN. Dat is nodig voor de
--                     publieke kalender en de return-pagina na Mollie.
--                     Geen UPDATE/DELETE en NIET lezen van
--                     name / email / child1-4 / created_at ...
--
--   * themes        : anon mag alleen LEZEN (date, theme).
--   * blocked_dates : anon mag alleen LEZEN (date).
--   * admin_users   : nieuwe tabel; de beheerder(s). Alleen hun eigen rij
--                     is leesbaar door de aangemelde gebruiker.
--
-- Iedere eigen aangemaakte account (sign-up) is GEEN beheerder: volledige
-- toegang tot de tabellen vereist een rij in admin_users.
-- Edge functions (mollie-webhook, create-mollie-payment) gebruiken de
-- service_role en ondervinden hier geen hinder van.
--
-- ============================================================================
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- EERST vervangen:  'JOUW_EMAIL@voorbeeld.be'  ->  jouw admin e-mailadres
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Beheerderslijst (wordt ook door admin.html gebruikt)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_admin_email text := 'JOUW_EMAIL@voorbeeld.be';
BEGIN
    CREATE TABLE IF NOT EXISTS public.admin_users (
        email text PRIMARY KEY
    );
    INSERT INTO public.admin_users (email)
    VALUES (LOWER(v_admin_email))
    ON CONFLICT (email) DO NOTHING;
END $$;

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 1. RLS inschakelen
-- ---------------------------------------------------------------------------
ALTER TABLE public.appointments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.themes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_dates ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Alle bestaande policies verwijderen (schoon beginnen)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('appointments', 'themes', 'blocked_dates', 'admin_users')
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Rechten (grants)
-- ---------------------------------------------------------------------------

-- anon: alles intrekken, daarna enkel het minimale toekennen.
REVOKE ALL ON public.appointments  FROM anon;
REVOKE ALL ON public.themes        FROM anon;
REVOKE ALL ON public.blocked_dates FROM anon;
REVOKE ALL ON public.admin_users   FROM anon;

-- anon: alleen deze kolommen lezen (PII-kolommen blijven geblokkeerd)
GRANT SELECT (id, appointment_date, children_count, payment_status, amount, payment_method)
    ON public.appointments TO anon;
GRANT INSERT ON public.appointments TO anon;

GRANT SELECT (date, theme) ON public.themes TO anon;
GRANT SELECT (date)        ON public.blocked_dates TO anon;

-- authenticated (aangemelde gebruiker): volledige tabelrechten,
-- maar de policies bepalen dat alleen een admin_users-lid er iets mee mag.
GRANT ALL ON public.appointments  TO authenticated;
GRANT ALL ON public.themes        TO authenticated;
GRANT ALL ON public.blocked_dates TO authenticated;
GRANT SELECT ON public.admin_users TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------

-- appointments ---------------------------------------------------------------
CREATE POLICY "anon_creates_appointments"
    ON public.appointments FOR INSERT TO anon
    WITH CHECK (true);

CREATE POLICY "anon_reads_safe_fields"
    ON public.appointments FOR SELECT TO anon
    USING (true);

CREATE POLICY "admin_full_appointments"
    ON public.appointments TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ));

-- themes ---------------------------------------------------------------------
CREATE POLICY "anon_reads_themes"
    ON public.themes FOR SELECT TO anon
    USING (true);

CREATE POLICY "admin_full_themes"
    ON public.themes TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ));

-- blocked_dates --------------------------------------------------------------
CREATE POLICY "anon_reads_blocked_dates"
    ON public.blocked_dates FOR SELECT TO anon
    USING (true);

CREATE POLICY "admin_full_blocked_dates"
    ON public.blocked_dates TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ));

-- admin_users: alleen de betrokken admin ziet zijn eigen rij -----------------
CREATE POLICY "admin_reads_own_row"
    ON public.admin_users FOR SELECT TO authenticated
    USING (email = LOWER(auth.jwt() ->> 'email'));