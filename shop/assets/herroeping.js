/* =========================================================
   Webshop – herroeping (14 dagen bedenktijd)
   Stap 1: knop "Overeenkomst herroepen"  →  stap 2: gegevens + "Bevestig herroeping"
========================================================= */
(function () {
    "use strict";

    const S = window.SHOP;
    const $ = function (id) { return document.getElementById(id); };

    async function fillSettings() {
        const { data } = await S.sb.from("shop_settings")
            .select("business_name, business_address, business_email").eq("id", 1).maybeSingle();
        if (!data) return;
        document.querySelectorAll("[data-setting]").forEach(function (el) {
            const v = data[el.dataset.setting];
            if (v) el.textContent = String(v).replace(/\n/g, ", ");
        });
    }

    function open() {
        $("withdrawStart").classList.add("hidden");
        $("withdrawForm").classList.remove("hidden");
        const nr = $("withdrawForm").elements.order_number;
        (nr.value ? $("withdrawForm").elements.email : nr).focus();
    }

    function cancel() {
        $("withdrawForm").classList.add("hidden");
        $("withdrawStart").classList.remove("hidden");
        $("withdrawError").textContent = "";
    }

    async function submit(e) {
        e.preventDefault();
        const form = $("withdrawForm");
        const f = new FormData(form);
        const err = $("withdrawError");
        err.textContent = "";
        const payload = {
            order_number: String(f.get("order_number") || "").trim().toUpperCase(),
            email: String(f.get("email") || "").trim(),
            name: String(f.get("name") || "").trim(),
            items: String(f.get("items") || "").trim(),
            reason: String(f.get("reason") || "").trim()
        };
        if (!/^B\d{4}-\d{4,}$/.test(payload.order_number)) { err.textContent = "Vul je bestelnummer in (bv. B2026-0012)."; return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(payload.email)) { err.textContent = "Vul een geldig e-mailadres in."; return; }
        if (!payload.name) { err.textContent = "Vul je naam in."; return; }
        if (!payload.items) { err.textContent = "Vermeld welke producten je wil terugsturen."; return; }

        const btn = $("withdrawSubmit");
        btn.disabled = true;
        btn.textContent = "Even geduld…";
        try {
            const res = await S.sb.functions.invoke("shop-withdraw", { body: payload });
            let data = res.data;
            if (res.error) {
                try { data = await res.error.context.json(); } catch (x) { data = null; }
                throw new Error((data && data.error) || "Er ging iets mis. Mail ons gerust je herroeping.");
            }
            form.classList.add("hidden");
            const when = new Date(data.received_at).toLocaleString("nl-BE");
            $("withdrawDone").innerHTML = "<strong>✔ Je herroeping is ontvangen</strong> (" + S.escapeHtml(when) + ") voor bestelling " +
                "<strong>" + S.escapeHtml(data.order_number) + "</strong>.<br>Je krijgt een ontvangstbevestiging per e-mail. " +
                "We nemen contact met je op over het terugbezorgen van de producten.";
            $("withdrawDone").classList.remove("hidden");
        } catch (x) {
            err.textContent = x.message;
            btn.disabled = false;
            btn.textContent = "✔ Bevestig herroeping";
        }
    }

    document.addEventListener("DOMContentLoaded", function () {
        const nr = new URLSearchParams(location.search).get("bestelling");
        if (nr) $("withdrawForm").elements.order_number.value = nr;
        $("withdrawOpen").addEventListener("click", open);
        $("withdrawCancel").addEventListener("click", cancel);
        $("withdrawForm").addEventListener("submit", submit);
        $("printModel").addEventListener("click", function () { window.print(); });
        fillSettings();
    });
})();
