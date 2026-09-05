-- ============================================================================
-- GALERIJ — afbeeldingen uploaden in admin.html en tonen op de website
-- ============================================================================
-- Doel: foto's via een publieke Supabase Storage-bucket ('gallery') uploaden
-- vanuit admin.html. Elke foto krijgt een rij in de tabel public.gallery.
-- De website (index.html) toont enkel rijen met published = true.
--
-- Rechten:
--   * anon (iedereen op de website) : SELECT van gepubliceerde galerij-rijen
--       (bekijkt de foto's zelf via de publieke Storage-URL).
--   * authenticated                 : enkel leden van admin_users mogen de
--       tabel en de Storage-objecten beheren (zelfde aanpak als
--       rls_hardening.sql / testimonials.sql).
--
-- Script is idempotent: je kan het meerdere keren draaien.
--
-- ============================================================================
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabel
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.gallery (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    storage_path  text    NOT NULL,          -- pad binnen de bucket 'gallery'
    alt           text    NOT NULL DEFAULT '',
    caption       text    NOT NULL DEFAULT '',
    published     boolean NOT NULL DEFAULT true,
    sort_order    integer NOT NULL DEFAULT 0,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gallery_published
    ON public.gallery (published, sort_order);

-- ---------------------------------------------------------------------------
-- 2. RLS inschakelen
-- ---------------------------------------------------------------------------
ALTER TABLE public.gallery ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Rechten (grants)
-- ---------------------------------------------------------------------------

-- anon: mag gepubliceerde foto's lezen (zonder caption editorial die niet
-- gepubliceerd zou zijn); enkel de tonen-op-website-behoeften.
REVOKE ALL ON public.gallery FROM anon;

GRANT SELECT (id, storage_path, alt, sort_order, created_at)
    ON public.gallery TO anon;

-- authenticated: volledige tabelrechten, maar de policy bepaalt dat
-- alleen een admin_users-lid er iets mee mag.
GRANT ALL ON public.gallery TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Policies
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "anon_reads_published_gallery"
    ON public.gallery;
CREATE POLICY "anon_reads_published_gallery"
    ON public.gallery FOR SELECT TO anon
    USING (published = true);

DROP POLICY IF EXISTS "admin_full_gallery"
    ON public.gallery;
CREATE POLICY "admin_full_gallery"
    ON public.gallery TO authenticated
    USING (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM public.admin_users
        WHERE email = LOWER(auth.jwt() ->> 'email')
    ));

-- ---------------------------------------------------------------------------
-- 5. Publieke Storage-bucket 'gallery'
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('gallery', 'gallery', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ---------------------------------------------------------------------------
-- 6. Storage-policies: lezen mag iedereen (publieke bucket); schrijven/
--    verwijderen enkel ingelogde gebruikers (admin.html is alleen bereikbaar
--    voor admin_users, en nieuwe accounts zijn uitgezet).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "public_read_gallery_objects"
    ON storage.objects;
CREATE POLICY "public_read_gallery_objects"
    ON storage.objects FOR SELECT USING (bucket_id = 'gallery');

DROP POLICY IF EXISTS "authenticated_write_gallery_objects"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'gallery');

DROP POLICY IF EXISTS "authenticated_update_gallery_objects"
    ON storage.objects FOR UPDATE TO authenticated
    USING (bucket_id = 'gallery');

DROP POLICY IF EXISTS "authenticated_delete_gallery_objects"
    ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'gallery');