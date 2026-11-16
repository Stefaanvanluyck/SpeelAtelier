// ============================================================================
// _shared/shop.ts — gedeelde code voor de webshop Edge Functions
// ============================================================================
// Gebruikt door: shop-create-order, shop-mollie-webhook, shop-admin,
// shop-document. Raakt NIETS van de inschrijvingen (appointments) aan.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   MOLLIE_API_KEY, BASE_URL, EMAILJS_PUBLIC_KEY, EMAILJS_PRIVATE_KEY,
//   EMAILJS_SERVICE                 -> bestaan al voor de inschrijvingen
//   EMAILJS_SHOP_TEMPLATE           -> NIEUW: generieke webshop-template
//   SHOP_ADMIN_EMAIL                -> NIEUW: adres voor meldingen nieuwe bestelling
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "npm:pdf-lib@1.17.1";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const MOLLIE_API_KEY = Deno.env.get("MOLLIE_API_KEY")!;
export const BASE_URL = (Deno.env.get("BASE_URL") ?? "https://jufvalerie.be")
    .replace(/\/+$/, "");

const EMAILJS_PUBLIC_KEY = Deno.env.get("EMAILJS_PUBLIC_KEY") ?? "";
const EMAILJS_PRIVATE_KEY = Deno.env.get("EMAILJS_PRIVATE_KEY") ?? "";
const EMAILJS_SERVICE = Deno.env.get("EMAILJS_SERVICE") ?? "";
const EMAILJS_SHOP_TEMPLATE = Deno.env.get("EMAILJS_SHOP_TEMPLATE") ?? "";
const SHOP_ADMIN_EMAIL = Deno.env.get("SHOP_ADMIN_EMAIL") ?? "";

export const DOCUMENT_BUCKET = "shop-documents";

export const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

