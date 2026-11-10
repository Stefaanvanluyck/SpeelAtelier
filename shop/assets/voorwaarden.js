/* Vult de bedrijfsgegevens in de voorwaarden in vanuit de webshop-instellingen. */
(function () {
    "use strict";

    document.addEventListener("DOMContentLoaded", async function () {
        const { data } = await window.SHOP.sb
            .from("shop_settings")
            .select("business_name, business_address, enterprise_number, business_email, business_phone, lead_time_text")
            .eq("id", 1)
            .maybeSingle();
        if (!data) return;

        document.querySelectorAll("[data-setting]").forEach(function (el) {
            const v = data[el.dataset.setting];
            if (v) el.textContent = v;
        });
        document.querySelectorAll("[data-setting-wrap]").forEach(function (el) {
            el.classList.toggle("hidden", !data[el.dataset.settingWrap]);
        });
    });
})();
