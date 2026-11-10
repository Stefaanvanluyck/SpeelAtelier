-- ============================================================================
-- WEBSHOP — migratie: zichtbaarheid op de hoofdsite
-- ============================================================================
-- Enkel nodig als shop.sql al eerder gedraaid werd. (shop.sql zelf bevat
-- deze kolom ook; opnieuw draaien kan geen kwaad.)
-- UITVOEREN: Supabase Dashboard > SQL Editor > plakken > Run
-- ============================================================================

ALTER TABLE public.shop_settings
    ADD COLUMN IF NOT EXISTS show_on_site boolean NOT NULL DEFAULT false;
