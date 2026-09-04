-- ============================================================================
-- WAITLIST — jufvalerie.be / SpeelAtelier
-- ============================================================================
-- Doel: bezoekers van de website kunnen zich op een wachtlijst zetten wanneer
-- een speelsessie (thema-zaterdag) volzet is. Zodra een plaats vrijkomt, kan de
-- beheerder de inschrijving in admin.html in één klik omzetten naar een echte
-- reservatie (appointments).
--
-- Rechten:
--   * anon (iedereen op de website)  : mag ALLEEN een rij AANMAKEN (INSERT).
--   * authenticated                  : enkel leden van admin_users kunnen de
--                                       wachtlijst lezen / aanpassen /
--                                       verwijderen (zelfde aanpak als in
--                                       rls_hardening.sql voor appointments).
--
-- ============================================================================
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabel aanmaken
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.waitlist (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    appointment_date  text        NOT NULL,
    parent_name       text        NOT NULL,
    email             text        NOT NULL,
    children_count    integer     NOT NULL DEFAULT 1,
    child_names       text,
    status            text        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'booked', 'removed')),
    created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. RLS inschakelen
-- ---------------------------------------------------------------------------
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Rechten (grants)
-- ---------------------------------------------------------------------------

-- anon: alles intrekken, daarna enkel INSERT toekennen.
REVOKE ALL ON public.waitlist FROM anon;

GRANT INSERT ON public.waitlist TO anon;

-- authenticated (aangemelde gebruiker): volledige tabelrechten,
-- maar de policies bepalen dat alleen een admin_users-lid er iets mee mag.
GRANT ALL ON public.waitlist TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------

CREATE POLICY "anon_creates_waitlist"
    ON public.waitlist FOR INSERT TO anon
    WITH CHECK (true);

CREATE POLICY "admin_full_waitlist"
    ON public.waitlist TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ));