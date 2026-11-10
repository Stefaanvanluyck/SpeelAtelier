/* =========================================================
   Webshop – catalogus, winkelmandje en afrekenen
========================================================= */

(function () {
    "use strict";

    const S = window.SHOP;
    const $ = function (id) { return document.getElementById(id); };

    let products = [];
    let settings = null;
    let step = "cart";
    let busy = false;

    /* ---------------- laden ---------------- */

    async function load() {
        const [settingsRes, productsRes] = await Promise.all([
            S.sb.from("shop_settings")
                .select("shop_open, pickup_enabled, shipping_enabled, shipping_cost, free_shipping_from, pickup_info, lead_time_text, announcement")
                .eq("id", 1).maybeSingle(),
            S.sb.from("shop_products")
                .select("id, name, slug, short_text, description, safety_note, price, image_path, extra_images, max_per_order")
                .eq("active", true)
                .order("sort_order").order("name")
        ]);

        if (settingsRes.error || productsRes.error || !settingsRes.data) {
            $("productGrid").innerHTML =
                '<p class="empty">De webshop kon niet geladen worden. Probeer later opnieuw.</p>';
            return;
        }

        settings = settingsRes.data;
        products = productsRes.data || [];

        $("leadTime").textContent = "🧡 " + settings.lead_time_text;
        if (settings.announcement) {
            $("announcement").textContent = settings.announcement;
            $("announcement").classList.remove("hidden");
        }
        $("closedNotice").classList.toggle("hidden", !!settings.shop_open);

        // Producten die niet meer bestaan uit het mandje halen
        const ids = new Set(products.map(function (p) { return p.id; }));
        S.writeCart(S.readCart().filter(function (i) { return ids.has(i.product_id); }));

        renderGrid();
        renderCart();
        openFromHash();
    }

    function product(id) {
        return products.find(function (p) { return p.id === id; });
    }

    /* ---------------- catalogus ---------------- */

    function renderGrid() {
        const grid = $("productGrid");
        if (!products.length) {
            grid.innerHTML = '<p class="empty">Binnenkort vind je hier ons sensorisch speelmateriaal. 🌈</p>';
            return;
        }
        grid.innerHTML = products.map(function (p) {
            return '<article class="product">' +
                '<img src="' + S.imageUrl(p.image_path) + '" alt="' + S.escapeHtml(p.name) +
                '" loading="lazy" data-detail="' + p.id + '">' +
                '<div class="product-body">' +
                '<h3>' + S.escapeHtml(p.name) + '</h3>' +
                '<p>' + S.escapeHtml(p.short_text || "") + '</p>' +
                '<div class="product-foot">' +
                '<span class="price">' + S.euro(p.price) + '</span>' +
                '<span style="display:flex;gap:6px">' +
                '<button class="btn secondary small" type="button" data-detail="' + p.id + '">Meer info</button>' +
                '<button class="btn small" type="button" data-add="' + p.id + '"' +
                (settings.shop_open ? "" : " disabled") + '>+ Mandje</button>' +
                '</span></div></div></article>';
        }).join("");
    }

    function openDetail(id) {
        const p = product(id);
        if (!p) return;
        const images = [p.image_path].concat(p.extra_images || []).filter(Boolean);
        $("modalContent").innerHTML =
            '<div><img id="mainImg" src="' + S.imageUrl(images[0]) + '" alt="' + S.escapeHtml(p.name) + '">' +
            (images.length > 1
                ? '<div class="thumbs">' + images.map(function (im) {
                    return '<img src="' + S.imageUrl(im) + '" alt="" data-thumb="' + S.imageUrl(im) + '">';
                }).join("") + '</div>'
                : "") +
            '</div><div style="display:grid;gap:10px;align-content:start">' +
            '<h2 id="modalTitle">' + S.escapeHtml(p.name) + '</h2>' +
            '<span class="price">' + S.euro(p.price) + '</span>' +
            '<div style="white-space:pre-line">' + S.escapeHtml(p.description || p.short_text || "") + '</div>' +
            (p.safety_note ? '<div class="safety">⚠️ ' + S.escapeHtml(p.safety_note) + '</div>' : "") +
            '<div style="display:flex;gap:8px;align-items:center">' +
            '<input type="number" id="detailQty" min="1" max="' + p.max_per_order + '" value="1" style="width:80px">' +
            '<button class="btn" type="button" data-add-qty="' + p.id + '"' +
            (settings.shop_open ? "" : " disabled") + '>In mandje</button></div></div>';
        $("productModal").classList.add("open");
        $("overlay").classList.add("open");
        history.replaceState(null, "", "#" + p.slug);
    }

    function openFromHash() {
        const slug = decodeURIComponent(location.hash.slice(1));
        const p = products.find(function (x) { return x.slug === slug; });
        if (p) openDetail(p.id);
    }

    /* ---------------- mandje ---------------- */

    function cartLines() {
        return S.readCart()
            .map(function (i) { return { item: i, product: product(i.product_id) }; })
            .filter(function (x) { return x.product; });
    }

    function deliveryMethod() {
        const checked = document.querySelector('input[name="delivery"]:checked');
        return checked ? checked.value : null;
    }

    function calcTotals() {
        const subtotal = cartLines().reduce(function (s, x) {
            return s + Number(x.product.price) * x.item.quantity;
        }, 0);
        let shipping = 0;
        if (deliveryMethod() === "shipping") {
            const freeFrom = settings.free_shipping_from != null ? Number(settings.free_shipping_from) : null;
            shipping = freeFrom != null && subtotal >= freeFrom ? 0 : Number(settings.shipping_cost);
        }
        return { subtotal: subtotal, shipping: shipping, total: subtotal + shipping };
    }

    function renderCart() {
        $("cartBadge").textContent = String(S.cartCount());
        if (!settings) return;

        const lines = cartLines();
        $("cartLines").innerHTML = lines.length
            ? lines.map(function (x) {
                return '<div class="cart-line">' +
                    '<img src="' + S.imageUrl(x.product.image_path) + '" alt="">' +
                    '<div><strong>' + S.escapeHtml(x.product.name) + '</strong><br>' +
                    '<span class="muted">' + S.euro(x.product.price) + '</span><br>' +
                    '<span class="qty">' +
                    '<button type="button" data-qty="' + x.product.id + '" data-delta="-1" aria-label="Minder">−</button>' +
                    '<span>' + x.item.quantity + '</span>' +
                    '<button type="button" data-qty="' + x.product.id + '" data-delta="1" aria-label="Meer">+</button>' +
                    '</span></div>' +
                    '<strong>' + S.euro(Number(x.product.price) * x.item.quantity) + '</strong></div>';
            }).join("")
            : '<p class="empty">Je mandje is nog leeg.</p>';

        const t = calcTotals();
        let html = '<div><span>Subtotaal</span><span>' + S.euro(t.subtotal) + '</span></div>';
        if (step === "checkout" && deliveryMethod() === "shipping") {
            html += '<div><span>Verzending</span><span>' + (t.shipping ? S.euro(t.shipping) : "gratis") + '</span></div>';
        } else if (step === "cart" && settings.shipping_enabled) {
            html += '<div class="muted"><span>Verzending</span><span>' +
                (settings.pickup_enabled ? "afhalen gratis · " : "") +
                "verzenden " + S.euro(settings.shipping_cost) +
                (settings.free_shipping_from != null ? " (gratis vanaf " + S.euro(settings.free_shipping_from) + ")" : "") +
                '</span></div>';
        }
        html += '<div class="grand"><span>Totaal</span><span>' + S.euro(step === "checkout" ? t.total : t.subtotal) + '</span></div>';
        $("totals").innerHTML = html;

        $("nextButton").disabled = !lines.length || !settings.shop_open || busy;
        $("nextButton").textContent = step === "cart" ? "Afrekenen" : (busy ? "Even geduld…" : "Betalen " + S.euro(t.total));
    }

    function renderDeliveryChoice() {
        const opts = [];
        if (settings.pickup_enabled) {
            opts.push('<label><input type="radio" name="delivery" value="pickup"><span><strong>Afhalen</strong> – gratis<br>' +
                '<span class="muted">' + S.escapeHtml(settings.pickup_info) + '</span></span></label>');
        }
        if (settings.shipping_enabled) {
            opts.push('<label><input type="radio" name="delivery" value="shipping"><span><strong>Verzenden</strong> – ' +
                S.euro(settings.shipping_cost) +
                (settings.free_shipping_from != null ? ' <span class="muted">(gratis vanaf ' + S.euro(settings.free_shipping_from) + ')</span>' : "") +
                '</span></label>');
        }
        $("deliveryChoice").innerHTML = '<strong>Levering *</strong>' + opts.join("");
        const first = document.querySelector('input[name="delivery"]');
        if (first && opts.length === 1) first.checked = true;
        updateAddressVisibility();
    }

    function updateAddressVisibility() {
        $("addressFields").classList.toggle("hidden", deliveryMethod() !== "shipping");
        renderCart();
    }

    function setStep(next) {
        step = next;
        $("cartStep").classList.toggle("hidden", step !== "cart");
        $("checkoutStep").classList.toggle("hidden", step !== "checkout");
        $("backButton").classList.toggle("hidden", step !== "checkout");
        $("drawerTitle").textContent = step === "cart" ? "Winkelmandje" : "Gegevens";
        $("checkoutError").textContent = "";
        if (step === "checkout") renderDeliveryChoice();
        renderCart();
    }

    function openCart() {
        closeAll();
        $("cartDrawer").classList.add("open");
        $("overlay").classList.add("open");
        setStep("cart");
    }

    function closeAll() {
        $("cartDrawer").classList.remove("open");
        $("productModal").classList.remove("open");
        $("overlay").classList.remove("open");
        if (location.hash) history.replaceState(null, "", location.pathname);
    }

    /* ---------------- afrekenen ---------------- */

    async function submitOrder() {
        const form = $("checkoutStep");
        const f = new FormData(form);
        const err = $("checkoutError");
        err.textContent = "";

        const method = deliveryMethod();
        if (!method) { err.textContent = "Kies afhalen of verzenden."; return; }
        if (!String(f.get("name") || "").trim()) { err.textContent = "Vul je naam in."; return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(f.get("email") || "").trim())) {
            err.textContent = "Vul een geldig e-mailadres in."; return;
        }
        if (method === "shipping" &&
            (!String(f.get("street") || "").trim() || !String(f.get("postal_code") || "").trim() ||
             !String(f.get("city") || "").trim())) {
            err.textContent = "Vul je volledige leveradres in."; return;
        }
        if (!form.elements.terms.checked) {
            err.textContent = "Aanvaard de algemene verkoopsvoorwaarden."; return;
        }

        const isCompany = $("isCompany").checked;
        const payload = {
            items: S.readCart(),
            customer: {
                name: f.get("name"),
                email: f.get("email"),
                phone: f.get("phone"),
                company_name: isCompany ? f.get("company_name") : "",
                company_vat: isCompany ? f.get("company_vat") : ""
            },
            delivery: {
                method: method,
                street: f.get("street"),
                postal_code: f.get("postal_code"),
                city: f.get("city"),
                country: f.get("country")
            },
            note: f.get("note"),
            terms_accepted: true
        };

        busy = true;
        renderCart();
        try {
            const res = await S.sb.functions.invoke("shop-create-order", { body: payload });
            let data = res.data;
            if (res.error) {
                try { data = await res.error.context.json(); } catch (e) { data = null; }
                throw new Error((data && data.error) || "De bestelling kon niet worden doorgestuurd.");
            }
            /* Zelfde toegelaten domeinen als de inschrijvingen (index.html):
               Mollie, PPRO (betaalpartner van Mollie) of het eigen domein. */
            let url = null;
            try { url = new URL(String((data && data.checkoutUrl) || "")); } catch (e) { url = null; }
            const host = url ? url.hostname.toLowerCase() : "";
            const allowed = url !== null && url.protocol === "https:" && (
                host === "mollie.com" || host.endsWith(".mollie.com") ||
                host === "ppro.com" || host.endsWith(".ppro.com") ||
                host === location.hostname
            );
            if (!allowed) {
                console.warn("Geweigerde betaallink, domein:", host || "(geen geldige URL)");
                throw new Error("Ongeldige betaallink ontvangen. Probeer opnieuw.");
            }
            sessionStorage.setItem("kww_shop_pending", data.orderId);
            location.href = url.toString();
        } catch (e) {
            err.textContent = e.message || "Er ging iets mis.";
            busy = false;
            renderCart();
        }
    }

    /* ---------------- events ---------------- */

    document.addEventListener("click", function (e) {
        const t = e.target.closest("[data-detail],[data-add],[data-add-qty],[data-qty],[data-close],[data-thumb]");
        if (!t) return;

        if (t.dataset.detail) openDetail(t.dataset.detail);
        else if (t.dataset.add) { S.addToCart(t.dataset.add, 1); openCart(); }
        else if (t.dataset.addQty) {
            const p = product(t.dataset.addQty);
            const q = Math.max(1, Math.min(p.max_per_order, parseInt($("detailQty").value, 10) || 1));
            S.addToCart(p.id, q);
            openCart();
        } else if (t.dataset.qty) {
            const p = product(t.dataset.qty);
            const cur = S.readCart().find(function (i) { return i.product_id === p.id; });
            const q = Math.max(0, Math.min(p.max_per_order, (cur ? cur.quantity : 0) + Number(t.dataset.delta)));
            S.setQuantity(p.id, q);
        } else if (t.dataset.thumb) $("mainImg").src = t.dataset.thumb;
        else if (t.hasAttribute("data-close")) closeAll();
    });

    document.addEventListener("cart:changed", function () {
        // Maximum per product respecteren
        S.readCart().forEach(function (i) {
            const p = product(i.product_id);
            if (p && i.quantity > p.max_per_order) S.setQuantity(p.id, p.max_per_order);
        });
        renderCart();
    });

    document.addEventListener("change", function (e) {
        if (e.target.name === "delivery") updateAddressVisibility();
        if (e.target.id === "isCompany") $("companyFields").classList.toggle("hidden", !e.target.checked);
    });

    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeAll(); });

    document.addEventListener("DOMContentLoaded", function () {
        $("cartButton").addEventListener("click", openCart);
        $("overlay").addEventListener("click", closeAll);
        $("backButton").addEventListener("click", function () { setStep("cart"); });
        $("nextButton").addEventListener("click", function () {
            if (step === "cart") setStep("checkout");
            else if (!busy) submitOrder();
        });
        $("checkoutStep").addEventListener("submit", function (e) { e.preventDefault(); submitOrder(); });
        renderCart();
        load();
    });

    window.addEventListener("storage", function () { renderCart(); });
})();