export const EMAIL_REGEX = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// ---------------------------------------------------------------------------
// HTTP-hulpjes
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ??
    `${BASE_URL},https://www.jufvalerie.be,https://jufvalerie.be`)
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get("origin") ?? "";
    return {
        "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

export function json(data: unknown, status = 200, headers?: Record<string, string>) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

export function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

export function euro(n: number | string): string {
    return "€ " + Number(n || 0).toFixed(2).replace(".", ",");
}

export function formatDate(d: string): string {
    const [y, m, day] = String(d ?? "").slice(0, 10).split("-");
    return day ? `${day}/${m}/${y}` : String(d ?? "");
}

export function escapeHtml(s: unknown): string {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Settings = {
    business_name: string;
    business_email: string;
    pickup_info: string;
    lead_time_text: string;
    [k: string]: unknown;
};

export type Order = {
    id: string;
    order_number: string;
    public_token: string;
    customer_name: string;
    email: string;
    phone: string | null;
    company_name: string | null;
    delivery_method: "pickup" | "shipping";
    street: string | null;
    postal_code: string | null;
    city: string | null;
    country: string;
    customer_note: string | null;
    subtotal: number;
    shipping_cost: number;
    discount_code: string | null;
    discount_amount: number;
    total: number;
    payment_status: string;
    order_status: string;
    tracking_code: string | null;
    mollie_payment_id: string | null;
    created_at: string;
};

export type DocLine = {
    description: string;
    quantity: number;
    unit_price: number;
    line_total: number;
};

export type Invoice = {
    id: string;
    invoice_number: string;
    invoice_date: string;
    order_id: string;
    seller: Record<string, string>;
    customer: Record<string, string>;
    lines: DocLine[];
    subtotal: number;
    shipping_cost: number;
    discount_code: string | null;
    discount_amount: number;
    total: number;
    vat_note: string;
    payment_note: string;
    status: string;
    pdf_path: string | null;
};

export type CreditNote = {
    id: string;
    credit_number: string;
    credit_date: string;
    invoice_id: string;
    reason: string;
    lines: DocLine[];
    total: number;
    mollie_refund_id: string | null;
    pdf_path: string | null;
};

export async function getSettings(): Promise<Settings> {
    const { data, error } = await sb.from("shop_settings").select("*").eq("id", 1).single();
    if (error) throw error;
    return data as Settings;
}

export async function getOrderItems(orderId: string) {
    const { data, error } = await sb
        .from("shop_order_items")
        .select("product_name, unit_price, quantity, line_total")
        .eq("order_id", orderId)
        .order("id");
    if (error) throw error;
    return data ?? [];
}

// ---------------------------------------------------------------------------
// Mail (EmailJS, één generieke template)
// ---------------------------------------------------------------------------
// Maak in EmailJS één template aan met:
//   To Email : {{to_email}}
//   Subject  : {{subject}}
//   Content  : {{{message_html}}}      (drie accolades = HTML toegelaten)
//   Reply To : {{reply_to}}
export async function sendShopEmail(
    to: string,
    subject: string,
    messageHtml: string,
    replyTo = "",
): Promise<boolean> {
    if (!EMAILJS_SHOP_TEMPLATE || !to) {
        console.error("Geen EMAILJS_SHOP_TEMPLATE of ontvanger; mail niet verstuurd.");
        return false;
    }
    const body: Record<string, unknown> = {
        service_id: EMAILJS_SERVICE,
        template_id: EMAILJS_SHOP_TEMPLATE,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: {
            to_email: to,
            subject,
            message_html: messageHtml,
            reply_to: replyTo,
        },
    };
    if (EMAILJS_PRIVATE_KEY) body.accessToken = EMAILJS_PRIVATE_KEY;

    try {
        const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            console.error(`EmailJS-fout (${res.status}):`, await res.text());
            return false;
        }
        return true;
    } catch (err) {
        console.error("EmailJS-uitzondering:", err);
        return false;
    }
}

export function documentLink(order: Pick<Order, "id" | "public_token">, doc: "invoice" | "credit", docId?: string) {
    const p = new URLSearchParams({ order: order.id, token: order.public_token, doc });
    if (docId) p.set("id", docId);
    return `${SUPABASE_URL}/functions/v1/shop-document?${p.toString()}`;
}

function itemsTableHtml(items: { product_name: string; quantity: number; line_total: number }[]) {
    return `<table style="border-collapse:collapse;width:100%;max-width:520px">` +
        items.map((i) =>
            `<tr><td style="padding:4px 8px 4px 0">${i.quantity} × ${escapeHtml(i.product_name)}</td>` +
            `<td style="padding:4px 0;text-align:right">${euro(i.line_total)}</td></tr>`
        ).join("") +
        `</table>`;
}

function discountHtml(order: Order) {
    const amount = Number(order.discount_amount ?? 0);
    if (!(amount > 0)) return "";
    return `<p>Korting${order.discount_code ? ` (${escapeHtml(order.discount_code)})` : ""}: -${euro(amount)}</p>`;
}

function deliveryHtml(order: Order, settings: Settings) {
    if (order.delivery_method === "pickup") {
        return `<p><strong>Afhalen</strong><br>${escapeHtml(settings.pickup_info)}</p>`;
    }
    return `<p><strong>Levering op</strong><br>${escapeHtml(order.customer_name)}<br>` +
        `${escapeHtml(order.street)}<br>${escapeHtml(order.postal_code)} ${escapeHtml(order.city)}<br>` +
        `${escapeHtml(order.country === "NL" ? "Nederland" : "België")}</p>`;
}

export async function sendOrderConfirmation(order: Order, invoice: Invoice | null) {
    const settings = await getSettings();
    const items = await getOrderItems(order.id);

    const invoicePart = invoice
        ? `<p>Je factuur <strong>${escapeHtml(invoice.invoice_number)}</strong> kan je hier downloaden:<br>` +
          `<a href="${documentLink(order, "invoice")}">Factuur downloaden (pdf)</a></p>`
        : `<p>Je factuur volgt in een aparte mail.</p>`;

    const html =
        `<p>Dag ${escapeHtml(order.customer_name)},</p>` +
        `<p>Bedankt voor je bestelling <strong>${escapeHtml(order.order_number)}</strong>! ` +
        `We hebben je betaling goed ontvangen.</p>` +
        itemsTableHtml(items) +
        discountHtml(order) +
        `<p>Verzending: ${euro(order.shipping_cost)}<br><strong>Totaal: ${euro(order.total)}</strong></p>` +
        deliveryHtml(order, settings) +
        `<p>${escapeHtml(settings.lead_time_text)}</p>` +
        invoicePart +
        `<p>Liefs,<br>${escapeHtml(settings.business_name)}</p>`;

    await sendShopEmail(
        order.email,
        `Bevestiging bestelling ${order.order_number}`,
        html,
        settings.business_email,
    );

    const adminTo = SHOP_ADMIN_EMAIL || settings.business_email;
    if (adminTo) {
        const adminHtml =
            `<p>Nieuwe betaalde webshopbestelling <strong>${escapeHtml(order.order_number)}</strong></p>` +
            `<p>${escapeHtml(order.customer_name)} – ${escapeHtml(order.email)}` +
            `${order.phone ? " – " + escapeHtml(order.phone) : ""}</p>` +
            itemsTableHtml(items) +
            discountHtml(order) +
            `<p><strong>Totaal: ${euro(order.total)}</strong></p>` +
            deliveryHtml(order, settings) +
            (order.customer_note ? `<p>Opmerking klant: ${escapeHtml(order.customer_note)}</p>` : "") +
            `<p><a href="${BASE_URL}/shop/admin.html">Open de webshop-admin</a></p>`;
        await sendShopEmail(adminTo, `🛒 Nieuwe bestelling ${order.order_number}`, adminHtml, order.email);
    }
}

export async function sendStatusEmail(order: Order, status: string) {
    const settings = await getSettings();
    let subject = "";
    let body = "";

    if (status === "in_production") {
        subject = `We zijn gestart met je bestelling ${order.order_number}`;
        body = `<p>Goed nieuws: we zijn begonnen met het maken van je bestelling.</p>`;
    } else if (status === "ready_for_pickup") {
        subject = `Je bestelling ${order.order_number} staat klaar`;
        body = `<p>Je bestelling staat klaar om af te halen.</p><p>${escapeHtml(settings.pickup_info)}</p>`;
    } else if (status === "shipped") {
        subject = `Je bestelling ${order.order_number} is verzonden`;
        body = `<p>Je bestelling is onderweg!</p>` +
            (order.tracking_code
                ? `<p>Track &amp; trace: <strong>${escapeHtml(order.tracking_code)}</strong></p>`
                : "");
    } else if (status === "cancelled") {
        subject = `Je bestelling ${order.order_number} is geannuleerd`;
        body = `<p>Je bestelling werd geannuleerd. Heb je al betaald, dan ontvang je het bedrag terug.</p>`;
    } else {
        return;
    }

    await sendShopEmail(
        order.email,
        subject,
        `<p>Dag ${escapeHtml(order.customer_name)},</p>${body}` +
            `<p>Liefs,<br>${escapeHtml(settings.business_name)}</p>`,
        settings.business_email,
    );
}

// ---------------------------------------------------------------------------
// PDF (factuur / creditnota)
// ---------------------------------------------------------------------------
// De standaardfonts van pdf-lib ondersteunen enkel WinAnsi (Latijn, €, é, ...).
// Andere tekens (emoji, ...) worden vervangen zodat de pdf nooit faalt.
function winAnsi(s: unknown): string {
    return String(s ?? "")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/\u2013|\u2014/g, "-")
        .replace(/\u00A0/g, " ")
        .replace(/[^\x0A\x20-\x7E\u00A0-\u00FF\u20AC]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const out: string[] = [];
    for (const paragraph of winAnsi(text).split(/\n/)) {
        let line = "";
        for (const word of paragraph.split(/\s+/)) {
            const test = line ? `${line} ${word}` : word;
            if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
                out.push(line);
                line = word;
            } else {
                line = test;
            }
        }
        out.push(line);
    }
    return out;
}

