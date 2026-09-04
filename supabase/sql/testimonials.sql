-- ============================================================================
-- GETUIGENISSEN (testimonials) — jufvalerie.be / SpeelAtelier
-- ============================================================================
-- Doel: reacties van gezinnen beheren in admin.html en gepubliceerde
-- getuigenissen tonen op de homepage van de website.
--
-- Rechten:
--   * anon (iedereen op de website) : mag ENKEL gepubliceerde rijden LEZEN.
--   * authenticated                 : enkel leden van admin_users kunnen de
--                                       getuigenissen lezen / aanpassen /
--                                       verwijderen (zelfde aanpak als in
--                                       rls_hardening.sql voor appointments).
--
-- ============================================================================
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabel aanmaken
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.testimonials (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text    NOT NULL,
    text       text    NOT NULL,
    rating     integer NOT NULL DEFAULT 5
                       CHECK (rating BETWEEN 1 AND 5),
    published  boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 2. RLS inschakelen
-- ---------------------------------------------------------------------------
ALTER TABLE public.testimonials ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Rechten (grants)
-- ---------------------------------------------------------------------------

-- anon: alleen lezen van gepubliceerde getuigenissen.
REVOKE ALL ON public.testimonials FROM anon;

GRANT SELECT ON public.testimonials TO anon;

-- authenticated: volledige tabelrechten, maar de policies bepalen dat
-- alleen een admin_users-lid er iets mee mag.
GRANT ALL ON public.testimonials TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------

CREATE POLICY "anon_reads_published_testimonials"
    ON public.testimonials FOR SELECT TO anon
    USING (published = true);

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