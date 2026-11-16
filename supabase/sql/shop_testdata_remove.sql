-- ============================================================================
-- WEBSHOP — TESTGEGEVENS VERWIJDEREN
-- ============================================================================
-- Wist alles wat shop_testdata.sql toevoegde. Bestellingen en facturen blijven
-- bestaan (bestellijnen bewaren de productnaam; facturen zijn onveranderlijk).
-- Kortingscodes die al in een betaalde bestelling gebruikt werden, worden
-- enkel uitgeschakeld.
-- ============================================================================

DELETE FROM public.shop_products   WHERE slug LIKE 'test-%';
DELETE FROM public.shop_categories WHERE slug LIKE 'test-%';

DELETE FROM public.shop_discount_codes WHERE code LIKE 'TEST%' AND used_count = 0;
UPDATE public.shop_discount_codes SET active = false WHERE code LIKE 'TEST%';
