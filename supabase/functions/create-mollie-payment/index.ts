// ============================================================================
// create-mollie-payment — Supabase Edge Function (Deno)
// ============================================================================
//
// Doel:
//   Online inschrijving + Mollie-betaallink volledig server-side aanmaken.
//   Het bedrag wordt HIER herberekend en de clientwaarde ('amount') wordt
//   bewust IGNOREERD. Zo kan niemand onderbetalen door de browser te
//   manipuleren.
//
// Aanroep (vanuit index.html):
//   sb.functions.invoke("create-mollie-payment", { body: {
//       appointment_date, name, email, children_count,
//       children: [{ name, photo_allowed }], payment_method
//   }})
//
// Antwoord:
//   { checkoutUrl, paymentId, bookingId }
//
// Vereiste environment variabelen (Supabase → Edge Functions → Secrets):
//   MOLLIE_API_KEY             -> live/test Mollie API-sleutel
//   BASE_URL                   -> https://jufvalerie.be
//   MAX_CHILDREN               -> 12  (optioneel, default 12)
//
// Deploy:
//   supabase functions deploy create-mollie-payment
// ============================================================================

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MOLLIE_API_KEY = Deno.env.get("MOLLIE_API_KEY")!;
const BASE_URL = (Deno.env.get("BASE_URL") ?? "https://jufvalerie.be")
    .replace(/\/+$/, "");
const MAX_CHILDREN = Number(Deno.env.get("MAX_CHILDREN") ?? 12);

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
});

// Prijzen — houd deze gelijk met index.html en de SQL-trigger.
const PRICE_FIRST = 18;
const PRICE_EXTRA = 15;
const TRANSACTION_FEE_ONLINE = 0.40;

const EMAIL_REGEX =
    /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

function corsHeaders(req: Request) {
    const origin = req.headers.get("origin") ?? "*";
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers":
            "authorization, x-client-info, apikey, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
}

function json(data: unknown, status = 200, headers?: Record<string, string>) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...headers },
    });
}

function calculateAmount(childrenCount: number, isOnline: boolean): number {
    let amount =
        PRICE_FIRST +
        Math.max(0, childrenCount - 1) * PRICE_EXTRA;
    if (isOnline) {
        amount += TRANSACTION_FEE_ONLINE;
    }
    return Math.round(amount * 100) / 100;
}

async function isDateBlocked(date: string): Promise<boolean> {
    const { data } = await sb
        .from("blocked_dates")
        .select("date")
        .eq("date", date)
        .maybeSingle();
    return Boolean(data?.date);
}

async function themeExists(date: string): Promise<boolean> {
    const { data } = await sb
        .from("themes")
        .select("theme")
        .eq("date", date)
        .maybeSingle();
    return Boolean(data?.theme);
}

