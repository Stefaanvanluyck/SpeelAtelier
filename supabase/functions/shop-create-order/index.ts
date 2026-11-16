// ============================================================================
// shop-create-order — Supabase Edge Function (Deno)
// ============================================================================
// Maakt een webshopbestelling + Mollie-betaling aan. Prijzen, verzendkosten
// en totaal worden HIER berekend uit de database; bedragen uit de browser
// worden genegeerd.
//
// Aanroep (shop/index.html):
//   sb.functions.invoke("shop-create-order", { body: {
//       items: [{ product_id, quantity }],
//       customer: { name, email, phone, company_name, company_vat },
//       delivery: { method: "pickup"|"shipping", street, postal_code, city, country },
//       note, terms_accepted: true,
//       discount_code?: string
//   }})
// Antwoord: { checkoutUrl, orderId, orderNumber, total }
//
// Deploy: supabase functions deploy shop-create-order
// ============================================================================

import {
    BASE_URL,
    corsHeaders,
    EMAIL_REGEX,
    json,
    mollie,
    round2,
    sb,
    SUPABASE_URL,
} from "../_shared/shop.ts";

const MAX_LINES = 30;
const RATE_LIMIT_PER_10_MIN = 20;

function str(v: unknown, max: number): string {
    return String(v ?? "").trim().slice(0, max + 1);
}

Deno.serve(async (req: Request) => {
    const headers = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);

    try {
        return await handle(req, headers);
    } catch (err) {
        console.error("Onverwachte fout:", err);
        return json({ error: "Er ging iets mis. Probeer later opnieuw." }, 500, headers);
    }
});