type PdfInput = {
    title: string;            // "FACTUUR" / "CREDITNOTA"
    number: string;
    date: string;
    reference: string[];      // extra regels onder nummer/datum
    seller: Record<string, string>;
    customer: Record<string, string>;
    lines: DocLine[];
    totals: [string, number][];
    notes: string[];
};

export async function buildPdf(input: PdfInput): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    doc.setTitle(`${input.title} ${input.number}`);
    doc.setAuthor(winAnsi(input.seller.name));

    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const accent = rgb(1, 0.435, 0.525);  // #ff6f86
    const grey = rgb(0.35, 0.35, 0.35);

    let page: PDFPage = doc.addPage([595.28, 841.89]); // A4
    const left = 50;
    const right = 545;
    let y = 790;

    const text = (t: string, x: number, yy: number, size = 10, f = font, color = rgb(0, 0, 0)) =>
        page.drawText(winAnsi(t), { x, y: yy, size, font: f, color });
    const textRight = (t: string, xr: number, yy: number, size = 10, f = font) =>
        text(t, xr - f.widthOfTextAtSize(winAnsi(t), size), yy, size, f);

    // Kop: verkoper links, titel rechts
    text(input.seller.name || "", left, y, 16, bold, accent);
    textRight(input.title, right, y, 18, bold);
    y -= 18;
    const sellerLines = [
        ...String(input.seller.address || "").split(/\n|,\s*/),
        input.seller.enterprise_number ? `Ondernemingsnr.: ${input.seller.enterprise_number}` : "",
        input.seller.iban ? `IBAN: ${input.seller.iban}` : "",
        input.seller.email || "",
        input.seller.phone || "",
    ].filter(Boolean);
    let ys = y;
    for (const l of sellerLines) {
        text(l, left, ys, 9, font, grey);
        ys -= 12;
    }
    let yr = y;
    textRight(`Nummer: ${input.number}`, right, yr, 10, bold);
    yr -= 13;
    textRight(`Datum: ${formatDate(input.date)}`, right, yr);
    for (const r of input.reference) {
        yr -= 13;
        textRight(r, right, yr);
    }
    y = Math.min(ys, yr) - 25;

    // Klant
    text("Aan", left, y, 9, bold, grey);
    y -= 14;
    const c = input.customer;
    const customerLines = [
        c.company_name || "",
        c.name || "",
        c.company_vat ? `Btw/ondernemingsnr.: ${c.company_vat}` : "",
        c.street || "",
        [c.postal_code, c.city].filter(Boolean).join(" "),
        c.street ? (c.country === "NL" ? "Nederland" : "België") : "",
        c.email || "",
    ].filter(Boolean);
    for (const l of customerLines) {
        text(l, left, y, 10);
        y -= 13;
    }
    y -= 15;

    // Tabelkop
    const colQty = 360, colPrice = 450, colTotal = right;
    page.drawRectangle({ x: left - 5, y: y - 5, width: right - left + 10, height: 20, color: rgb(1, 0.93, 0.945) });
    text("Omschrijving", left, y, 10, bold);
    textRight("Aantal", colQty + 30, y, 10, bold);
    textRight("Prijs", colPrice + 30, y, 10, bold);
    textRight("Totaal", colTotal, y, 10, bold);
    y -= 22;

    for (const line of input.lines) {
        const descLines = wrap(line.description, font, 10, colQty - left - 50);
        if (y - descLines.length * 13 < 140) {
            page = doc.addPage([595.28, 841.89]);
            y = 790;
        }
        textRight(String(line.quantity), colQty + 30, y);
        textRight(euro(line.unit_price), colPrice + 30, y);
        textRight(euro(line.line_total), colTotal, y);
        for (const dl of descLines) {
            text(dl, left, y);
            y -= 13;
        }
        y -= 4;
    }

    page.drawLine({ start: { x: colPrice - 60, y: y + 4 }, end: { x: right, y: y + 4 }, thickness: 0.7, color: grey });
    y -= 12;
    input.totals.forEach(([label, value], idx) => {
        const last = idx === input.totals.length - 1;
        textRight(label, colPrice + 30, y, last ? 11 : 10, last ? bold : font);
        textRight(euro(value), colTotal, y, last ? 11 : 10, last ? bold : font);
        y -= last ? 16 : 13;
    });
    y -= 20;

    for (const n of input.notes.filter(Boolean)) {
        for (const l of wrap(n, font, 9, right - left)) {
            if (y < 60) {
                page = doc.addPage([595.28, 841.89]);
                y = 790;
            }
            text(l, left, y, 9, font, grey);
            y -= 12;
        }
        y -= 6;
    }

    return await doc.save();
}

