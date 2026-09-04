// ============================================================================
// mollie-webhook — Supabase Edge Function (Deno)
// ============================================================================
//
// Doel:
//   Mollie verstuurt een webhook bij elke betalingsstatuswijziging.
//   Deze functie:
//    1. Vraagt de status opnieuw op bij Mollie (server-side verificatie!)
//       → zo kan niemand zomaar een neppe webhook sturen die betalingen
//         als 'betaald' markeert.
//    2. Werkt payment_status van de bijbehorende inschrijving bij.
//    3. Verstuurt (enkel bij succesvolle betaling) de bevestigingsmail naar
//       de klant en de meldingsmail naar de beheerder via EmailJS.
//
// Vereiste environment variabelen (Supabase → Edge Functions → Secrets):
//   MOLLIE_API_KEY                      -> dezelfde sleutel als bij create-mollie-payment
//   EMAILJS_PUBLIC_KEY                  -> "ryf0HAbDqTzY368PW"
//   EMAILJS_PRIVATE_KEY                 -> Private Key uit Account → Security (enkel nodig
//                                         als "Use Private Key" of "Allow EmailJS API for
//                                         non-browser applications" aanstaat)
//   EMAILJS_SERVICE                     -> "service_9u8ex4o"
//   EMAILJS_CONFIRMATION_TEMPLATE       -> "template_m20bheg"
//   EMAILJS_ADMIN_TEMPLATE              -> "template_nndh15x"

// Opgelet: de EmailJS-webhook-functie verstuurt de mails SERVER-SIDE
// (non-browser). Daarvoor moet in het EmailJS-dashboard (Account → Security)
// minimaal "Allow EmailJS API for non-browser applications" aangevinkt zijn,
// anders antwoordt EmailJS met "403 API access in strict mode".
//
// Deploy:
//   supabase functions deploy mollie-webhook
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MOLLIE_API_KEY = Deno.env.get("MOLLIE_API_KEY")!;

const EMAILJS_PUBLIC_KEY = Deno.env.get("EMAILJS_PUBLIC_KEY") ?? "";
const EMAILJS_PRIVATE_KEY = Deno.env.get("EMAILJS_PRIVATE_KEY") ?? "";
const EMAILJS_SERVICE = Deno.env.get("EMAILJS_SERVICE") ?? "";
const EMAILJS_CONFIRMATION_TEMPLATE =
    Deno.env.get("EMAILJS_CONFIRMATION_TEMPLATE") ?? "";
const EMAILJS_ADMIN_TEMPLATE =
    Deno.env.get("EMAILJS_ADMIN_TEMPLATE") ?? "";

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// Mollie => de statussen die wij gebruiken in de DB.
const STATUS_MAP: Record<string, string> = {
    open: "pending",
    pending: "pending",
    authorized: "pending",
    paid: "paid",
    paidout: "paid",
    completed: "paid",
    canceled: "cancelled",
    cancelled: "cancelled",
    expired: "expired",
    failed: "failed",
};

function sendEmail(templateId: string, params: Record<string, unknown>) {
    const body: Record<string, unknown> = {
        service_id: EMAILJS_SERVICE,
        template_id: templateId,
        user_id: EMAILJS_PUBLIC_KEY,
        template_params: params,
    };
    if (EMAILJS_PRIVATE_KEY) {
        body.accessToken = EMAILJS_PRIVATE_KEY;
    }
    return fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function formatDate(dateString: string): string {
    const [y, m, d] = dateString.split("-");
    return `${d}/${m}/${y}`;
}

Deno.serve(async (req: Request) => {
    if (req.method !== "POST") {
        return new Response("nok", { status: 405 });
    }

    // ------------------------------------------------------------------
    // 1. Mollie verstuurt enkel het payment-ID in de body: { "id": "tr_..." }
    // ------------------------------------------------------------------
    let paymentId: string;
    try {
        const body = await req.json();
        paymentId = String(body.id ?? "");
    } catch {
        return new Response("nok", { status: 400 });
    }

    if (!paymentId.startsWith("tr_")) {
        return new Response("nok", { status: 400 });
    }

    // ------------------------------------------------------------------
    // 2. Status OPnieuw ophalen bij Mollie (authenticatie van de webhook)
    //    Als Mollie het payment niet kent, is dit een vervalste webhook.
    // ------------------------------------------------------------------
    const mollieResponse = await fetch(
        `https://api.mollie.com/v2/payments/${paymentId}`,
        {
            headers: {
                "Authorization": `Bearer ${MOLLIE_API_KEY}`,
                "Accept": "application/json",
            },
        },
    );

    if (!mollieResponse.ok) {
        console.error("Mollie status check mislukt:", mollieResponse.status);
        return new Response("nok", { status: 502 });
    }

    const payment = await mollieResponse.json();
    const mollieStatus = String(payment.status ?? "");
    const dbStatus = STATUS_MAP[mollieStatus] ?? "pending";

    const metadata = payment.metadata ?? {};
    const bookingId = metadata.booking_id ?? payment.booking_id ?? "";

    // ------------------------------------------------------------------
    // 3. De inschrijving ophalen (via mollie_payment_id of booking_id)
    // ------------------------------------------------------------------
    let query = sb.from("appointments").select("*");
    if (paymentId) {
        query = query.eq("mollie_payment_id", paymentId);
    }
    if (bookingId) {
        query = query.eq("id", bookingId);
    }
    const { data: booking, error: findError } = await query.maybeSingle();

    if (findError || !booking) {
        console.error("Booking niet gevonden:", { paymentId, bookingId, findError });
        return new Response("nok", { status: 404 });
    }

    // ------------------------------------------------------------------
    // 4. Status bijwerken + Mollie-payment-ID verzekeren
    // ------------------------------------------------------------------
    const payload: Record<string, unknown> = {
        payment_status: dbStatus,
    };
    if (!booking.mollie_payment_id) {
        payload.mollie_payment_id = paymentId;
    }

    const { error: updateError } = await sb
        .from("appointments")
        .update(payload)
        .eq("id", booking.id);

    if (updateError) {
        console.error("Status update mislukt:", updateError);
        return new Response("nok", { status: 500 });
    }

    // ------------------------------------------------------------------
    // 5. Emails enkel bij succesvolle betaling
    // ------------------------------------------------------------------
    if (dbStatus === "paid") {
        const children = [
            booking.child1,
            booking.child2,
            booking.child3,
            booking.child4,
        ].filter(Boolean);

        const childNamesText = children
            .map((c, i) => `Kind ${i + 1}: ${c}`)
            .join("\n");

        // Klant: bevestigingsmail
        await sendEmail(EMAILJS_CONFIRMATION_TEMPLATE, {
            name: booking.name,
            email: booking.email,
            date: formatDate(booking.appointment_date),
            children_count: booking.children_count,
            child_names: childNamesText,
            child1: booking.child1 ?? "",
            child2: booking.child2 ?? "",
            child3: booking.child3 ?? "",
            child4: booking.child4 ?? "",
            amount: Number(booking.amount || 0).toFixed(2).replace(".", ","),
            payment_method: "Online betaling via Mollie",
        });

        // Beheerder: meldingsmail
        await sendEmail(EMAILJS_ADMIN_TEMPLATE, {
            name: booking.name,
            email: booking.email,
            date: formatDate(booking.appointment_date),
            children_count: booking.children_count,
            child_names: childNamesText,
            amount: Number(booking.amount || 0).toFixed(2).replace(".", ","),
            payment_method: "Online betaling via Mollie",
        });
    }

    return new Response("ok", { status: 200 });
});