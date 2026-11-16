// ============================================================================
// shop-admin — Supabase Edge Function (Deno)
// ============================================================================
// Beheeracties voor de webshop die de service role nodig hebben (status +
// mail, facturen, creditnota's, terugbetalingen). Enkel voor ingelogde
// beheerders (rij in admin_users) — gecontroleerd via is_admin().
//
// Aanroep (shop/admin.html):
//   sb.functions.invoke("shop-admin", { body: { action, ... } })
//
//   set_status      { order_id, status, tracking_code?, delivery_slot?, notify }
//   cancel_order    { order_id }                      (enkel onbetaald)
//   retry_invoice   { order_id }
//   resend_invoice  { order_id }
//   credit_note     { invoice_id, lines:[{description,quantity,unit_price}],
//                     reason, refund: boolean, notify: boolean }
//   mail_status     {}                                → { provider: "smtp"|"emailjs"|null }
//   test_email      { to? }                           (standaard: zakelijk e-mailadres)
//
// Deploy: supabase functions deploy shop-admin
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import {
    corsHeaders,
    CreditNote,
    documentLink,
    EMAIL_REGEX,
    ensureCreditPdf,
    ensureInvoice,
    escapeHtml,
    euro,
    getSettings,
    json,
    mailProvider,
    mollie,
    Order,
    round2,
    sb,
    sendShopEmail,
    sendStatusEmail,
    SUPABASE_ANON_KEY,
    SUPABASE_URL,
} from "../_shared/shop.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_STATUSES = ["new", "in_production", "ready_for_pickup", "shipped", "out_for_delivery", "delivered", "completed", "cancelled"];

async function isAdmin(req: Request): Promise<boolean> {
    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ")) return false;
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: auth } },
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: user } = await userClient.auth.getUser();
    if (!user?.user) return false;
    const { data, error } = await userClient.rpc("is_admin");
    return !error && data === true;
}

async function getOrder(id: unknown): Promise<Order | null> {
    if (!UUID.test(String(id ?? ""))) return null;
    const { data } = await sb.from("shop_orders").select("*").eq("id", id).maybeSingle();
    return data as Order | null;
}

Deno.serve(async (req: Request) => {
    const headers = corsHeaders(req);
    if (req.method === "OPTIONS") return new Response("ok", { headers });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, headers);

    try {
        if (!(await isAdmin(req))) return json({ error: "Geen toegang." }, 403, headers);

        const body = await req.json().catch(() => ({}));
        switch (body.action) {
            case "set_status":
                return await setStatus(body, headers);
            case "cancel_order":
                return await cancelOrder(body, headers);
            case "retry_invoice":
                return await retryInvoice(body, headers);
            case "resend_invoice":
                return await resendInvoice(body, headers);
            case "credit_note":
                return await creditNote(body, headers);
            case "mail_status":
                return json({ provider: mailProvider() }, 200, headers);
            case "test_email":
                return await testEmail(body, headers);
            default:
                return json({ error: "Onbekende actie." }, 400, headers);
        }
    } catch (err) {
        console.error("shop-admin fout:", err);
        const msg = (err as { code?: string; message?: string });
        // Eigen validatiemeldingen uit de database doorgeven.
        if (msg?.code === "P0001" || msg?.code === "42501") {
            return json({ error: msg.message }, 400, headers);
        }
        return json({ error: "Er ging iets mis." }, 500, headers);
    }
});