async function uploadPdf(path: string, bytes: Uint8Array) {
    const { error } = await sb.storage.from(DOCUMENT_BUCKET).upload(path, bytes, {
        contentType: "application/pdf",
        upsert: true,
    });
    if (error) throw error;
}

export async function renderInvoicePdf(invoice: Invoice): Promise<Uint8Array> {
    const totals: [string, number][] = [["Subtotaal", Number(invoice.subtotal)]];
    const discount = Number(invoice.discount_amount ?? 0);
    if (discount > 0) {
        totals.push([`Korting${invoice.discount_code ? ` (${invoice.discount_code})` : ""}`, -discount]);
    }
    if (Number(invoice.shipping_cost) > 0 || invoice.customer.delivery === "shipping") {
        totals.push(["Verzending", Number(invoice.shipping_cost)]);
    }
    totals.push(["Totaal", Number(invoice.total)]);

    return await buildPdf({
        title: "FACTUUR",
        number: invoice.invoice_number,
        date: invoice.invoice_date,
        reference: [`Bestelling: ${invoice.customer.order_number ?? ""}`],
        seller: invoice.seller,
        customer: invoice.customer,
        lines: invoice.lines,
        totals,
        notes: [invoice.vat_note, invoice.payment_note, invoice.seller.footer ?? ""],
    });
}

