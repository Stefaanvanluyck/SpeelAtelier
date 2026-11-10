-- ============================================================================
-- WEBSHOP — jufvalerie.be/shop/
-- ============================================================================
-- Volledig gescheiden van de inschrijvingen: alle tabellen hebben het
-- voorvoegsel shop_ en er wordt NIETS gewijzigd aan appointments, children,
-- themes, ... Het script is idempotent (meermaals draaien mag).
--
-- Vereist: security_hardening_2026.sql is al gedraaid (is_admin()).
--
-- Inhoud:
--   1. Tabellen: instellingen, producten, bestellingen, bestellijnen,
--      facturen, creditnota's, nummering
--   2. Nummering zonder gaten (W2026-0001 / WC2026-0001 / B2026-0001)
--   3. Facturen en creditnota's zijn onveranderlijk (trigger)
--   4. Functies voor de Edge Functions (enkel service role)
--   5. Publieke statusopvraging voor de bedankpagina
--   6. RLS
--   7. Storage: shop-products (publiek) en shop-documents (privé)
--
-- UITVOEREN:  Supabase Dashboard > SQL Editor > hele bestand plakken > Run
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Tabellen
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shop_settings (
    id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    shop_open           boolean  NOT NULL DEFAULT false,
    pickup_enabled      boolean  NOT NULL DEFAULT true,
    shipping_enabled    boolean  NOT NULL DEFAULT false,
    shipping_cost       numeric(10,2) NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
    free_shipping_from  numeric(10,2) CHECK (free_shipping_from IS NULL OR free_shipping_from >= 0),
    pickup_info         text NOT NULL DEFAULT 'Afhalen in het atelier na afspraak. We laten je weten wanneer je bestelling klaarstaat.',
    lead_time_text      text NOT NULL DEFAULT 'Alles wordt op bestelling gemaakt. Reken op ongeveer 5 à 7 werkdagen.',
    announcement        text,

    -- Verkopergegevens (komen op de factuur)
    business_name       text NOT NULL DEFAULT 'Kleine Wonderwereld',
    business_address    text NOT NULL DEFAULT '',
    enterprise_number   text NOT NULL DEFAULT '',
    iban                text NOT NULL DEFAULT '',
    business_email      text NOT NULL DEFAULT '',
    business_phone      text NOT NULL DEFAULT '',
    vat_exempt_text     text NOT NULL DEFAULT 'Bijzondere vrijstellingsregeling kleine ondernemingen – btw niet van toepassing.',
    invoice_footer      text NOT NULL DEFAULT 'Bedankt voor je bestelling!',
    vat_threshold       numeric(10,2) NOT NULL DEFAULT 25000,

    updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.shop_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Webshop-link op de hoofdsite tonen? (standaard verborgen)
ALTER TABLE public.shop_settings
    ADD COLUMN IF NOT EXISTS show_on_site boolean NOT NULL DEFAULT false;

-- Bedrijfsgegevens voorinvullen (zoals in privacy.html), enkel als ze nog leeg zijn.
UPDATE public.shop_settings
SET business_address  = CASE WHEN business_address  = '' THEN E'Braakstraat 7\n2960 Sint-Job' ELSE business_address END,
    enterprise_number = CASE WHEN enterprise_number = '' THEN 'BE 1040.367.659' ELSE enterprise_number END,
    business_email    = CASE WHEN business_email    = '' THEN 'kleinewonderwereld2920@gmail.com' ELSE business_email END,
    business_phone    = CASE WHEN business_phone    = '' THEN '+32 471 39 06 82' ELSE business_phone END
WHERE id = 1;


CREATE TABLE IF NOT EXISTS public.shop_products (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
    short_text      text CHECK (short_text IS NULL OR char_length(short_text) <= 300),
    description     text CHECK (description IS NULL OR char_length(description) <= 5000),
    safety_note     text CHECK (safety_note IS NULL OR char_length(safety_note) <= 500),
    price           numeric(10,2) NOT NULL CHECK (price >= 0 AND price <= 10000),
    image_path      text,
    extra_images    text[] NOT NULL DEFAULT '{}',
    weight_grams    integer CHECK (weight_grams IS NULL OR weight_grams >= 0),
    max_per_order   integer NOT NULL DEFAULT 10 CHECK (max_per_order BETWEEN 1 AND 99),
    active          boolean NOT NULL DEFAULT false,
    sort_order      integer NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_products_active
    ON public.shop_products (active, sort_order);


CREATE TABLE IF NOT EXISTS public.shop_orders (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number        text UNIQUE,
    public_token        uuid NOT NULL DEFAULT gen_random_uuid(),

    customer_name       text NOT NULL CHECK (char_length(btrim(customer_name)) BETWEEN 1 AND 100),
    email               text NOT NULL CHECK (char_length(email) <= 254
                            AND email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
    phone               text CHECK (phone IS NULL OR char_length(phone) <= 30),
    company_name        text CHECK (company_name IS NULL OR char_length(company_name) <= 120),
    company_vat         text CHECK (company_vat IS NULL OR char_length(company_vat) <= 30),

    delivery_method     text NOT NULL CHECK (delivery_method IN ('pickup', 'shipping')),
    street              text CHECK (street IS NULL OR char_length(street) <= 150),
    postal_code         text CHECK (postal_code IS NULL OR char_length(postal_code) <= 12),
    city                text CHECK (city IS NULL OR char_length(city) <= 80),
    country             text NOT NULL DEFAULT 'BE' CHECK (country IN ('BE', 'NL')),
    customer_note       text CHECK (customer_note IS NULL OR char_length(customer_note) <= 1000),
    admin_note          text CHECK (admin_note IS NULL OR char_length(admin_note) <= 2000),

    subtotal            numeric(10,2) NOT NULL CHECK (subtotal >= 0),
    shipping_cost       numeric(10,2) NOT NULL DEFAULT 0 CHECK (shipping_cost >= 0),
    total               numeric(10,2) NOT NULL CHECK (total >= 0),

    payment_status      text NOT NULL DEFAULT 'pending'
                        CHECK (payment_status IN ('pending', 'paid', 'cancelled', 'expired',
                                                  'failed', 'refunded', 'partially_refunded')),
    order_status        text NOT NULL DEFAULT 'new'
                        CHECK (order_status IN ('new', 'in_production', 'ready_for_pickup',
                                                'shipped', 'completed', 'cancelled')),
    tracking_code       text CHECK (tracking_code IS NULL OR char_length(tracking_code) <= 100),

    mollie_payment_id   text UNIQUE,
    paid_at             timestamptz,
    terms_accepted_at   timestamptz NOT NULL,
    invoice_error       text,

    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT shop_orders_address_required CHECK (
        delivery_method = 'pickup'
        OR (street IS NOT NULL AND postal_code IS NOT NULL AND city IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_shop_orders_created  ON public.shop_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_orders_status   ON public.shop_orders (payment_status, order_status);
CREATE INDEX IF NOT EXISTS idx_shop_orders_email    ON public.shop_orders (LOWER(email));


CREATE TABLE IF NOT EXISTS public.shop_order_items (
    id              bigserial PRIMARY KEY,
    order_id        uuid NOT NULL REFERENCES public.shop_orders (id) ON DELETE CASCADE,
    product_id      uuid REFERENCES public.shop_products (id) ON DELETE SET NULL,
    product_name    text NOT NULL,
    unit_price      numeric(10,2) NOT NULL CHECK (unit_price >= 0),
    quantity        integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
    line_total      numeric(10,2) NOT NULL CHECK (line_total >= 0)
);

CREATE INDEX IF NOT EXISTS idx_shop_order_items_order ON public.shop_order_items (order_id);


CREATE TABLE IF NOT EXISTS public.shop_number_sequences (
    kind        text    NOT NULL,
    year        integer NOT NULL,
    last_value  integer NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, year)
);


CREATE TABLE IF NOT EXISTS public.shop_invoices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number  text NOT NULL UNIQUE,
    invoice_date    date NOT NULL DEFAULT CURRENT_DATE,
    order_id        uuid NOT NULL UNIQUE REFERENCES public.shop_orders (id) ON DELETE RESTRICT,
    seller          jsonb NOT NULL,     -- momentopname verkopergegevens
    customer        jsonb NOT NULL,     -- momentopname klantgegevens
    lines           jsonb NOT NULL,     -- [{description, quantity, unit_price, line_total}]
    subtotal        numeric(10,2) NOT NULL,
    shipping_cost   numeric(10,2) NOT NULL DEFAULT 0,
    total           numeric(10,2) NOT NULL,
    vat_note        text NOT NULL,
    payment_note    text NOT NULL DEFAULT 'Betaald via Mollie.',
    status          text NOT NULL DEFAULT 'issued'
                    CHECK (status IN ('issued', 'partially_credited', 'credited')),
    pdf_path        text,
    emailed_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_invoices_date ON public.shop_invoices (invoice_date DESC);


CREATE TABLE IF NOT EXISTS public.shop_credit_notes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    credit_number       text NOT NULL UNIQUE,
    credit_date         date NOT NULL DEFAULT CURRENT_DATE,
    invoice_id          uuid NOT NULL REFERENCES public.shop_invoices (id) ON DELETE RESTRICT,
    reason              text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
    lines               jsonb NOT NULL,
    total               numeric(10,2) NOT NULL CHECK (total > 0),
    mollie_refund_id    text,
    pdf_path            text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shop_credit_notes_invoice ON public.shop_credit_notes (invoice_id);


-- updated_at automatisch bijhouden
CREATE OR REPLACE FUNCTION public.shop_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_products_touch ON public.shop_products;
CREATE TRIGGER trg_shop_products_touch BEFORE UPDATE ON public.shop_products
    FOR EACH ROW EXECUTE FUNCTION public.shop_touch_updated_at();

DROP TRIGGER IF EXISTS trg_shop_orders_touch ON public.shop_orders;
CREATE TRIGGER trg_shop_orders_touch BEFORE UPDATE ON public.shop_orders
    FOR EACH ROW EXECUTE FUNCTION public.shop_touch_updated_at();

DROP TRIGGER IF EXISTS trg_shop_settings_touch ON public.shop_settings;
CREATE TRIGGER trg_shop_settings_touch BEFORE UPDATE ON public.shop_settings
    FOR EACH ROW EXECUTE FUNCTION public.shop_touch_updated_at();


-- ---------------------------------------------------------------------------
-- 2. Nummering zonder gaten
-- ---------------------------------------------------------------------------
-- INSERT ... ON CONFLICT DO UPDATE neemt een rijlock; binnen dezelfde
-- transactie als de factuur-insert ontstaan er dus geen dubbele nummers en,
-- omdat een mislukte transactie ook de teller terugdraait, geen gaten.
CREATE OR REPLACE FUNCTION public.shop_next_number(p_kind text, p_prefix text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_year  integer := EXTRACT(YEAR FROM (now() AT TIME ZONE 'Europe/Brussels'))::integer;
    v_value integer;
BEGIN
    INSERT INTO public.shop_number_sequences (kind, year, last_value)
    VALUES (p_kind, v_year, 1)
    ON CONFLICT (kind, year)
    DO UPDATE SET last_value = public.shop_number_sequences.last_value + 1
    RETURNING last_value INTO v_value;

    RETURN p_prefix || v_year::text || '-' || lpad(v_value::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.shop_next_number(text, text) FROM PUBLIC, anon, authenticated;


-- Bestelnummer automatisch toekennen (gaten zijn hier toegelaten).
CREATE OR REPLACE FUNCTION public.shop_orders_assign_number()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NEW.order_number IS NULL THEN
        NEW.order_number := public.shop_next_number('order', 'B');
    END IF;
    NEW.email := LOWER(btrim(NEW.email));
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.shop_orders_assign_number() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_shop_orders_number ON public.shop_orders;
CREATE TRIGGER trg_shop_orders_number BEFORE INSERT ON public.shop_orders
    FOR EACH ROW EXECUTE FUNCTION public.shop_orders_assign_number();


-- ---------------------------------------------------------------------------
-- 3. Facturen en creditnota's zijn onveranderlijk
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.shop_invoices_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Facturen kunnen niet verwijderd worden. Maak een creditnota.'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
       OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
       OR NEW.order_id     IS DISTINCT FROM OLD.order_id
       OR NEW.seller       IS DISTINCT FROM OLD.seller
       OR NEW.customer     IS DISTINCT FROM OLD.customer
       OR NEW.lines        IS DISTINCT FROM OLD.lines
       OR NEW.subtotal     IS DISTINCT FROM OLD.subtotal
       OR NEW.shipping_cost IS DISTINCT FROM OLD.shipping_cost
       OR NEW.total        IS DISTINCT FROM OLD.total
       OR NEW.vat_note     IS DISTINCT FROM OLD.vat_note THEN
        RAISE EXCEPTION 'Een uitgereikte factuur kan niet gewijzigd worden. Maak een creditnota.'
            USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_invoices_guard ON public.shop_invoices;
CREATE TRIGGER trg_shop_invoices_guard BEFORE UPDATE OR DELETE ON public.shop_invoices
    FOR EACH ROW EXECUTE FUNCTION public.shop_invoices_guard();


CREATE OR REPLACE FUNCTION public.shop_credit_notes_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Creditnota''s kunnen niet verwijderd worden.' USING ERRCODE = '42501';
    END IF;

    IF NEW.credit_number IS DISTINCT FROM OLD.credit_number
       OR NEW.credit_date IS DISTINCT FROM OLD.credit_date
       OR NEW.invoice_id  IS DISTINCT FROM OLD.invoice_id
       OR NEW.reason      IS DISTINCT FROM OLD.reason
       OR NEW.lines       IS DISTINCT FROM OLD.lines
       OR NEW.total       IS DISTINCT FROM OLD.total THEN
        RAISE EXCEPTION 'Een creditnota kan niet gewijzigd worden.' USING ERRCODE = '42501';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_shop_credit_notes_guard ON public.shop_credit_notes;
CREATE TRIGGER trg_shop_credit_notes_guard BEFORE UPDATE OR DELETE ON public.shop_credit_notes
    FOR EACH ROW EXECUTE FUNCTION public.shop_credit_notes_guard();


-- ---------------------------------------------------------------------------
-- 4. Functies voor de Edge Functions (enkel service role)
-- ---------------------------------------------------------------------------

-- Factuur aanmaken voor een betaalde bestelling. Idempotent: bestaat de
-- factuur al, dan wordt die teruggegeven (geen tweede nummer).
CREATE OR REPLACE FUNCTION public.shop_create_invoice(p_order_id uuid)
RETURNS public.shop_invoices
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order    public.shop_orders;
    v_settings public.shop_settings;
    v_invoice  public.shop_invoices;
    v_lines    jsonb;
BEGIN
    IF NOT public.is_service_role() THEN
        RAISE EXCEPTION 'Niet toegelaten' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_order FROM public.shop_orders WHERE id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Bestelling niet gevonden' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_invoice FROM public.shop_invoices WHERE order_id = p_order_id;
    IF FOUND THEN
        RETURN v_invoice;
    END IF;

    IF v_order.payment_status NOT IN ('paid', 'refunded', 'partially_refunded') THEN
        RAISE EXCEPTION 'Bestelling is niet betaald' USING ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_settings FROM public.shop_settings WHERE id = 1;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'description', i.product_name,
               'quantity',    i.quantity,
               'unit_price',  i.unit_price,
               'line_total',  i.line_total
           ) ORDER BY i.id), '[]'::jsonb)
    INTO v_lines
    FROM public.shop_order_items i
    WHERE i.order_id = p_order_id;

    INSERT INTO public.shop_invoices (
        invoice_number, invoice_date, order_id, seller, customer, lines,
        subtotal, shipping_cost, total, vat_note
    ) VALUES (
        public.shop_next_number('invoice', 'W'),
        (now() AT TIME ZONE 'Europe/Brussels')::date,
        p_order_id,
        jsonb_build_object(
            'name',              v_settings.business_name,
            'address',           v_settings.business_address,
            'enterprise_number', v_settings.enterprise_number,
            'iban',              v_settings.iban,
            'email',             v_settings.business_email,
            'phone',             v_settings.business_phone,
            'footer',            v_settings.invoice_footer
        ),
        jsonb_build_object(
            'name',          v_order.customer_name,
            'email',         v_order.email,
            'phone',         v_order.phone,
            'company_name',  v_order.company_name,
            'company_vat',   v_order.company_vat,
            'street',        v_order.street,
            'postal_code',   v_order.postal_code,
            'city',          v_order.city,
            'country',       v_order.country,
            'order_number',  v_order.order_number,
            'delivery',      v_order.delivery_method
        ),
        v_lines,
        v_order.subtotal,
        v_order.shipping_cost,
        v_order.total,
        v_settings.vat_exempt_text
    )
    RETURNING * INTO v_invoice;

    RETURN v_invoice;
END;
$$;

REVOKE ALL ON FUNCTION public.shop_create_invoice(uuid) FROM PUBLIC, anon, authenticated;


-- Creditnota aanmaken. p_lines = [{description, quantity, unit_price}]
-- (positieve bedragen = te crediteren). Totaal mag nooit meer zijn dan wat
-- er op de factuur nog niet gecrediteerd is.
CREATE OR REPLACE FUNCTION public.shop_create_credit_note(
    p_invoice_id uuid,
    p_lines      jsonb,
    p_reason     text
)
RETURNS public.shop_credit_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_invoice   public.shop_invoices;
    v_credited  numeric(10,2);
    v_total     numeric(10,2) := 0;
    v_clean     jsonb := '[]'::jsonb;
    v_line      jsonb;
    v_qty       integer;
    v_price     numeric(10,2);
    v_desc      text;
    v_note      public.shop_credit_notes;
BEGIN
    IF NOT public.is_service_role() THEN
        RAISE EXCEPTION 'Niet toegelaten' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_invoice FROM public.shop_invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Factuur niet gevonden' USING ERRCODE = 'P0002';
    END IF;

    IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
        RAISE EXCEPTION 'Geen lijnen opgegeven' USING ERRCODE = 'P0001';
    END IF;

    FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
        v_desc  := btrim(COALESCE(v_line ->> 'description', ''));
        v_qty   := (v_line ->> 'quantity')::integer;
        v_price := round((v_line ->> 'unit_price')::numeric, 2);

        IF v_desc = '' OR char_length(v_desc) > 200
           OR v_qty IS NULL OR v_qty < 1 OR v_qty > 99
           OR v_price IS NULL OR v_price <= 0 THEN
            RAISE EXCEPTION 'Ongeldige creditlijn' USING ERRCODE = 'P0001';
        END IF;

        v_total := v_total + v_qty * v_price;
        v_clean := v_clean || jsonb_build_object(
            'description', v_desc,
            'quantity',    v_qty,
            'unit_price',  v_price,
            'line_total',  v_qty * v_price
        );
    END LOOP;

    SELECT COALESCE(SUM(total), 0) INTO v_credited
    FROM public.shop_credit_notes WHERE invoice_id = p_invoice_id;

    IF v_total > v_invoice.total - v_credited + 0.001 THEN
        RAISE EXCEPTION 'Je kan maximaal € % crediteren op deze factuur',
            to_char(v_invoice.total - v_credited, 'FM999990.00')
            USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.shop_credit_notes (credit_number, credit_date, invoice_id, reason, lines, total)
    VALUES (
        public.shop_next_number('credit', 'WC'),
        (now() AT TIME ZONE 'Europe/Brussels')::date,
        p_invoice_id,
        btrim(p_reason),
        v_clean,
        v_total
    )
    RETURNING * INTO v_note;

    UPDATE public.shop_invoices
    SET status = CASE
            WHEN v_credited + v_total >= total - 0.001 THEN 'credited'
            ELSE 'partially_credited'
        END
    WHERE id = p_invoice_id;

    RETURN v_note;
END;
$$;

REVOKE ALL ON FUNCTION public.shop_create_credit_note(uuid, jsonb, text) FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. Publieke statusopvraging (bedankpagina)
-- ---------------------------------------------------------------------------
-- Enkel wie het geheime token kent (zit in de terugkeerlink) ziet de status.
CREATE OR REPLACE FUNCTION public.shop_order_public_status(p_order_id uuid, p_token uuid)
RETURNS TABLE (
    order_number    text,
    payment_status  text,
    order_status    text,
    total           numeric,
    delivery_method text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT o.order_number, o.payment_status, o.order_status, o.total, o.delivery_method
    FROM public.shop_orders o
    WHERE o.id = p_order_id AND o.public_token = p_token;
$$;

REVOKE ALL ON FUNCTION public.shop_order_public_status(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shop_order_public_status(uuid, uuid) TO anon, authenticated;


-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.shop_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_products          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_orders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_order_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_number_sequences  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_invoices          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shop_credit_notes      ENABLE ROW LEVEL SECURITY;

-- Standaard alles intrekken, daarna gericht toekennen.
REVOKE ALL ON public.shop_settings, public.shop_products, public.shop_orders,
              public.shop_order_items, public.shop_number_sequences,
              public.shop_invoices, public.shop_credit_notes
    FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.shop_order_items_id_seq FROM anon, authenticated;

-- Instellingen: iedereen leest, beheerder wijzigt
GRANT SELECT ON public.shop_settings TO anon, authenticated;
GRANT UPDATE ON public.shop_settings TO authenticated;

DROP POLICY IF EXISTS "shop_settings_read"  ON public.shop_settings;
CREATE POLICY "shop_settings_read" ON public.shop_settings
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "shop_settings_admin_update" ON public.shop_settings;
CREATE POLICY "shop_settings_admin_update" ON public.shop_settings
    FOR UPDATE TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Producten: publiek enkel actieve, beheerder alles
GRANT SELECT ON public.shop_products TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.shop_products TO authenticated;

DROP POLICY IF EXISTS "shop_products_public_read" ON public.shop_products;
CREATE POLICY "shop_products_public_read" ON public.shop_products
    FOR SELECT TO anon, authenticated
    USING (active OR public.is_admin());

DROP POLICY IF EXISTS "shop_products_admin_write" ON public.shop_products;
CREATE POLICY "shop_products_admin_write" ON public.shop_products
    FOR ALL TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Bestellingen, facturen, creditnota's: enkel beheerder leest.
-- Schrijven gebeurt via de Edge Functions (service role).
-- De beheerder mag bij bestellingen enkel de interne notitie aanpassen.
GRANT SELECT ON public.shop_orders, public.shop_order_items,
                public.shop_invoices, public.shop_credit_notes
    TO authenticated;
GRANT UPDATE (admin_note) ON public.shop_orders TO authenticated;

DROP POLICY IF EXISTS "shop_orders_admin_read" ON public.shop_orders;
CREATE POLICY "shop_orders_admin_read" ON public.shop_orders
    FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "shop_orders_admin_note" ON public.shop_orders;
CREATE POLICY "shop_orders_admin_note" ON public.shop_orders
    FOR UPDATE TO authenticated
    USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "shop_order_items_admin_read" ON public.shop_order_items;
CREATE POLICY "shop_order_items_admin_read" ON public.shop_order_items
    FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "shop_invoices_admin_read" ON public.shop_invoices;
CREATE POLICY "shop_invoices_admin_read" ON public.shop_invoices
    FOR SELECT TO authenticated USING (public.is_admin());

DROP POLICY IF EXISTS "shop_credit_notes_admin_read" ON public.shop_credit_notes;
CREATE POLICY "shop_credit_notes_admin_read" ON public.shop_credit_notes
    FOR SELECT TO authenticated USING (public.is_admin());

-- shop_number_sequences: geen policies => enkel service role.


-- ---------------------------------------------------------------------------
-- 7. Storage
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('shop-products', 'shop-products', true, 10485760,
        ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
SET public = true,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('shop-documents', 'shop-documents', false, 5242880, ARRAY['application/pdf'])
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "shop_products_objects_admin_insert" ON storage.objects;
CREATE POLICY "shop_products_objects_admin_insert" ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'shop-products' AND public.is_admin());

DROP POLICY IF EXISTS "shop_products_objects_admin_update" ON storage.objects;
CREATE POLICY "shop_products_objects_admin_update" ON storage.objects
    FOR UPDATE TO authenticated
    USING (bucket_id = 'shop-products' AND public.is_admin())
    WITH CHECK (bucket_id = 'shop-products' AND public.is_admin());

DROP POLICY IF EXISTS "shop_products_objects_admin_delete" ON storage.objects;
CREATE POLICY "shop_products_objects_admin_delete" ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'shop-products' AND public.is_admin());

-- Facturen (privé): enkel de beheerder mag lezen (signed URL), schrijven
-- gebeurt door de Edge Functions met de service role.
DROP POLICY IF EXISTS "shop_documents_admin_read" ON storage.objects;
CREATE POLICY "shop_documents_admin_read" ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'shop-documents' AND public.is_admin());
