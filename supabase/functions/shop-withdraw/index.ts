// ============================================================================
// shop-withdraw — Supabase Edge Function (Deno)
// ============================================================================
// Online herroeping (14 dagen bedenktijd) via shop/herroeping.html.
//   1. Controleert dat bestelnummer + e-mailadres bij een betaalde bestelling horen
//      (zelfde foutmelding als het niet klopt, zodat niemand bestellingen kan raden)
//   2. Bewaart de herroeping (shop_withdrawals)
//   3. Stuurt de klant meteen een ontvangstbevestiging (verplicht) en de beheerder een melding
//
// Aanroep: sb.functions.invoke("shop-withdraw", { body: {
//     order_number, email, name, items, reason? } })
//
// Deploy: supabase functions deploy shop-withdraw
// ============================================================================

import {
    BASE_URL,
    corsHeaders,
    EMAIL_REGEX,
    escapeHtml,
    getSettings,
    json,
    sb,
    sendShopEmail,
} from "../_shared/shop.ts";

const RATE_LIMIT_PER_10_MIN = 20;

function str(v: unknown, max: number): string {
    return String(v ?? "").trim().slice(0, max + 1);
}

Deno.serve(async (req: Request) => {
    const headers = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);

    try {
        const body = await req.json().catch(() => ({}));
        const orderNumber = str(body.order_number, 20).toUpperCase();
        const email = str(body.email, 254).toLowerCase();
        const name = str(body.name, 100);
        const items = str(body.items, 1000);
        const reason = str(body.reason, 1000) || null;

        if (!/^B\d{4}-\d{4,}$/.test(orderNumber)) {
            return json({ error: "Vul je bestelnummer in (bv. B2026-0012)." }, 400, headers);
        }
        if (!EMAIL_REGEX.test(email)) return json({ error: "Vul een geldig e-mailadres in." }, 400, headers);
        if (!name || name.length > 100) return json({ error: "Vul je naam in." }, 400, headers);
        if (!items || items.length > 1000) {
            return json({ error: "Vermeld welke producten je wil terugsturen (max. 1000 tekens)." }, 400, headers);
        }
        if ((reason?.length ?? 0) > 1000) return json({ error: "De reden is te lang (max. 1000 tekens)." }, 400, headers);

        // Eenvoudige flood-bescherming
        const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const { count } = await sb.from("shop_withdrawals")
            .select("id", { count: "exact", head: true }).gt("created_at", since);
        if ((count ?? 0) >= RATE_LIMIT_PER_10_MIN) {
            return json({ error: "Even te druk. Probeer binnen enkele minuten opnieuw of mail ons." }, 429, headers);
        }

        const { data: order } = await sb.from("shop_orders")
            .select("id, order_number, email, customer_name, payment_status")
            .eq("order_number", orderNumber)
            .maybeSingle();

        const notFound = "We vinden geen betaalde bestelling met dit bestelnummer en e-mailadres. " +
            "Controleer je gegevens of mail ons.";
        if (!order || String(order.email).toLowerCase() !== email ||
            !["paid", "partially_refunded"].includes(order.payment_status)) {
            return json({ error: notFound }, 404, headers);
        }

        const { data: w, error } = await sb.from("shop_withdrawals")
            .insert({ order_id: order.id, customer_name: name, email, items, reason })
            .select("id, created_at")
            .single();
        if (error || !w) throw error;

        const settings = await getSettings();
        const when = new Date(w.created_at).toLocaleString("nl-BE", { timeZone: "Europe/Brussels" });
        const summary =
            `<table style="border-collapse:collapse">` +
            `<tr><td style="padding:2px 12px 2px 0">Bestelling</td><td><strong>${escapeHtml(order.order_number)}</strong></td></tr>` +
            `<tr><td style="padding:2px 12px 2px 0">Ontvangen op</td><td>${escapeHtml(when)}</td></tr>` +
            `<tr><td style="padding:2px 12px 2px 0;vertical-align:top">Producten</td><td>${escapeHtml(items).replace(/\n/g, "<br>")}</td></tr>` +
            (reason ? `<tr><td style="padding:2px 12px 2px 0;vertical-align:top">Reden</td><td>${escapeHtml(reason).replace(/\n/g, "<br>")}</td></tr>` : "") +
            `</table>`;

        await sendShopEmail(
            email,
            `Ontvangstbevestiging herroeping ${order.order_number}`,
            `<p>Dag ${escapeHtml(name)},</p>` +
                `<p>We hebben je herroeping goed ontvangen. Dit is je ontvangstbevestiging.</p>` +
                summary +
                `<p>Stuur of breng de producten ongebruikt terug binnen 14 dagen. We nemen contact met je op ` +
                `over het terugbezorgen. Na ontvangst betalen we het bedrag terug binnen 14 dagen.</p>` +
                `<p>Liefs,<br>${escapeHtml(settings.business_name)}</p>`,
            settings.business_email,
        );

        const adminTo = Deno.env.get("SHOP_ADMIN_EMAIL") || settings.business_email;
        if (adminTo) {
            await sendShopEmail(
                adminTo,
                `↩️ Herroeping ${order.order_number}`,
                `<p>${escapeHtml(name)} (${escapeHtml(email)}) heeft de overeenkomst herroepen.</p>` + summary +
                    `<p><a href="${BASE_URL}/shop/admin.html#order=${encodeURIComponent(order.order_number)}">Open de bestelling in de admin</a></p>`,
                email,
            );
        }

        return json({ ok: true, order_number: order.order_number, received_at: w.created_at }, 200, headers);
    } catch (err) {
        console.error("shop-withdraw fout:", err);
        return json({ error: "Er ging iets mis. Mail ons gerust je herroeping." }, 500, headers);
    }
});