async function handle(req: Request, headers: Record<string, string>): Promise<Response> {
    let body: Record<string, any>;
    try {
        body = await req.json();
    } catch {
        return json({ error: "Ongeldige aanvraag." }, 400, headers);
    }

    // ------------------------------------------------------------------
    // 1. Instellingen
    // ------------------------------------------------------------------
    const { data: settings, error: settingsError } = await sb
        .from("shop_settings").select("*").eq("id", 1).single();
    if (settingsError || !settings) throw settingsError;

    if (!settings.shop_open) {
        return json({ error: "De webshop is momenteel gesloten." }, 403, headers);
    }

    // ------------------------------------------------------------------
    // 2. Klant & levering valideren
    // ------------------------------------------------------------------
    const c = body.customer ?? {};
    const d = body.delivery ?? {};

    const name = str(c.name, 100);
    const email = str(c.email, 254).toLowerCase();
    const phone = str(c.phone, 30) || null;
    const companyName = str(c.company_name, 120) || null;
    const companyVat = str(c.company_vat, 30) || null;
    const note = str(body.note, 1000) || null;
    const method = String(d.method ?? "");

    if (!name || name.length > 100) return json({ error: "Vul je naam in." }, 400, headers);
    if (!EMAIL_REGEX.test(email) || email.length > 254) {
        return json({ error: "Ongeldig e-mailadres." }, 400, headers);
    }
    if (phone && phone.length > 30) return json({ error: "Telefoonnummer is te lang." }, 400, headers);
    if ((companyName?.length ?? 0) > 120 || (companyVat?.length ?? 0) > 30) {
        return json({ error: "Bedrijfsgegevens zijn te lang." }, 400, headers);
    }
    if ((note?.length ?? 0) > 1000) return json({ error: "Opmerking is te lang (max. 1000 tekens)." }, 400, headers);
    if (body.terms_accepted !== true) {
        return json({ error: "Je moet de algemene voorwaarden aanvaarden." }, 400, headers);
    }

    if (method === "pickup" && !settings.pickup_enabled) {
        return json({ error: "Afhalen is momenteel niet mogelijk." }, 400, headers);
    }
    if (method === "shipping" && !settings.shipping_enabled) {
        return json({ error: "Verzenden is momenteel niet mogelijk." }, 400, headers);
    }
    if (method !== "pickup" && method !== "shipping") {
        return json({ error: "Kies afhalen of verzenden." }, 400, headers);
    }

    let street: string | null = null, postal: string | null = null, city: string | null = null;
    let country = "BE";
    if (method === "shipping") {
        street = str(d.street, 150);
        postal = str(d.postal_code, 12);
        city = str(d.city, 80);
        country = String(d.country ?? "BE") === "NL" ? "NL" : "BE";
        if (!street || street.length > 150 || !postal || postal.length > 12 || !city || city.length > 80) {
            return json({ error: "Vul een volledig leveradres in." }, 400, headers);
        }
        const postalOk = country === "BE" ? /^\d{4}$/.test(postal) : /^\d{4}\s?[A-Za-z]{2}$/.test(postal);
        if (!postalOk) return json({ error: "Ongeldige postcode." }, 400, headers);
    }

    // ------------------------------------------------------------------
    // 3. Mandje valideren (dubbele producten samenvoegen)
    // ------------------------------------------------------------------
    if (!Array.isArray(body.items) || body.items.length === 0) {
        return json({ error: "Je winkelmandje is leeg." }, 400, headers);
    }
    if (body.items.length > MAX_LINES) {
        return json({ error: "Te veel verschillende producten in één bestelling." }, 400, headers);
    }

    const wanted = new Map<string, number>();
    for (const it of body.items) {
        const id = String(it?.product_id ?? "");
        const q = Number(it?.quantity);
        if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isInteger(q) || q < 1 || q > 99) {
            return json({ error: "Ongeldig product in je mandje." }, 400, headers);
        }
        wanted.set(id, (wanted.get(id) ?? 0) + q);
    }

    const { data: products, error: productsError } = await sb
        .from("shop_products")
        .select("id, name, price, max_per_order, active")
        .in("id", [...wanted.keys()]);
    if (productsError) throw productsError;

    const lines: { product_id: string; product_name: string; unit_price: number; quantity: number; line_total: number }[] = [];
    for (const [id, quantity] of wanted) {
        const p = (products ?? []).find((x) => x.id === id);
        if (!p || !p.active) {
            return json({ error: "Een product in je mandje is niet meer beschikbaar. Vernieuw de pagina." }, 409, headers);
        }
        if (quantity > p.max_per_order) {
            return json({ error: `Je kan maximaal ${p.max_per_order} × "${p.name}" bestellen.` }, 400, headers);
        }
        const unit = Number(p.price);
        lines.push({
            product_id: id,
            product_name: p.name,
            unit_price: unit,
            quantity,
            line_total: round2(unit * quantity),
        });
    }

    // ------------------------------------------------------------------
    // 4. Bedragen (korting op het subtotaal, verzending op het bedrag na korting)
    // ------------------------------------------------------------------
    const subtotal = round2(lines.reduce((s, l) => s + l.line_total, 0));

    let discountCode: string | null = null;
    let discount = 0;
    const rawCode = str(body.discount_code, 30);
    if (rawCode) {
        const { data: check, error: checkError } = await sb.rpc("shop_check_discount", {
            p_code: rawCode,
            p_subtotal: subtotal,
        });
        if (checkError) throw checkError;
        if (!check?.valid) {
            return json({ error: String(check?.message ?? "Deze kortingscode is ongeldig.") }, 400, headers);
        }
        discountCode = String(check.code);
        discount = Math.min(subtotal, round2(Number(check.amount) || 0));
    }

    const afterDiscount = round2(subtotal - discount);
    let shipping = 0;
    if (method === "shipping") {
        const freeFrom = settings.free_shipping_from != null ? Number(settings.free_shipping_from) : null;
        shipping = freeFrom != null && afterDiscount >= freeFrom ? 0 : Number(settings.shipping_cost);
    }
    const total = round2(afterDiscount + shipping);
    if (total < 1) {
        return json({ error: "Het minimumbedrag voor een bestelling is € 1,00." }, 400, headers);
    }

    // ------------------------------------------------------------------
    // 5. Eenvoudige flood-bescherming
    // ------------------------------------------------------------------
    const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count } = await sb
        .from("shop_orders")
        .select("id", { count: "exact", head: true })
        .gt("created_at", since);
    if ((count ?? 0) >= RATE_LIMIT_PER_10_MIN) {
        return json({ error: "Te veel bestellingen op korte tijd. Probeer binnen enkele minuten opnieuw." }, 429, headers);
    }

    // ------------------------------------------------------------------
    // 6. Bestelling opslaan
    // ------------------------------------------------------------------
    const { data: order, error: orderError } = await sb
        .from("shop_orders")
        .insert({
            customer_name: name,
            email,
            phone,
            company_name: companyName,
            company_vat: companyVat,
            delivery_method: method,
            street,
            postal_code: postal,
            city,
            country,
            customer_note: note,
            subtotal,
            shipping_cost: shipping,
            discount_code: discountCode,
            discount_amount: discount,
            total,
            terms_accepted_at: new Date().toISOString(),
        })
        .select("id, order_number, public_token")
        .single();

    if (orderError || !order) {
        console.error("Order insert error:", orderError);
        return json({ error: "De bestelling kon niet worden opgeslagen." }, 400, headers);
    }

    const { error: itemsError } = await sb
        .from("shop_order_items")
        .insert(lines.map((l) => ({ ...l, order_id: order.id })));

    if (itemsError) {
        console.error("Items insert error:", itemsError);
        await sb.from("shop_orders")
            .update({ payment_status: "cancelled", order_status: "cancelled" })
            .eq("id", order.id);
        return json({ error: "De bestelling kon niet worden opgeslagen." }, 500, headers);
    }

    // ------------------------------------------------------------------
    // 7. Mollie-betaling
    // ------------------------------------------------------------------
    const redirect = new URL(`${BASE_URL}/shop/bedankt.html`);
    redirect.searchParams.set("order", order.id);
    redirect.searchParams.set("token", order.public_token);

    const { ok, data: payment } = await mollie("/payments", {
        method: "POST",
        body: JSON.stringify({
            amount: { currency: "EUR", value: total.toFixed(2) },
            description: `Webshop ${order.order_number} – ${settings.business_name}`.slice(0, 255),
            redirectUrl: redirect.toString(),
            webhookUrl: `${SUPABASE_URL}/functions/v1/shop-mollie-webhook`,
            metadata: { shop_order_id: order.id },
        }),
    });

    const checkoutUrl = String(payment?._links?.checkout?.href ?? "");
    if (!ok || !payment?.id || !checkoutUrl) {
        console.error("Mollie error:", payment);
        await sb.from("shop_orders")
            .update({ payment_status: "cancelled", order_status: "cancelled" })
            .eq("id", order.id);
        return json({ error: "De betaalpagina kon niet worden aangemaakt. Probeer opnieuw." }, 502, headers);
    }

    await sb.from("shop_orders").update({ mollie_payment_id: payment.id }).eq("id", order.id);

    return json({
        checkoutUrl,
        orderId: order.id,
        orderNumber: order.order_number,
        total,
    }, 200, headers);
}
