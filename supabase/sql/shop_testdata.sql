-- ============================================================================
-- WEBSHOP — TESTGEGEVENS
-- ============================================================================
-- Voegt testcategorieën, testproducten en kortingscodes toe om de webshop
-- uit te proberen. Alles is herkenbaar aan het voorvoegsel "test-" (slug)
-- of "TEST" (kortingscode) en kan in één keer gewist worden met
-- shop_testdata_remove.sql.
--
-- VEILIG VOOR EEN LIVE SHOP: de producten worden VERBORGEN toegevoegd
-- (active = false) en de kortingscodes UITGESCHAKELD. Bekijk ze in de admin;
-- wil je ze in de webshop zien, voer dan onderaan het blok "ZICHTBAAR
-- MAKEN" uit — doe dat enkel als de webshop gesloten is of in een testproject.
--
-- Vereist: shop.sql (laatste versie) is gedraaid.
-- Idempotent: meermaals draaien voegt niets dubbel toe.
-- ============================================================================

INSERT INTO public.shop_categories (name, slug, sort_order, active, icon) VALUES
    ('Gekleurde rijst',  'test-gekleurde-rijst',  10, true, '🍚'),
    ('Gekleurde pasta',  'test-gekleurde-pasta',  20, true, '🍝'),
    ('Speelsets',        'test-speelsets',        30, true, '🧺'),
    ('Accessoires',      'test-accessoires',      40, true, '🥄')
ON CONFLICT (slug) DO NOTHING;

WITH c AS (SELECT id, slug FROM public.shop_categories WHERE slug LIKE 'test-%')
INSERT INTO public.shop_products
    (name, slug, short_text, description, price, compare_at_price, badge, featured,
     weight_grams, max_per_order, active, sort_order, category_id)
VALUES
    ('Regenboogrijst – 1 kg', 'test-regenboogrijst-1kg',
     'Zes vrolijke kleuren in één zak, klaar om mee te spelen.',
     E'Zachte, droge gekleurde rijst in zes regenboogkleuren.\nGekleurd met voedingskleurstof en volledig gedroogd, zodat er niets afgeeft.\n\nInhoud: 1 kg, verpakt in een hersluitbare zak.',
     12.50, NULL, 'Bestseller', true, 1000, 10, false, 10,
     (SELECT id FROM c WHERE slug = 'test-gekleurde-rijst')),

    ('Pastelrijst – 500 g', 'test-pastelrijst-500g',
     'Zachte pastelkleuren voor een rustige speelhoek.',
     E'Roze, mint, lila en zachtgeel in één mengeling.\nIdeaal voor een rustig sensorisch moment.\n\nInhoud: 500 g.',
     7.50, 9.00, 'Promo', false, 500, 10, false, 20,
     (SELECT id FROM c WHERE slug = 'test-gekleurde-rijst')),

    ('Seizoensrijst Herfst – 1 kg', 'test-herfstrijst-1kg',
     'Warme herfsttinten: oranje, bruin, okergeel en rood.',
     E'Limited edition in herfstkleuren. Leuk om te combineren met eikels, kastanjes en blaadjes.\n\nInhoud: 1 kg.',
     13.00, NULL, 'Nieuw', true, 1000, 5, false, 30,
     (SELECT id FROM c WHERE slug = 'test-gekleurde-rijst')),

    ('Regenboogpasta – 750 g', 'test-regenboogpasta-750g',
     'Gekleurde penne en vlinders om te scheppen, rijgen en sorteren.',
     E'Mix van penne, farfalle en macaroni in felle kleuren.\nDe penne zijn ook leuk om op een touwtje te rijgen.\n\nInhoud: 750 g.',
     9.95, NULL, NULL, false, 750, 10, false, 40,
     (SELECT id FROM c WHERE slug = 'test-gekleurde-pasta')),

    ('Rijgpasta met veter', 'test-rijgpasta-veter',
     'Grote gekleurde buisjes + 2 stevige veters.',
     E'Perfect voor de fijne motoriek: rijg kettingen en armbanden.\n\nInhoud: 300 g pasta + 2 veters.',
     6.50, NULL, NULL, false, 320, 10, false, 50,
     (SELECT id FROM c WHERE slug = 'test-gekleurde-pasta')),

    ('Sensorische speelbak – compleet', 'test-speelbak-compleet',
     'Bak met deksel, 1 kg rijst, schepjes en trechter.',
     E'Alles om meteen te beginnen:\n- opbergbak met deksel (ca. 40 × 30 cm)\n- 1 kg regenboogrijst\n- 2 schepjes, een trechter en 3 bekertjes\n\nDe rijst blijft netjes in de bak en de deksel gaat er na het spelen gewoon op.',
     34.95, 39.95, 'Promo', true, 2200, 3, false, 60,
     (SELECT id FROM c WHERE slug = 'test-speelsets')),

    ('Thema-set Boerderij', 'test-themaset-boerderij',
     'Groene en bruine rijst met 6 houten boerderijdieren.',
     E'Een kant-en-klaar speelthema: groene "weide"-rijst, bruine "modder"-rijst en zes houten dieren.\n\nInhoud: 2 × 500 g rijst + 6 dieren.',
     24.50, NULL, 'Nieuw', false, 1300, 5, false, 70,
     (SELECT id FROM c WHERE slug = 'test-speelsets')),

    ('Schepjes & trechters (set van 5)', 'test-schepjes-set',
     'Handige schepjes, trechter en pincet voor kleine handjes.',
     E'Set van 5 stuks in kleurrijk kunststof: 2 schepjes, 1 trechter, 1 pincet en 1 zeefje.',
     8.00, NULL, NULL, false, 150, 10, false, 80,
     (SELECT id FROM c WHERE slug = 'test-accessoires')),

    ('Cadeaubon € 25', 'test-cadeaubon-25',
     'Een mooie bon om zelf te kiezen. Wordt per post of bij afhaling meegegeven.',
     E'Te gebruiken in de webshop of in het speelatelier.\n(Testproduct — geen echte cadeaubon.)',
     25.00, NULL, NULL, false, 20, 5, false, 90,
     (SELECT id FROM c WHERE slug = 'test-accessoires'))
ON CONFLICT (slug) DO NOTHING;

-- Kortingscodes (uitgeschakeld)
INSERT INTO public.shop_discount_codes
    (code, description, kind, value, min_order, valid_from, valid_until, max_uses, active)
VALUES
    ('TEST10',      'Test: 10% op alles',                 'percent', 10, NULL, NULL, NULL, NULL, false),
    ('TESTWELKOM5', 'Test: € 5 vanaf € 25',               'fixed',   5,  25,   NULL, NULL, 100,  false),
    ('TESTVERLOPEN','Test: verlopen code (foutmelding)',  'percent', 20, NULL, '2020-01-01', '2020-12-31', NULL, false)
ON CONFLICT (code) DO NOTHING;


-- ----------------------------------------------------------------------------
-- ZICHTBAAR MAKEN (optioneel — enkel als de shop gesloten is of in een testproject)
-- Haal de commentaartekens weg en voer enkel dit blok uit.
-- ----------------------------------------------------------------------------
-- UPDATE public.shop_products       SET active = true WHERE slug LIKE 'test-%';
-- UPDATE public.shop_discount_codes SET active = true WHERE code LIKE 'TEST%' AND code <> 'TESTVERLOPEN';
