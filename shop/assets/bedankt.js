/* =========================================================
   Webshop – terugkeer van Mollie
========================================================= */

(function () {
    "use strict";

    const S = window.SHOP;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    function show(html) {
        document.getElementById("result").innerHTML = html;
    }

    async function fetchStatus(orderId, token) {
        const { data, error } = await S.sb.rpc("shop_order_public_status", {
            p_order_id: orderId,
            p_token: token
        });
        if (error) throw error;
        return Array.isArray(data) ? data[0] : data;
    }

    async function run() {
        const p = new URLSearchParams(location.search);
        const orderId = p.get("order") || "";
        const token = p.get("token") || "";

        if (!UUID.test(orderId) || !UUID.test(token)) {
            show("<h1>Bestelling niet gevonden</h1><p>Deze link is ongeldig.</p>" +
                '<p><a class="btn" href="./">Naar de webshop</a></p>');
            return;
        }

        // De webhook van Mollie kan enkele seconden later binnenkomen.
        let order = null;
        for (let i = 0; i < 8; i++) {
            try {
                order = await fetchStatus(orderId, token);
            } catch (e) {
                order = null;
            }
            if (order && order.payment_status !== "pending") break;
            await new Promise(function (r) { setTimeout(r, 2000); });
        }

        if (!order) {
            show("<h1>Bestelling niet gevonden</h1>" +
                "<p>We konden je bestelling niet terugvinden. Neem gerust contact met ons op.</p>");
            return;
        }

        const nr = S.escapeHtml(order.order_number);
        const pickup = order.delivery_method === "pickup";
        const summary = '<div class="order-summary">' +
            "<span>Bestelling</span><strong>" + nr + "</strong>" +
            "<span>Bedrag</span><strong>" + S.euro(order.total) + "</strong>" +
            "<span>Levering</span><strong>" + (pickup ? "🏠 Afhalen" : "📦 Verzenden") + "</strong></div>";

        if (order.payment_status === "paid") {
            S.clearCart();
            sessionStorage.removeItem("kww_shop_pending");
            const steps = [
                ["Besteld", true],
                ["Betaald", true],
                ["In productie", ["in_production", "ready_for_pickup", "shipped", "completed"].includes(order.order_status)],
                [pickup ? "Klaar om af te halen" : "Verzonden", ["ready_for_pickup", "shipped", "completed"].includes(order.order_status)]
            ];
            show('<div class="status-icon">🎉</div>' +
                "<h1>Bedankt voor je bestelling!</h1>" +
                "<p>Je betaling is goed ontvangen. Je krijgt zo dadelijk een bevestigingsmail met je factuur.</p>" +
                summary +
                '<ol class="timeline" aria-label="Status van je bestelling">' + steps.map(function (s) {
                    return '<li class="' + (s[1] ? "done" : "") + '"><span class="dot">' + (s[1] ? "✓" : "") + "</span>" + s[0] + "</li>";
                }).join("") + "</ol>" +
                "<p>" + (pickup
                    ? "We laten je weten wanneer je bestelling klaarstaat om af te halen."
                    : "We laten je weten wanneer je bestelling verzonden is.") + "</p>" +
                '<p style="margin-top:14px"><a class="btn" href="./">Verder winkelen</a> <a class="btn secondary" href="../">Naar het speelatelier</a></p>');
            S.confetti(140);
        } else if (order.payment_status === "pending") {
            show('<div class="status-icon wait">⏳</div>' +
                "<h1>Betaling wordt verwerkt</h1>" +
                "<p>Je betaling is nog niet bevestigd. Dit kan enkele minuten duren. " +
                "Je krijgt een mail zodra de betaling binnen is.</p>" + summary +
                '<p><button class="btn secondary" type="button" id="retry">Opnieuw controleren</button></p>');
            document.getElementById("retry").addEventListener("click", function () { location.reload(); });
        } else {
            show('<div class="status-icon fail">😕</div>' +
                "<h1>Betaling niet gelukt</h1>" +
                "<p>De betaling voor bestelling <strong>" + nr + "</strong> werd niet voltooid " +
                "(geannuleerd of verlopen). Er werd niets aangerekend.</p>" +
                "<p>Je winkelmandje staat nog klaar.</p>" +
                '<p><a class="btn" href="./">Terug naar de webshop</a></p>');
        }
    }

    document.addEventListener("DOMContentLoaded", run);
})();
