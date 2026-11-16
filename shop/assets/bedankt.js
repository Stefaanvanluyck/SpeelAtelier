/* =========================================================
   Webshop – terugkeer van Mollie én "volg je bestelling"
   bedankt.html?order=…&token=…          → na betalen (confetti, mandje leeg)
   bedankt.html?order=…&token=…&volg=1   → statuspagina (link in de mails)
========================================================= */

(function () {
    "use strict";

    const S = window.SHOP;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const esc = S.escapeHtml;

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

    // Zelfde logica als in de Edge Functions: PostNL-codes beginnen met "3S", de rest bpost.
    function trackingUrl(code, country, postal) {
        const c = String(code || "").replace(/\s+/g, "").toUpperCase();
        if (!/^[A-Z0-9]{8,40}$/.test(c)) return null;
        const pc = String(postal || "").replace(/\s+/g, "").toUpperCase();
        if (c.indexOf("3S") === 0) {
            return country === "NL"
                ? "https://jouw.postnl.nl/track-and-trace/" + c + "-NL-" + pc
                : "https://jouw.postnl.be/track-and-trace/" + c + "-BE-" + pc;
        }
        return "https://track.bpost.cloud/btr/web/#/search?itemCode=" + encodeURIComponent(c) + "&lang=nl" +
            (pc ? "&postalCode=" + encodeURIComponent(pc) : "");
    }

    function timeline(o) {
        const st = o.order_status;
        const pickup = o.delivery_method === "pickup";
        const reached = function (list) { return list.indexOf(st) !== -1; };
        const steps = pickup
            ? [
                ["Besteld", true],
                ["Betaald", true],
                ["In productie", reached(["in_production", "ready_for_pickup", "completed"])],
                ["Klaar om af te halen", reached(["ready_for_pickup", "completed"])],
                ["Afgehaald", reached(["completed"])]
            ]
            : [
                ["Besteld", true],
                ["Betaald", true],
                ["In productie", reached(["in_production", "shipped", "out_for_delivery", "delivered", "completed"])],
                ["Onderweg", reached(["shipped", "out_for_delivery", "delivered", "completed"])],
                ["Afgeleverd", reached(["delivered", "completed"])]
            ];
        return '<ol class="timeline" aria-label="Status van je bestelling">' + steps.map(function (s) {
            return '<li class="' + (s[1] ? "done" : "") + '"><span class="dot">' + (s[1] ? "✓" : "") + "</span>" + s[0] + "</li>";
        }).join("") + "</ol>";
    }

    function statusText(o) {
        const st = o.order_status;
        if (st === "cancelled") return "Deze bestelling werd geannuleerd.";
        if (st === "delivered" || (st === "completed" && o.delivery_method === "shipping")) {
            return "Je bestelling werd afgeleverd" +
                (o.delivered_at ? " op " + new Date(o.delivered_at).toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" }) : "") +
                ". Veel speelplezier! 🌈";
        }
        if (st === "completed") return "Je bestelling werd afgehaald. Veel speelplezier! 🌈";
        if (st === "ready_for_pickup") return "Je bestelling staat klaar om af te halen.";
        if (st === "out_for_delivery") {
            return "We zijn onderweg om je bestelling af te leveren! 🚗" +
                (o.delivery_slot ? "<br>Verwacht bezorgmoment: <strong>" + esc(o.delivery_slot) + "</strong>" : "");
        }
        if (st === "shipped") return "Je bestelling is onderweg.";
        if (st === "in_production") return "We zijn je bestelling met zorg aan het maken. ✂️";
        return o.delivery_method === "pickup"
            ? "We laten je weten wanneer je bestelling klaarstaat om af te halen."
            : "We laten je weten wanneer we je bestelling komen brengen." +
              (o.delivery_slot ? "<br>Gepland bezorgmoment: <strong>" + esc(o.delivery_slot) + "</strong>" : "");
    }

    function summary(o) {
        return '<div class="order-summary">' +
            "<span>Bestelling</span><strong>" + esc(o.order_number) + "</strong>" +
            "<span>Besteld op</span><strong>" + new Date(o.created_at).toLocaleDateString("nl-BE") + "</strong>" +
            "<span>Bedrag</span><strong>" + S.euro(o.total) + "</strong>" +
            "<span>Levering</span><strong>" + (o.delivery_method === "pickup" ? "🏠 Afhalen" : "🚗 Levering aan huis") + "</strong>" +
            (o.gift_wrap ? "<span>Extra</span><strong>🎁 Cadeauverpakking</strong>" : "") +
            "</div>";
    }

    function itemsList(o) {
        const items = o.items || [];
        if (!items.length) return "";
        return '<ul class="status-items">' + items.map(function (i) {
            return "<li>" + i.quantity + " × " + esc(i.name) + "</li>";
        }).join("") + "</ul>";
    }

    function extras(o) {
        let html = "";
        const url = trackingUrl(o.tracking_code, o.country, o.postal_code);
        if (o.tracking_code) {
            html += "<p>Track &amp; trace: <strong>" + esc(o.tracking_code) + "</strong>" +
                (url ? '<br><a class="track-link" href="' + url + '" target="_blank" rel="noopener">Volg je pakje ↗</a>' : "") + "</p>";
        }
        if (o.withdrawn) {
            html += '<p class="notice">↩️ We hebben je herroeping ontvangen en nemen contact met je op.</p>';
        } else if (o.order_status !== "cancelled") {
            html += '<p class="muted small">Bedenktijd: binnen 14 dagen na ontvangst kan je ' +
                '<a href="herroeping.html?bestelling=' + encodeURIComponent(o.order_number) + '">je aankoop herroepen</a>.</p>';
        }
        return html;
    }

    async function run() {
        const p = new URLSearchParams(location.search);
        const orderId = p.get("order") || "";
        const token = p.get("token") || "";
        const follow = p.get("volg") === "1";

        if (!UUID.test(orderId) || !UUID.test(token)) {
            show("<h1>Bestelling niet gevonden</h1><p>Deze link is ongeldig.</p>" +
                '<p><a class="btn" href="./">Naar de webshop</a></p>');
            return;
        }

        // Na betalen kan de webhook van Mollie enkele seconden later binnenkomen.
        let order = null;
        for (let i = 0; i < (follow ? 1 : 8); i++) {
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

        const nr = esc(order.order_number);
        const paid = ["paid", "refunded", "partially_refunded"].indexOf(order.payment_status) !== -1;

        if (follow && paid) {
            document.title = "Bestelling " + order.order_number + " – Kleine Wonderwereld";
            const done = ["delivered", "completed"].indexOf(order.order_status) !== -1;
            show('<div class="status-icon' + (order.order_status === "cancelled" ? " fail" : "") + '">' +
                (order.order_status === "cancelled" ? "✖️" : done ? "🌈" : order.order_status === "out_for_delivery" ? "🚗" : "📦") + "</div>" +
                "<h1>Je bestelling " + nr + "</h1>" +
                "<p>" + statusText(order) + "</p>" +
                (order.order_status !== "cancelled" ? timeline(order) : "") +
                summary(order) + "<br>" + itemsList(order) + extras(order) +
                '<p style="margin-top:14px"><a class="btn" href="./">Naar de webshop</a></p>');
            return;
        }

        if (order.payment_status === "paid") {
            S.clearCart();
            sessionStorage.removeItem("kww_shop_pending");
            show('<div class="status-icon">🎉</div>' +
                "<h1>Bedankt voor je bestelling!</h1>" +
                "<p>Je betaling is goed ontvangen. Je krijgt zo dadelijk een bevestigingsmail met je factuur " +
                "en een link om je bestelling te volgen.</p>" +
                summary(order) +
                timeline(order) +
                "<p>" + statusText(order) + "</p>" +
                '<p style="margin-top:14px"><a class="btn" href="./">Verder winkelen</a> <a class="btn secondary" href="../">Naar het speelatelier</a></p>');
            S.confetti(140);
        } else if (order.payment_status === "pending") {
            show('<div class="status-icon wait">⏳</div>' +
                "<h1>Betaling wordt verwerkt</h1>" +
                "<p>Je betaling is nog niet bevestigd. Dit kan enkele minuten duren. " +
                "Je krijgt een mail zodra de betaling binnen is.</p>" + summary(order) +
                '<p><button class="btn secondary" type="button" id="retry">Opnieuw controleren</button></p>');
            document.getElementById("retry").addEventListener("click", function () { location.reload(); });
        } else {
            show('<div class="status-icon fail">😕</div>' +
                "<h1>Betaling niet gelukt</h1>" +
                "<p>De betaling voor bestelling <strong>" + nr + "</strong> werd niet voltooid " +
                "(geannuleerd of verlopen). Er werd niets aangerekend.</p>" +
                (follow ? "" : "<p>Je winkelmandje staat nog klaar.</p>") +
                '<p><a class="btn" href="./">Terug naar de webshop</a></p>');
        }
    }

    document.addEventListener("DOMContentLoaded", run);
})();
