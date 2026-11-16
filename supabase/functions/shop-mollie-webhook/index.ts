// ============================================================================
// shop-mollie-webhook — Supabase Edge Function (Deno)
// ============================================================================
// Aparte webhook voor de webshop (de webhook voor inschrijvingen blijft
// ongewijzigd). Werkt zo:
//   1. Status opnieuw opvragen bij Mollie (vervalste webhooks hebben geen effect)
//   2. Bestelling bijwerken
//   3. Bij de overgang naar 'betaald': factuur + pdf aanmaken en mails sturen
//
// Deploy: supabase functions deploy shop-mollie-webhook --no-verify-jwt
// ============================================================================

import { ensureInvoice, Invoice, mollie, Order, sb, sendOrderConfirmation } from "../_shared/shop.ts";

const STATUS_MAP: Record<string, string> = {
    open: "pending",
    pending: "pending",
    authorized: "pending",
    paid: "paid",
    canceled: "cancelled",
    expired: "expired",
    failed: "failed",
};

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") return new Response("nok", { status: 405 });

    // 1. Payment-ID (Mollie stuurt form-urlencoded "id=tr_...")
    let paymentId = "";
    try {
        const raw = await req.text();
        if (raw.trimStart().startsWith("{")) {
            try {
                paymentId = String(JSON.parse(raw).id ?? "");
            } catch { /* val terug op form */ }
        }
        if (!paymentId) paymentId = new URLSearchParams(raw).get("id") ?? "";
    } catch {
        return new Response("nok", { status: 400 });
    }
    if (!/^tr_[A-Za-z0-9]+$/.test(paymentId)) return new Response("nok", { status: 400 });

    // 2. Status bij Mollie verifiëren
    const { ok, status, data: payment } = await mollie(`/payments/${paymentId}`);
    if (!ok) {
        console.error("Mollie status check mislukt:", status);
        return new Response("nok", { status: 502 });
    }

    const orderId = String(payment.metadata?.shop_order_id ?? "");
    if (!orderId) {
        // Geen webshopbetaling: negeren (niet opnieuw laten proberen).
        return new Response("ok", { status: 200 });
    }

    const { data: order, error } = await sb.from("shop_orders").select("*").eq("id", orderId).maybeSingle();
    if (error) {
        console.error("Order ophalen mislukt:", error);
        return new Response("nok", { status: 500 });
    }
    if (!order) return new Response("ok", { status: 200 });

    if (order.mollie_payment_id && order.mollie_payment_id !== paymentId) {
        console.error("Payment-ID hoort niet bij deze bestelling:", { paymentId, orderId });
        return new Response("ok", { status: 200 });
    }

    // 3. Nieuwe status bepalen
    const current = String(order.payment_status);
    let next = STATUS_MAP[String(payment.status)] ?? current;

    const amountOk = Math.abs(Number(payment.amount?.value) - Number(order.total)) <= 0.01 &&
        payment.amount?.currency === "EUR";

    // Een eenmaal betaalde (of terugbetaalde) bestelling nooit terugzetten.
    if (["paid", "refunded", "partially_refunded"].includes(current)) next = current;
    if (next === "paid" && current !== "paid" && !amountOk) {
        console.error("Bedrag komt niet overeen, niet als betaald gemarkeerd:", {
            mollie: payment.amount, order: order.total, orderId,
        });
        next = "pending";
    }

    const becamePaid = next === "paid" && current !== "paid";
    const update: Record<string, unknown> = { payment_status: next };
    if (!order.mollie_payment_id) update.mollie_payment_id = paymentId;
    if (becamePaid) update.paid_at = payment.paidAt ?? new Date().toISOString();
    if (["cancelled", "expired", "failed"].includes(next) && order.order_status === "new") {
        update.order_status = "cancelled";
    }

    // Voorwaardelijke update: enkel als de status intussen niet wijzigde.
    // Zo verstuurt een dubbele webhook nooit twee keer de mails.
    const { data: updated, error: updError } = await sb
        .from("shop_orders")
        .update(update)
        .eq("id", orderId)
        .eq("payment_status", current)
        .select("*");
    if (updError) {
        console.error("Status update mislukt:", updError);
        return new Response("nok", { status: 500 });
    }
    if (!updated || updated.length === 0) {
        // Een andere webhook was ons voor; die handelt het verder af.
        return new Response("ok", { status: 200 });
    }

    // 4. Factuur + mails (fouten mogen de status niet ongedaan maken)
    if (becamePaid) {
        const paidOrder = updated[0] as Order;
        if (paidOrder.discount_code) {
            const { error: redeemError } = await sb.rpc("shop_redeem_discount", { p_code: paidOrder.discount_code });
            if (redeemError) console.error("Kortingscode registreren mislukt:", redeemError);
        }
        let invoice: Invoice | null = null;
        try {
            invoice = await ensureInvoice(orderId);
        } catch (err) {
            console.error("Factuur aanmaken mislukt:", err);
            await sb.from("shop_orders")
                .update({ invoice_error: String((err as Error)?.message ?? err).slice(0, 500) })
                .eq("id", orderId);
        }
        try {
            await sendOrderConfirmation(paidOrder, invoice);
            if (invoice) {
                await sb.from("shop_invoices").update({ emailed_at: new Date().toISOString() }).eq("id", invoice.id);
            }
        } catch (err) {
            console.error("Mail versturen mislukt:", err);
        }
    }

    return new Response("ok", { status: 200 });
});