async function getBookedChildren(date: string): Promise<number> {
    const { data } = await sb
        .from("appointments")
        .select("children_count")
        .eq("appointment_date", date)
        .not("payment_status", "in", "(\"cancelled\",\"failed\",\"expired\")");
    return (data ?? []).reduce(
        (sum, row) => sum + Number(row.children_count || 0),
        0,
    );
}

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders(req) });
    }
    if (req.method !== "POST") {
        return json({ error: "method_not_allowed" }, 405, corsHeaders(req));
    }

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return json({ error: "Ongeldige JSON." }, 400, corsHeaders(req));
    }

    const headers = corsHeaders(req);

    // ------------------------------------------------------------------
    // 1. Invoer uitpakken en basiscontroles
    // ------------------------------------------------------------------
    const appointmentDate = String(body.appointment_date ?? "").trim();
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim();
    const childrenCount = Number(body.children_count);
    const paymentMethod = String(body.payment_method ?? "onsite");
    const children = Array.isArray(body.children)
        ? body.children.map((c: Record<string, unknown>) => ({
            name: String(c?.name ?? "").trim(),
            photo_allowed: Boolean(c?.photo_allowed),
        }))
        : [];

    if (!appointmentDate) {
        return json({ error: "Datum ontbreekt." }, 400, headers);
    }
    if (!name || name.length > 100) {
        return json({ error: "Naam ontbreekt of is te lang." }, 400, headers);
    }
    if (!EMAIL_REGEX.test(email) || email.length > 254) {
        return json({ error: "Ongeldig e-mailadres." }, 400, headers);
    }
    if (!Number.isInteger(childrenCount) || childrenCount < 1 || childrenCount > 4) {
        return json({ error: "Ongeldig aantal kinderen (1-4)." }, 400, headers);
    }
    if (children.length !== childrenCount) {
        return json({ error: "Geef voor elk kind een naam en optioneel foto-toestemming op." }, 400, headers);
    }
    if (children.some((c) => !c.name)) {
        return json({ error: "Geef voor elk kind een naam op." }, 400, headers);
    }

    // ------------------------------------------------------------------
    // 2. Datumcontroles (zaterdag + niet in het verleden)
    // ------------------------------------------------------------------
    const dateObj = new Date(appointmentDate + "T12:00:00");
    if (isNaN(dateObj.getTime())) {
        return json({ error: "Ongeldige datum." }, 400, headers);
    }
    if (dateObj.getDay() !== 6) {
        return json({ error: "Alleen zaterdagen zijn toegestaan." }, 400, headers);
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dateObj < today) {
        return json({ error: "Deze datum ligt in het verleden." }, 400, headers);
    }

    // ------------------------------------------------------------------
    // 3. Blokkades & thema
    // ------------------------------------------------------------------
    if (await isDateBlocked(appointmentDate)) {
        return json({ error: "Deze datum is geblokkeerd." }, 400, headers);
    }
    if (!(await themeExists(appointmentDate))) {
        return json({ error: "Voor deze datum is geen sessie gepland." }, 400, headers);
    }

    // ------------------------------------------------------------------
    // 4. Capaciteit (max. MAX_CHILDREN per sessie)
    // ------------------------------------------------------------------
    const booked = await getBookedChildren(appointmentDate);
    if (booked + childrenCount > MAX_CHILDREN) {
        const free = Math.max(0, MAX_CHILDREN - booked);
        return json(
            { error: `Nog ${free} plaats(en) beschikbaar voor deze sessie.` },
            409,
            headers,
        );
    }

    // ------------------------------------------------------------------
    // 5. Bedrag server-side berekenen (clientwaarde wordt genegeerd)
    // ------------------------------------------------------------------
    const isOnline = paymentMethod === "online";
    const amount = calculateAmount(childrenCount, isOnline);

    // ------------------------------------------------------------------
    // 6. Inschrijving opslaan (service role → RLS wordt niet toegepast,
    //    de SQL-trigger rekent het bedrag alsnog zelf na).
    // ------------------------------------------------------------------
    const { data: booking, error: insertError } = await sb
        .from("appointments")
        .insert({
            appointment_date: appointmentDate,
            name,
            email,
            children_count: childrenCount,
            amount,
            payment_method: paymentMethod,
            payment_status: "pending",
        })
        .select("id")
        .single();

    if (insertError || !booking) {
        console.error("Booking insert error:", insertError);
        return json(
            { error: insertError?.message ?? "De inschrijving kon niet worden opgeslagen." },
            500,
            headers,
        );
    }
    const bookingId = booking.id;

    // Kinderen opslaan (per kind een rij met naam + foto-toestemming).
    const childRows = children.map((c) => ({
        appointment_id: bookingId,
        name: c.name,
        photo_allowed: c.photo_allowed,
    }));
    const { error: childrenError } = await sb
        .from("children")
        .insert(childRows);

    if (childrenError) {
        console.error("Children insert error:", childrenError);
        await sb
            .from("appointments")
            .update({ payment_status: "cancelled" })
            .eq("id", bookingId);
        return json(
            { error: "De kindgegevens konden niet worden opgeslagen. Probeer opnieuw." },
            500,
            headers,
        );
    }

    // ------------------------------------------------------------------
    // 7. Mollie-betaling aanmaken
    // ------------------------------------------------------------------
    const mollieBody = {
        amount: { currency: "EUR", value: amount.toFixed(2) },
        description: `Speelatelier ${appointmentDate} – ${name}`,
        redirectUrl: `${BASE_URL}/index.html?payment=return&booking=${bookingId}`,
        webhookUrl: `${SUPABASE_URL}/functions/v1/mollie-webhook`,
        metadata: {
            booking_id: bookingId,
            appointment_date: appointmentDate,
        },
    };

    const mollieResponse = await fetch(
        "https://api.mollie.com/v2/payments",
        {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${MOLLIE_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(mollieBody),
        },
    );

    const mollieData = await mollieResponse.json().catch(() => ({}));

    // Mollie geeft de betaal-URL terug in `_links.checkout.href`,
    // niet als top-level `checkoutUrl`-veld.
    const checkoutHref = String(mollieData._links?.checkout?.href ?? "");

    if (!mollieResponse.ok || !mollieData.id || !checkoutHref) {
        console.error("Mollie error:", mollieData);

        // Vrijgekomen plaats terugvrijgeven
        await sb
            .from("appointments")
            .update({ payment_status: "cancelled" })
            .eq("id", bookingId);

        return json(
            { error: "De betaalpagina kon niet worden aangemaakt. Probeer opnieuw." },
            502,
            headers,
        );
    }

    // ------------------------------------------------------------------
    // 8. Mollie-payment-ID koppelen aan de inschrijving
    //    De webhook zoekt de inschrijving primair via booking_id uit de
    //    metadata, dus deze koppeling is niet kritiek voor het verwerken
    //    van de betaling, maar blijft nuttig voor de admin om te zoeken.
    // ------------------------------------------------------------------
    const { error: linkError } = await sb
        .from("appointments")
        .update({ mollie_payment_id: mollieData.id })
        .eq("id", bookingId);

    if (linkError) {
        console.error("Mollie payment id koppelen mislukt:", linkError);
    }

    // ------------------------------------------------------------------
    // 9. Antwoord aan index.html
    // ------------------------------------------------------------------
    return json({
        checkoutUrl: checkoutHref,
        paymentId: mollieData.id,
        bookingId,
        amount,
    }, 200, headers);
});