export async function renderCreditPdf(note: CreditNote, invoice: Invoice): Promise<Uint8Array> {
    return await buildPdf({
        title: "CREDITNOTA",
        number: note.credit_number,
        date: note.credit_date,
        reference: [
            `Betreft factuur: ${invoice.invoice_number}`,
            `van ${formatDate(invoice.invoice_date)}`,
        ],
        seller: invoice.seller,
        customer: invoice.customer,
        lines: note.lines,
        totals: [["Totaal gecrediteerd", Number(note.total)]],
        notes: [`Reden: ${note.reason}`, invoice.vat_note],
    });
}

/**
 * Maakt (indien nodig) de factuur en de pdf aan voor een betaalde bestelling.
 * Idempotent: een tweede aanroep geeft dezelfde factuur terug.
 */
export async function ensureInvoice(orderId: string): Promise<Invoice> {
    const { data, error } = await sb.rpc("shop_create_invoice", { p_order_id: orderId });
    if (error) throw error;
    const invoice = (Array.isArray(data) ? data[0] : data) as Invoice;

    if (!invoice.pdf_path) {
        const bytes = await renderInvoicePdf(invoice);
        const path = `invoices/${invoice.invoice_number.slice(1, 5)}/${invoice.invoice_number}.pdf`;
        await uploadPdf(path, bytes);
        const { error: upd } = await sb.from("shop_invoices").update({ pdf_path: path }).eq("id", invoice.id);
        if (upd) throw upd;
        invoice.pdf_path = path;
    }

    await sb.from("shop_orders").update({ invoice_error: null }).eq("id", orderId);
    return invoice;
}

export async function ensureCreditPdf(note: CreditNote): Promise<CreditNote> {
    if (note.pdf_path) return note;
    const { data: invoice, error } = await sb.from("shop_invoices").select("*").eq("id", note.invoice_id).single();
    if (error) throw error;
    const bytes = await renderCreditPdf(note, invoice as Invoice);
    const path = `credit-notes/${note.credit_number.slice(2, 6)}/${note.credit_number}.pdf`;
    await uploadPdf(path, bytes);
    const { error: upd } = await sb.from("shop_credit_notes").update({ pdf_path: path }).eq("id", note.id);
    if (upd) throw upd;
    note.pdf_path = path;
    return note;
}

// ---------------------------------------------------------------------------
// Mollie
// ---------------------------------------------------------------------------
export async function mollie(path: string, init: RequestInit = {}) {
    const res = await fetch(`https://api.mollie.com/v2${path}`, {
        ...init,
        headers: {
            "Authorization": `Bearer ${MOLLIE_API_KEY}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            ...(init.headers ?? {}),
        },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}