async function setStatus(body: any, headers: Record<string, string>) {
    const order = await getOrder(body.order_id);
    if (!order) return json({ error: "Bestelling niet gevonden." }, 404, headers);

    const status = String(body.status ?? "");
    if (!ORDER_STATUSES.includes(status)) return json({ error: "Ongeldige status." }, 400, headers);
    if (order.payment_status !== "paid" && status !== "cancelled") {
        return json({ error: "Deze bestelling is (nog) niet betaald." }, 400, headers);
    }
    if (status === "ready_for_pickup" && order.delivery_method !== "pickup") {
        return json({ error: "Deze bestelling wordt geleverd, niet afgehaald." }, 400, headers);
    }
    if (["shipped", "out_for_delivery", "delivered"].includes(status) && order.delivery_method !== "shipping") {
        return json({ error: "Deze bestelling wordt afgehaald, niet geleverd." }, 400, headers);
    }

    const tracking = String(body.tracking_code ?? "").trim().slice(0, 100) || order.tracking_code;
    const update: Record<string, unknown> = { order_status: status, tracking_code: tracking };
    if (typeof body.delivery_slot === "string") {
        update.delivery_slot = body.delivery_slot.trim().slice(0, 150) || null;
    }
    if (status === "delivered" || (status === "completed" && order.delivery_method === "pickup")) {
        update.delivered_at = order.delivered_at ?? new Date().toISOString();
    }
    const { data, error } = await sb
        .from("shop_orders")
        .update(update)
        .eq("id", order.id)
        .select("*")
        .single();
    if (error) throw error;

    if (body.notify === true && status !== order.order_status) {
        await sendStatusEmail(data as Order, status);
    }
    return json({ ok: true, order: data }, 200, headers);
}

async function cancelOrder(body: any, headers: Record<string, string>) {
    const order = await getOrder(body.order_id);
    if (!order) return json({ error: "Bestelling niet gevonden." }, 404, headers);
    if (order.payment_status === "paid") {
        return json({ error: "Betaalde bestelling: maak een creditnota (met terugbetaling)." }, 400, headers);
    }
    if (order.mollie_payment_id && order.payment_status === "pending") {
        // Openstaande betaling bij Mollie ook annuleren (faalt stil als dat niet kan).
        await mollie(`/payments/${order.mollie_payment_id}`, { method: "DELETE" });
    }
    const { error } = await sb.from("shop_orders")
        .update({ payment_status: "cancelled", order_status: "cancelled" })
        .eq("id", order.id)
        .neq("payment_status", "paid");
    if (error) throw error;
    return json({ ok: true }, 200, headers);
}

async function retryInvoice(body: any, headers: Record<string, string>) {
    const order = await getOrder(body.order_id);
    if (!order) return json({ error: "Bestelling niet gevonden." }, 404, headers);
    const invoice = await ensureInvoice(order.id);
    return json({ ok: true, invoice }, 200, headers);
}

async function resendInvoice(body: any, headers: Record<string, string>) {
    const order = await getOrder(body.order_id);
    if (!order) return json({ error: "Bestelling niet gevonden." }, 404, headers);
    const invoice = await ensureInvoice(order.id);
    const settings = await getSettings();

    const sent = await sendShopEmail(
        order.email,
        `Factuur ${invoice.invoice_number}`,
        `<p>Dag ${escapeHtml(order.customer_name)},</p>` +
            `<p>Hierbij je factuur <strong>${escapeHtml(invoice.invoice_number)}</strong> ` +
            `voor bestelling ${escapeHtml(order.order_number)} (${euro(invoice.total)}).</p>` +
            `<p><a href="${documentLink(order, "invoice")}">Factuur downloaden (pdf)</a></p>` +
            `<p>Liefs,<br>${escapeHtml(settings.business_name)}</p>`,
        settings.business_email,
    );
    if (!sent) return json({ error: "Mail kon niet verstuurd worden." }, 502, headers);

    await sb.from("shop_invoices").update({ emailed_at: new Date().toISOString() }).eq("id", invoice.id);
    return json({ ok: true }, 200, headers);
}

async function testEmail(body: any, headers: Record<string, string>) {
    const settings = await getSettings();
    const to = String(body.to ?? "").trim().toLowerCase() || settings.business_email;
    if (!EMAIL_REGEX.test(to)) return json({ error: "Ongeldig e-mailadres." }, 400, headers);
    const provider = mailProvider();
    if (!provider) return json({ error: "Er zijn nog geen mailinstellingen (SMTP) ingesteld." }, 400, headers);
    const ok = await sendShopEmail(
        to,
        "Testmail webshop ✔",
        `<p>Dag,</p><p>Dit is een testmail van de webshop. Komt deze aan, dan werken de webshopmails ` +
            `(bestelbevestigingen, statusmails, herroepingen). 🎉</p>` +
            `<p style="color:#888;font-size:13px">Verstuurd via ${provider === "smtp" ? "SMTP" : "EmailJS"} op ` +
            `${escapeHtml(new Date().toLocaleString("nl-BE", { timeZone: "Europe/Brussels" }))}.</p>`,
        settings.business_email,
    );
    if (!ok) return json({ error: "Versturen mislukt. Controleer de SMTP-gegevens (zie logs van shop-admin)." }, 502, headers);
    return json({ ok: true, to, provider }, 200, headers);
}

