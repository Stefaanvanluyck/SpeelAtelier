// ============================================================================
// shop-document — Supabase Edge Function (Deno)
// ============================================================================
// Laat een klant zijn factuur of creditnota downloaden via de link in de
// bevestigingsmail. Enkel wie het geheime token van de bestelling kent,
// krijgt het document.
//
//   GET /functions/v1/shop-document?order=<uuid>&token=<uuid>&doc=invoice
//   GET /functions/v1/shop-document?order=<uuid>&token=<uuid>&doc=credit&id=<uuid>
//
// Deploy: supabase functions deploy shop-document --no-verify-jwt
// ============================================================================

import { DOCUMENT_BUCKET, ensureCreditPdf, ensureInvoice, sb } from "../_shared/shop.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
    return new Response("Document niet gevonden.", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
}

Deno.serve(async (req: Request) => {
    if (req.method !== "GET") return new Response("method_not_allowed", { status: 405 });

    const url = new URL(req.url);
    const orderId = url.searchParams.get("order") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const doc = url.searchParams.get("doc") ?? "invoice";
    const docId = url.searchParams.get("id") ?? "";

    if (!UUID.test(orderId) || !UUID.test(token)) return notFound();

    try {
        const { data: order } = await sb
            .from("shop_orders")
            .select("id, public_token")
            .eq("id", orderId)
            .eq("public_token", token)
            .maybeSingle();
        if (!order) return notFound();

        let path: string | null = null;
        let filename = "document.pdf";

        if (doc === "invoice") {
            const { data: inv } = await sb.from("shop_invoices").select("id").eq("order_id", orderId).maybeSingle();
            if (!inv) return notFound();
            const invoice = await ensureInvoice(orderId);
            path = invoice.pdf_path;
            filename = `Factuur-${invoice.invoice_number}.pdf`;
        } else if (doc === "credit" && UUID.test(docId)) {
            const { data: note } = await sb
                .from("shop_credit_notes")
                .select("*, shop_invoices!inner(order_id)")
                .eq("id", docId)
                .eq("shop_invoices.order_id", orderId)
                .maybeSingle();
            if (!note) return notFound();
            const withPdf = await ensureCreditPdf(note);
            path = withPdf.pdf_path;
            filename = `Creditnota-${note.credit_number}.pdf`;
        } else {
            return notFound();
        }

        if (!path) return notFound();
        const { data: file, error } = await sb.storage.from(DOCUMENT_BUCKET).download(path);
        if (error || !file) return notFound();

        return new Response(file, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${filename}"`,
                "Cache-Control": "private, no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
    } catch (err) {
        console.error("Document ophalen mislukt:", err);
        return new Response("Er ging iets mis.", { status: 500 });
    }
});