async function creditNote(body: any, headers: Record<string, string>) {
    if (!UUID.test(String(body.invoice_id ?? ""))) return json({ error: "Ongeldige factuur." }, 400, headers);
    const reason = String(body.reason ?? "").trim();
    if (!reason) return json({ error: "Geef een reden op." }, 400, headers);

    const { data: invoice, error: invError } = await sb
        .from("shop_invoices").select("*").eq("id", body.invoice_id).single();
    if (invError || !invoice) return json({ error: "Factuur niet gevonden." }, 404, headers);
    const order = await getOrder(invoice.order_id);
    if (!order) return json({ error: "Bestelling niet gevonden." }, 404, headers);

    // 1. Creditnota (nummer + controle maximumbedrag gebeurt in de database)
    const { data, error } = await sb.rpc("shop_create_credit_note", {
        p_invoice_id: invoice.id,
        p_lines: body.lines,
        p_reason: reason,
    });
    if (error) throw error;
    let note = (Array.isArray(data) ? data[0] : data) as CreditNote;

    // 2. Pdf
    try {
        note = await ensureCreditPdf(note);
    } catch (err) {
        console.error("Pdf creditnota mislukt (wordt bij download opnieuw geprobeerd):", err);
    }

    // 3. Optioneel terugbetalen via Mollie
    let refundError: string | null = null;
    if (body.refund === true) {
        if (!order.mollie_payment_id) {
            refundError = "Geen Mollie-betaling gekoppeld; betaal manueel terug.";
        } else {
            const { ok, data: refund } = await mollie(`/payments/${order.mollie_payment_id}/refunds`, {
                method: "POST",
                body: JSON.stringify({
                    amount: { currency: "EUR", value: Number(note.total).toFixed(2) },
                    description: `Creditnota ${note.credit_number}`,
                }),
            });
            if (ok && refund?.id) {
                await sb.from("shop_credit_notes").update({ mollie_refund_id: refund.id }).eq("id", note.id);
                note.mollie_refund_id = refund.id;
            } else {
                console.error("Mollie refund mislukt:", refund);
                refundError = String(refund?.detail ?? "Terugbetaling via Mollie mislukt; betaal manueel terug.");
            }
        }
    }

    // 4. Betaalstatus van de bestelling bijwerken
    const { data: allNotes } = await sb.from("shop_credit_notes").select("total").eq("invoice_id", invoice.id);
    const credited = round2((allNotes ?? []).reduce((s, n) => s + Number(n.total), 0));
    if (body.refund === true && !refundError) {
        await sb.from("shop_orders")
            .update({ payment_status: credited >= Number(invoice.total) - 0.001 ? "refunded" : "partially_refunded" })
            .eq("id", order.id);
    }

    // 5. Optioneel mail naar klant
    if (body.notify === true) {
        const settings = await getSettings();
        await sendShopEmail(
            order.email,
            `Creditnota ${note.credit_number}`,
            `<p>Dag ${escapeHtml(order.customer_name)},</p>` +
                `<p>Voor je bestelling ${escapeHtml(order.order_number)} maakten we creditnota ` +
                `<strong>${escapeHtml(note.credit_number)}</strong> op van ${euro(note.total)}.</p>` +
                (body.refund === true && !refundError
                    ? `<p>Het bedrag wordt teruggestort via je oorspronkelijke betaalmethode.</p>`
                    : "") +
                `<p><a href="${documentLink(order, "credit", note.id)}">Creditnota downloaden (pdf)</a></p>` +
                `<p>Liefs,<br>${escapeHtml(settings.business_name)}</p>`,
            settings.business_email,
        );
    }

    return json({ ok: true, credit_note: note, refund_error: refundError }, 200, headers);
}
