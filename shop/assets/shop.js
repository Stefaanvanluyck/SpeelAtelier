/* =========================================================
   Webshop – catalogus, productpagina, winkelmandje en afrekenen
   Wordt gebruikt door index.html (#productGrid) en
   product.html (#productPage).
========================================================= */

(function () {
    "use strict";

    const S = window.SHOP;
    const $ = function (id) { return document.getElementById(id); };

    let products = [];
    let categories = [];
    let settings = null;
    let step = "cart";
    let busy = false;

    // Catalogusfilters
    let activeCategory = "";   // slug, "" = alles
    let searchTerm = "";
    let sortMode = "";         // "" = aanbevolen, price-asc, price-desc, name, new

    // Kortingscode: { code, amount, label } of null
    let discount = null;
    let discountSeq = 0;

    /* ---------------- laden ---------------- */

    const PRODUCT_FIELDS = "id, name, slug, short_text, description, safety_note, price, image_path, extra_images, max_per_order";

    function productQuery(fields) {
        return S.sb.from("shop_products").select(fields).eq("active", true).order("sort_order").order("name");
    }

    async function load() {
        let [settingsRes, productsRes, categoriesRes] = await Promise.all([
            S.sb.from("shop_settings")
                .select("shop_open, pickup_enabled, shipping_enabled, shipping_cost, free_shipping_from, pickup_info, lead_time_text, announcement")
                .eq("id", 1).maybeSingle(),
            productQuery(PRODUCT_FIELDS + ", category_id, compare_at_price, badge, featured, created_at"),
            S.sb.from("shop_categories")
                .select("id, name, slug, sort_order, icon")
                .eq("active", true)
                .order("sort_order").order("name")
        ]);

        // Database nog niet bijgewerkt? Dan met de basisvelden verder.
        if (productsRes.error) productsRes = await productQuery(PRODUCT_FIELDS);
        if (categoriesRes.error) {
            categoriesRes = await S.sb.from("shop_categories").select("id, name, slug, sort_order")
                .eq("active", true).order("sort_order").order("name");
        }

        if (settingsRes.error || productsRes.error || !settingsRes.data) {
            const target = $("productGrid") || $("productPage");
            if (target) target.innerHTML = '<p class="empty">De webshop kon niet geladen worden. Probeer later opnieuw.</p>';
            return;
        }

        settings = settingsRes.data;
        products = productsRes.data || [];
        // Categorieën zijn optioneel: als de tabel (nog) niet bestaat, werkt de shop gewoon verder.
        categories = categoriesRes.error ? [] : (categoriesRes.data || []);

        if ($("leadTime")) $("leadTime").textContent = "🧡 " + settings.lead_time_text;
        const topText = settings.announcement ||
            (settings.shipping_enabled && settings.free_shipping_from != null
                ? "📦 Gratis verzending vanaf " + S.euro(settings.free_shipping_from) + " · 🏠 afhalen altijd gratis"
                : "");
        if (topText && $("topBar")) {
            $("topBar").textContent = topText;
            $("topBar").classList.remove("hidden");
        }
        if ($("closedNotice")) $("closedNotice").classList.toggle("hidden", !!settings.shop_open);
        if ($("trustPickup")) $("trustPickup").classList.toggle("hidden", !settings.pickup_enabled);
        if ($("trustShipping")) {
            $("trustShipping").classList.toggle("hidden", !settings.shipping_enabled);
            if (settings.free_shipping_from != null) {
                $("trustShipping").querySelector("div").innerHTML =
                    "<strong>Gratis verzending</strong><br>vanaf " + S.euro(settings.free_shipping_from) + " (BE/NL)";
            }
        }

        // Producten die niet meer bestaan uit het mandje halen
        const ids = new Set(products.map(function (p) { return p.id; }));
        S.writeCart(S.readCart().filter(function (i) { return ids.has(i.product_id); }));

        if ($("productGrid")) {
            // Oude deellinks (shop/#slug) doorsturen naar de productpagina
            const hashSlug = decodeURIComponent(location.hash.slice(1));
            if (hashSlug && products.some(function (p) { return p.slug === hashSlug; })) {
                location.replace(productUrl(hashSlug));
                return;
            }
            const params = new URLSearchParams(location.search);
            activeCategory = params.get("cat") || "";
            searchTerm = params.get("q") || "";
            sortMode = params.get("sort") || "";
            if ($("productSearch")) $("productSearch").value = searchTerm;
            if ($("productSort")) $("productSort").value = sortMode;
            renderCategoryChips();
            renderGrid();
        }
        if ($("productPage")) renderProductPage();

        renderCart();
    }

    function product(id) {
        return products.find(function (p) { return p.id === id; });
    }

    function productUrl(slug) {
        return "product.html?p=" + encodeURIComponent(slug);
    }

    function categoryOf(p) {
        return categories.find(function (c) { return c.id === p.category_id; }) || null;
    }

    /* ---------------- catalogus ---------------- */

    function normalize(s) {
        return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    }

    function filteredProducts() {
        const cat = categories.find(function (c) { return c.slug === activeCategory; });
        const words = normalize(searchTerm).split(/\s+/).filter(Boolean);
        const list = products.filter(function (p) {
            if (cat && p.category_id !== cat.id) return false;
            if (!words.length) return true;
            const c = categoryOf(p);
            const hay = normalize([p.name, p.short_text, p.description, p.badge, c ? c.name : ""].join(" "));
            return words.every(function (w) { return hay.includes(w); });
        });
        return sortProducts(list);
    }

    function sortProducts(list) {
        const copy = list.slice();
        if (sortMode === "price-asc") copy.sort(function (a, b) { return Number(a.price) - Number(b.price); });
        else if (sortMode === "price-desc") copy.sort(function (a, b) { return Number(b.price) - Number(a.price); });
        else if (sortMode === "name") copy.sort(function (a, b) { return a.name.localeCompare(b.name, "nl"); });
        else if (sortMode === "new") copy.sort(function (a, b) { return String(b.created_at || "").localeCompare(String(a.created_at || "")); });
        else copy.sort(function (a, b) { return (b.featured ? 1 : 0) - (a.featured ? 1 : 0); }); // stabiel: verder sort_order
        return copy;
    }

    function onSale(p) {
        return p.compare_at_price != null && Number(p.compare_at_price) > Number(p.price);
    }

    function priceHtml(p) {
        return '<span class="price">' + S.euro(p.price) + "</span>" +
            (onSale(p) ? ' <s class="was" aria-label="Oude prijs">' + S.euro(p.compare_at_price) + "</s>" : "");
    }

    function badgeHtml(p) {
        let text = p.badge;
        if (!text && onSale(p)) text = "−" + Math.round((1 - Number(p.price) / Number(p.compare_at_price)) * 100) + "%";
        if (!text) return "";
        const cls = /promo|%|sale|korting/i.test(text) ? " sale" : /nieuw|new/i.test(text) ? " new" : "";
        return '<span class="ribbon' + cls + '">' + S.escapeHtml(text) + "</span>";
    }

    function cardHtml(p) {
        const url = productUrl(p.slug);
        const cat = categoryOf(p);
        const second = (p.extra_images || [])[0];
        return '<article class="product">' +
            '<a class="product-img" href="' + url + '">' + badgeHtml(p) +
            '<img src="' + S.imageUrl(p.image_path) + '" alt="' + S.escapeHtml(p.name) + '" loading="lazy">' +
            (second ? '<img class="alt" src="' + S.imageUrl(second) + '" alt="" loading="lazy">' : "") + "</a>" +
            '<div class="product-body">' +
            (cat ? '<span class="eyebrow">' + S.escapeHtml(cat.name) + "</span>" : "") +
            '<h3><a class="plain" href="' + url + '">' + S.escapeHtml(p.name) + "</a></h3>" +
            "<p>" + S.escapeHtml(p.short_text || "") + "</p>" +
            '<div class="product-foot">' +
            "<span>" + priceHtml(p) + "</span>" +
            '<button class="btn small" type="button" data-add="' + p.id + '"' +
            (settings.shop_open ? "" : " disabled") + ' aria-label="' + S.escapeHtml(p.name) + ' in mandje">+ Mandje</button>' +
            "</div></div></article>";
    }

    function renderCategoryChips() {
        const box = $("categoryChips");
        if (!box) return;
        // Enkel categorieën met minstens één zichtbaar product
        const used = categories.filter(function (c) {
            return products.some(function (p) { return p.category_id === c.id; });
        });
        if (!used.some(function (c) { return c.slug === activeCategory; })) activeCategory = "";
        if (!used.length) { box.innerHTML = ""; return; }
        box.innerHTML = [{ slug: "", name: "Alles", icon: "✨" }].concat(used).map(function (c) {
            const on = c.slug === activeCategory;
            return '<button type="button" class="chip' + (on ? " active" : "") + '" data-cat="' + S.escapeHtml(c.slug) +
                '" aria-pressed="' + on + '">' + (c.icon ? '<span class="ico" aria-hidden="true">' + S.escapeHtml(c.icon) + "</span>" : "") +
                S.escapeHtml(c.name) + "</button>";
        }).join("");
    }

    function syncFilterUrl() {
        const params = new URLSearchParams();
        if (activeCategory) params.set("cat", activeCategory);
        if (searchTerm.trim()) params.set("q", searchTerm.trim());
        if (sortMode) params.set("sort", sortMode);
        const qs = params.toString();
        history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
    }

    function renderGrid() {
        const grid = $("productGrid");
        grid.removeAttribute("aria-busy");
        if (!products.length) {
            grid.innerHTML = '<p class="empty">Binnenkort vind je hier ons sensorisch speelmateriaal. 🌈</p>';
            return;
        }
        const list = filteredProducts();
        if ($("resultCount")) {
            $("resultCount").textContent = list.length + (list.length === 1 ? " product" : " producten");
        }
        if (!list.length) {
            grid.innerHTML = '<p class="empty">Geen producten gevonden. ' +
                '<button class="btn secondary small" type="button" data-reset-filters>Toon alles</button></p>';
            return;
        }
        grid.innerHTML = list.map(cardHtml).join("");
    }

    /* ---------------- productpagina ---------------- */

    function setMeta(selector, attr, value) {
        const el = document.querySelector(selector);
        if (el) el.setAttribute(attr, value);
    }

    function renderProductPage() {
        const slug = new URLSearchParams(location.search).get("p") || "";
        const p = products.find(function (x) { return x.slug === slug; });
        const box = $("productPage");

        if (!p) {
            document.title = "Product niet gevonden – Kleine Wonderwereld";
            setMeta('meta[name="robots"]', "content", "noindex");
            box.innerHTML = '<div class="card"><h1>Product niet gevonden</h1>' +
                '<p>Dit product bestaat niet (meer) of is tijdelijk niet beschikbaar.</p>' +
                '<p><a class="btn" href="./">← Naar alle producten</a></p></div>';
            return;
        }

        const cat = categoryOf(p);
        const images = [p.image_path].concat(p.extra_images || []).filter(Boolean);
        const pageUrl = location.origin + location.pathname + "?p=" + encodeURIComponent(p.slug);
        const desc = (p.short_text || p.description || "").slice(0, 160);

        document.title = p.name + " – Webshop Kleine Wonderwereld";
        setMeta('meta[name="description"]', "content", desc);
        setMeta('link[rel="canonical"]', "href", pageUrl);
        setMeta('meta[property="og:title"]', "content", p.name);
        setMeta('meta[property="og:description"]', "content", desc);
        if (p.image_path) setMeta('meta[property="og:image"]', "content", S.imageUrl(p.image_path));

        // Gestructureerde gegevens voor zoekmachines
        const ld = document.createElement("script");
        ld.type = "application/ld+json";
        ld.textContent = JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Product",
            name: p.name,
            description: p.description || p.short_text || "",
            image: images.map(S.imageUrl),
            sku: p.slug,
            category: cat ? cat.name : undefined,
            brand: { "@type": "Brand", name: "Kleine Wonderwereld" },
            offers: {
                "@type": "Offer",
                url: pageUrl,
                priceCurrency: "EUR",
                price: Number(p.price).toFixed(2),
                availability: settings.shop_open ? "https://schema.org/InStock" : "https://schema.org/OutOfStock"
            }
        });
        document.head.appendChild(ld);

        box.innerHTML =
            '<nav class="breadcrumb"><a href="./">Webshop</a>' +
            (cat ? ' › <a href="./?cat=' + encodeURIComponent(cat.slug) + '">' + S.escapeHtml(cat.name) + "</a>" : "") +
            " › <span>" + S.escapeHtml(p.name) + "</span></nav>" +
            '<article class="product-page">' +
            '<div class="product-img">' + badgeHtml(p) +
            '<div class="zoom-wrap" id="zoomWrap" role="button" tabindex="0" aria-label="Foto vergroten">' +
            '<img id="mainImg" class="main-img" src="' + S.imageUrl(images[0]) + '" alt="' + S.escapeHtml(p.name) + '">' +
            '<span class="zoom-hint" aria-hidden="true">🔍 Klik om te vergroten</span></div>' +
            (images.length > 1
                ? '<div class="thumbs">' + images.map(function (im, i) {
                    return '<img src="' + S.imageUrl(im) + '" alt="Foto ' + (i + 1) + '" data-thumb="' + S.imageUrl(im) + '"' +
                        (i === 0 ? ' class="active"' : "") + ">";
                }).join("") + "</div>"
                : "") +
            '</div><div class="product-info">' +
            (cat ? '<span class="eyebrow">' + S.escapeHtml(cat.name) + "</span>" : "") +
            "<h1>" + S.escapeHtml(p.name) + "</h1>" +
            '<div class="price-line">' + priceHtml(p) + "</div>" +
            (p.short_text ? '<p class="lead">' + S.escapeHtml(p.short_text) + "</p>" : "") +
            '<div class="buy-row">' +
            '<div class="stepper"><button type="button" data-step="-1" aria-label="Minder">−</button>' +
            '<input type="number" id="detailQty" min="1" max="' + p.max_per_order + '" value="1" aria-label="Aantal">' +
            '<button type="button" data-step="1" aria-label="Meer">+</button></div>' +
            '<button class="btn big" type="button" data-add-qty="' + p.id + '"' +
            (settings.shop_open ? "" : " disabled") + ">In mandje</button>" +
            '<button class="btn secondary" type="button" data-share aria-label="Delen">🔗</button>' +
            "</div>" +
            '<p class="muted" id="shareMsg" role="status"></p>' +
            (settings.shop_open ? "" : '<div class="notice closed" style="margin:0">De webshop is momenteel gesloten. ' +
                '<a href="./#notifyForm">Laat je e-mailadres achter</a> en we laten je weten wanneer je weer kan bestellen.</div>') +
            '<ul class="usp-list">' +
            "<li>🧡 " + S.escapeHtml(settings.lead_time_text) + "</li>" +
            (settings.pickup_enabled ? "<li>🏠 Gratis afhalen in het atelier</li>" : "") +
            (settings.shipping_enabled
                ? "<li>📦 Verzending " + S.euro(settings.shipping_cost) +
                  (settings.free_shipping_from != null ? ", gratis vanaf " + S.euro(settings.free_shipping_from) : "") + "</li>"
                : "") +
            "<li>🔒 Veilig online betalen via Mollie</li>" +
            "</ul>" +
            '<details class="info-block" open><summary>Beschrijving</summary>' +
            '<div style="white-space:pre-line">' + S.escapeHtml(p.description || p.short_text || "") + "</div></details>" +
            (p.safety_note ? '<details class="info-block" open><summary>Veiligheid</summary><div class="safety">⚠️ ' +
                S.escapeHtml(p.safety_note) + "</div></details>" : "") +
            '<details class="info-block"><summary>Levering &amp; retour</summary><div>' +
            (settings.pickup_enabled ? "<p><strong>Afhalen:</strong> " + S.escapeHtml(settings.pickup_info) + "</p>" : "") +
            (settings.shipping_enabled ? "<p><strong>Verzenden:</strong> naar België en Nederland.</p>" : "") +
            '<p>Meer info in de <a href="voorwaarden.html">algemene verkoopsvoorwaarden</a>.</p></div></details>' +
            "</div></article>" +
            relatedHtml(p);

        galleryImages = images.length ? images.map(S.imageUrl) : [S.imageUrl(null)];
        galleryIndex = 0;
        setupStickyBuy(p);
    }

    /* ---------------- fotogalerij: zoom + lightbox ---------------- */

    let galleryImages = [];
    let galleryIndex = 0;

    function lightbox() {
        let lb = $("lightbox");
        if (lb) return lb;
        lb = document.createElement("div");
        lb.id = "lightbox";
        lb.className = "lightbox";
        lb.setAttribute("role", "dialog");
        lb.setAttribute("aria-modal", "true");
        lb.setAttribute("aria-label", "Foto's");
        lb.innerHTML = '<img id="lbImg" alt="">' +
            '<button class="lb-close" type="button" data-lb="close" aria-label="Sluiten">×</button>' +
            '<button class="lb-prev" type="button" data-lb="-1" aria-label="Vorige foto">‹</button>' +
            '<button class="lb-next" type="button" data-lb="1" aria-label="Volgende foto">›</button>' +
            '<span class="lb-count" id="lbCount"></span>';
        document.body.appendChild(lb);

        lb.addEventListener("click", function (e) {
            const b = e.target.closest("[data-lb]");
            if (b) {
                if (b.dataset.lb === "close") closeLightbox();
                else showLightbox(galleryIndex + Number(b.dataset.lb));
            } else if (e.target === lb) closeLightbox();
        });
        // Vegen op gsm
        let x0 = null;
        lb.addEventListener("touchstart", function (e) { x0 = e.touches[0].clientX; }, { passive: true });
        lb.addEventListener("touchend", function (e) {
            if (x0 === null) return;
            const dx = e.changedTouches[0].clientX - x0;
            if (Math.abs(dx) > 40) showLightbox(galleryIndex + (dx < 0 ? 1 : -1));
            x0 = null;
        });
        return lb;
    }

    function showLightbox(i) {
        if (!galleryImages.length) return;
        const lb = lightbox();
        galleryIndex = (i + galleryImages.length) % galleryImages.length;
        $("lbImg").src = galleryImages[galleryIndex];
        const many = galleryImages.length > 1;
        lb.querySelector(".lb-prev").classList.toggle("hidden", !many);
        lb.querySelector(".lb-next").classList.toggle("hidden", !many);
        $("lbCount").textContent = many ? (galleryIndex + 1) + " / " + galleryImages.length : "";
        lb.classList.add("open");
        document.body.style.overflow = "hidden";
        lb.querySelector(".lb-close").focus();
    }

    function closeLightbox() {
        const lb = $("lightbox");
        if (!lb || !lb.classList.contains("open")) return false;
        lb.classList.remove("open");
        document.body.style.overflow = "";
        if ($("zoomWrap")) $("zoomWrap").focus();
        return true;
    }

    // Zoom volgt de muis
    document.addEventListener("mousemove", function (e) {
        const w = e.target.closest && e.target.closest("#zoomWrap");
        if (!w) return;
        const r = w.getBoundingClientRect();
        $("mainImg").style.transformOrigin =
            ((e.clientX - r.left) / r.width * 100) + "% " + ((e.clientY - r.top) / r.height * 100) + "%";
    });

    /* ---------------- vaste koopbalk (gsm) ---------------- */

    function setupStickyBuy(p) {
        if (!settings.shop_open || !("IntersectionObserver" in window)) return;
        const bar = document.createElement("div");
        bar.className = "sticky-buy";
        bar.innerHTML = '<div><div class="name">' + S.escapeHtml(p.name) + "</div>" + priceHtml(p) + "</div>" +
            '<button class="btn" type="button" data-add-sticky="' + p.id + '">In mandje</button>';
        document.body.appendChild(bar);
        const target = document.querySelector(".buy-row");
        new IntersectionObserver(function (entries) {
            // Tonen zodra de gewone koopknop uit beeld is (en we er voorbij gescrold zijn)
            const e = entries[0];
            bar.classList.toggle("show", !e.isIntersecting && e.boundingClientRect.top < 0);
        }).observe(target);
    }

    /* ---------------- vliegend product ---------------- */

    function flyToCart(sourceImg) {
        const cart = $("cartButton");
        if (!sourceImg || !cart || S.reducedMotion() || !sourceImg.animate) return;
        const from = sourceImg.getBoundingClientRect();
        const to = cart.getBoundingClientRect();
        if (!from.width) return;
        const size = Math.min(90, from.width);
        const fly = document.createElement("img");
        fly.src = sourceImg.currentSrc || sourceImg.src;
        fly.alt = "";
        fly.className = "fly-img";
        fly.style.width = fly.style.height = size + "px";
        const x0 = from.left + from.width / 2 - size / 2, y0 = from.top + from.height / 2 - size / 2;
        const x1 = to.left + to.width / 2 - size / 2, y1 = to.top + to.height / 2 - size / 2;
        fly.style.left = x0 + "px";
        fly.style.top = y0 + "px";
        document.body.appendChild(fly);
        fly.animate([
            { transform: "translate(0,0) scale(1)", opacity: 1 },
            { transform: "translate(" + (x1 - x0) * 0.5 + "px," + ((y1 - y0) * 0.5 - 80) + "px) scale(.7)", opacity: 1, offset: 0.5 },
            { transform: "translate(" + (x1 - x0) + "px," + (y1 - y0) + "px) scale(.2)", opacity: .4 }
        ], { duration: 750, easing: "cubic-bezier(.5,0,.6,1)" }).onfinish = function () { fly.remove(); };
    }

    function relatedHtml(p) {
        const same = products.filter(function (x) { return x.id !== p.id && p.category_id && x.category_id === p.category_id; });
        const others = products.filter(function (x) { return x.id !== p.id && same.indexOf(x) === -1; });
        const list = same.concat(sortProducts(others)).slice(0, 4);
        if (!list.length) return "";
        return '<section class="related"><h2>Misschien vind je dit ook leuk</h2>' +
            '<div class="grid">' + list.map(cardHtml).join("") + "</div></section>";
    }

    async function shareProduct() {
        const url = location.href.split("#")[0];
        const title = document.title;
        try {
            if (navigator.share) {
                await navigator.share({ title: title, url: url });
                return;
            }
            await navigator.clipboard.writeText(url);
            $("shareMsg").textContent = "Link gekopieerd!";
        } catch (e) {
            if (e && e.name === "AbortError") return;
            $("shareMsg").textContent = url;
        }
    }

    /* ---------------- "laat me weten" ---------------- */

    async function submitNotify(form) {
        const msg = $("notifyMsg");
        const email = String(new FormData(form).get("email") || "").trim();
        msg.className = "muted";
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
            msg.className = "error"; msg.textContent = "Vul een geldig e-mailadres in."; return;
        }
        const btn = form.querySelector("button");
        btn.disabled = true;
        const { error } = await S.sb.rpc("shop_notify_signup", { p_email: email });
        btn.disabled = false;
        if (error) {
            msg.className = "error";
            msg.textContent = "Inschrijven mislukt. Probeer later opnieuw.";
            return;
        }
        form.reset();
        msg.textContent = "Bedankt! We sturen je één mailtje zodra de webshop open is. 💌";
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

    function cartSubtotal() {
        return Math.round(cartLines().reduce(function (s, x) {
            return s + Number(x.product.price) * x.item.quantity;
        }, 0) * 100) / 100;
    }

    function calcTotals() {
        const subtotal = cartSubtotal();
        const disc = discount ? Math.min(subtotal, Number(discount.amount) || 0) : 0;
        const afterDiscount = subtotal - disc;
        let shipping = 0;
        if (deliveryMethod() === "shipping") {
            const freeFrom = settings.free_shipping_from != null ? Number(settings.free_shipping_from) : null;
            shipping = freeFrom != null && afterDiscount >= freeFrom ? 0 : Number(settings.shipping_cost);
        }
        return { subtotal: subtotal, discount: disc, shipping: shipping, total: afterDiscount + shipping };
    }

    async function applyDiscount(code) {
        const msg = $("discountMsg");
        code = String(code || "").trim().toUpperCase();
        if (!code) { discount = null; msg.textContent = ""; renderCart(); return; }
        const seq = ++discountSeq;
        msg.className = "muted";
        msg.textContent = "Controleren…";
        const { data, error } = await S.sb.rpc("shop_check_discount", { p_code: code, p_subtotal: cartSubtotal() });
        if (seq !== discountSeq) return; // intussen een nieuwere controle
        if (error || !data) {
            discount = null;
            msg.className = "error";
            msg.textContent = "De code kon niet gecontroleerd worden.";
        } else if (!data.valid) {
            discount = null;
            msg.className = "error";
            msg.textContent = data.message || "Deze kortingscode is ongeldig.";
        } else {
            discount = { code: data.code, amount: Number(data.amount), label: data.label };
            msg.className = "ok";
            msg.textContent = "✓ " + data.code + ": " + data.label;
        }
        renderCart();
    }

    function renderCart() {
        $("cartBadge").textContent = String(S.cartCount());
        if (!settings) return;

        const lines = cartLines();
        $("cartLines").innerHTML = lines.length
            ? lines.map(function (x) {
                return '<div class="cart-line">' +
                    '<img src="' + S.imageUrl(x.product.image_path) + '" alt="">' +
                    '<div><a class="plain" href="' + productUrl(x.product.slug) + '"><strong>' + S.escapeHtml(x.product.name) + '</strong></a><br>' +
                    '<span class="muted">' + S.euro(x.product.price) + '</span><br>' +
                    '<span class="qty">' +
                    '<button type="button" data-qty="' + x.product.id + '" data-delta="-1" aria-label="Minder">−</button>' +
                    '<span>' + x.item.quantity + '</span>' +
                    '<button type="button" data-qty="' + x.product.id + '" data-delta="1" aria-label="Meer">+</button>' +
                    '</span></div>' +
                    '<strong>' + S.euro(Number(x.product.price) * x.item.quantity) + '</strong></div>';
            }).join("")
            : '<div class="empty-cart">' +
                '<svg viewBox="0 0 160 120" aria-hidden="true">' +
                '<ellipse cx="80" cy="108" rx="58" ry="7" fill="#f1ece6"/>' +
                '<path d="M30 48 h100 l-10 52 a8 8 0 0 1 -8 6 H48 a8 8 0 0 1 -8 -6 Z" fill="#ffd6a5"/>' +
                '<path d="M30 48 h100" stroke="#e8b67c" stroke-width="6" stroke-linecap="round"/>' +
                '<path d="M55 48 C55 18 105 18 105 48" fill="none" stroke="#e8b67c" stroke-width="6" stroke-linecap="round"/>' +
                '<path d="M52 66 v26 M68 66 v26 M84 66 v26 M100 66 v26" stroke="#f3c48d" stroke-width="4" stroke-linecap="round"/>' +
                '<circle cx="40" cy="26" r="4" fill="#ff6f86"/><circle cx="124" cy="20" r="3" fill="#7bd3a4"/>' +
                '<circle cx="136" cy="40" r="4" fill="#8ec5ff"/><circle cx="22" cy="44" r="3" fill="#ffd166"/>' +
                "</svg><h3>Je mandje is nog leeg</h3>" +
                "<p>Ontdek ons sensorisch speelmateriaal en maak er iets moois van.</p>" +
                '<a class="btn" href="./" data-close>Ontdek de producten</a></div>';

        // Voortgang naar gratis verzending
        if (lines.length && settings.shipping_enabled && settings.free_shipping_from != null) {
            const tt = calcTotals();
            const freeFrom = Number(settings.free_shipping_from);
            const left = Math.max(0, freeFrom - (tt.subtotal - tt.discount));
            const pct = Math.min(100, ((tt.subtotal - tt.discount) / freeFrom) * 100);
            $("cartLines").insertAdjacentHTML("afterbegin",
                '<div class="ship-progress"><p>' + (left > 0
                    ? "Nog <strong>" + S.euro(left) + "</strong> tot gratis verzending 📦"
                    : "🎉 Je bestelling wordt <strong>gratis verzonden</strong>!") + "</p>" +
                '<div class="bar"><div style="width:' + pct.toFixed(0) + '%"></div></div></div>');
        }

        const t = calcTotals();
        let html = '<div><span>Subtotaal</span><span>' + S.euro(t.subtotal) + '</span></div>';
        if (t.discount > 0) {
            html += '<div class="discount-row"><span>Korting (' + S.escapeHtml(discount.code) + ')</span><span>− ' + S.euro(t.discount) + '</span></div>';
        }
        if (step === "checkout" && deliveryMethod() === "shipping") {
            html += '<div><span>Verzending</span><span>' + (t.shipping ? S.euro(t.shipping) : "gratis") + '</span></div>';
        } else if (step === "cart" && settings.shipping_enabled && lines.length) {
            html += '<div class="muted"><span>Verzending</span><span>' +
                (settings.pickup_enabled ? "afhalen gratis · " : "") +
                "verzenden " + S.euro(settings.shipping_cost) +
                (settings.free_shipping_from != null ? " (gratis vanaf " + S.euro(settings.free_shipping_from) + ")" : "") +
                '</span></div>';
        }
        html += '<div class="grand"><span>Totaal</span><span>' +
            S.euro(step === "checkout" ? t.total : t.subtotal - t.discount) + '</span></div>';
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
        $("overlay").classList.remove("open");
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
        const typedCode = String(f.get("discount_code") || "").trim().toUpperCase();
        if (typedCode && (!discount || discount.code !== typedCode)) {
            err.textContent = "Klik op \"Toepassen\" om je kortingscode te controleren, of maak het veld leeg."; return;
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
            discount_code: discount ? discount.code : "",
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

    /* ---------------- melding "toegevoegd" ---------------- */

    let toastTimer = null;
    function addedToast(p, qty) {
        let t = $("shopToast");
        if (!t) {
            t = document.createElement("div");
            t.id = "shopToast";
            t.className = "shop-toast";
            t.setAttribute("role", "status");
            document.body.appendChild(t);
        }
        t.innerHTML = '<img src="' + S.imageUrl(p.image_path) + '" alt="">' +
            "<div><strong>Toegevoegd aan je mandje</strong><br><span class=\"muted\">" + qty + " × " +
            S.escapeHtml(p.name) + "</span></div>" +
            '<button class="btn small" type="button" data-open-cart>Bekijk mandje</button>';
        t.classList.add("show");
        const badge = $("cartBadge");
        badge.classList.remove("bump"); void badge.offsetWidth; badge.classList.add("bump");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.remove("show"); }, 4000);
    }

    function addProduct(p, qty, sourceImg) {
        const cur = S.readCart().find(function (i) { return i.product_id === p.id; });
        const have = cur ? cur.quantity : 0;
        const q = Math.min(qty, p.max_per_order - have);
        if (q <= 0) {
            addedToastMax(p);
            return;
        }
        flyToCart(sourceImg);
        S.addToCart(p.id, q);
        addedToast(p, q);
    }

    function addedToastMax(p) {
        addedToast(p, 0);
        $("shopToast").querySelector("strong").textContent = "Maximum bereikt (" + p.max_per_order + " per bestelling)";
    }

    /* ---------------- events ---------------- */

    document.addEventListener("click", function (e) {
        const t = e.target.closest("[data-add],[data-add-qty],[data-add-sticky],[data-qty],[data-close],[data-thumb],[data-cat],[data-share],[data-reset-filters],[data-step],[data-open-cart],#applyDiscount,#zoomWrap");
        if (!t) return;

        if (t.dataset.add) {
            const card = t.closest(".product");
            addProduct(product(t.dataset.add), 1, card ? card.querySelector("img") : null);
        } else if (t.dataset.addQty || t.dataset.addSticky) {
            const p = product(t.dataset.addQty || t.dataset.addSticky);
            const q = Math.max(1, Math.min(p.max_per_order, parseInt($("detailQty").value, 10) || 1));
            addProduct(p, q, $("mainImg"));
        } else if (t.id === "zoomWrap") {
            showLightbox(galleryIndex);
        } else if (t.dataset.step) {
            const inp = $("detailQty");
            const max = parseInt(inp.max, 10) || 99;
            inp.value = String(Math.max(1, Math.min(max, (parseInt(inp.value, 10) || 1) + Number(t.dataset.step))));
        } else if (t.hasAttribute("data-open-cart")) {
            $("shopToast").classList.remove("show");
            openCart();
        } else if (t.dataset.qty) {
            const p = product(t.dataset.qty);
            const cur = S.readCart().find(function (i) { return i.product_id === p.id; });
            const q = Math.max(0, Math.min(p.max_per_order, (cur ? cur.quantity : 0) + Number(t.dataset.delta)));
            S.setQuantity(p.id, q);
        } else if (t.dataset.thumb) {
            $("mainImg").src = t.dataset.thumb;
            galleryIndex = Math.max(0, galleryImages.indexOf(t.dataset.thumb));
            document.querySelectorAll(".thumbs img").forEach(function (im) { im.classList.toggle("active", im === t); });
        }
        else if (t.dataset.cat !== undefined) {
            activeCategory = t.dataset.cat;
            renderCategoryChips(); renderGrid(); syncFilterUrl();
        } else if (t.hasAttribute("data-reset-filters")) {
            activeCategory = ""; searchTerm = "";
            if ($("productSearch")) $("productSearch").value = "";
            renderCategoryChips(); renderGrid(); syncFilterUrl();
        } else if (t.hasAttribute("data-share")) shareProduct();
        else if (t.id === "applyDiscount") applyDiscount($("discountCode").value);
        else if (t.hasAttribute("data-close")) {
            // "Ontdek de producten" in het lege mandje: op de catalogus gewoon sluiten
            if (t.tagName === "A" && $("productGrid")) e.preventDefault();
            closeAll();
        }
    });

    let searchTimer = null;
    document.addEventListener("input", function (e) {
        if (e.target.id === "productSearch") {
            searchTerm = e.target.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function () { renderGrid(); syncFilterUrl(); }, 150);
        }
    });

    let recheckTimer = null;
    document.addEventListener("cart:changed", function () {
        // Maximum per product respecteren
        S.readCart().forEach(function (i) {
            const p = product(i.product_id);
            if (p && i.quantity > p.max_per_order) S.setQuantity(p.id, p.max_per_order);
        });
        // Kortingsbedrag hangt af van het subtotaal: opnieuw controleren
        if (discount) {
            clearTimeout(recheckTimer);
            const code = discount.code;
            recheckTimer = setTimeout(function () { applyDiscount(code); }, 300);
        }
        renderCart();
    });

    document.addEventListener("change", function (e) {
        if (e.target.id === "productSort") {
            sortMode = e.target.value;
            renderGrid(); syncFilterUrl();
        }
        if (e.target.name === "delivery") updateAddressVisibility();
        if (e.target.id === "isCompany") $("companyFields").classList.toggle("hidden", !e.target.checked);
    });

    document.addEventListener("keydown", function (e) {
        const lbOpen = $("lightbox") && $("lightbox").classList.contains("open");
        if (lbOpen) {
            if (e.key === "Escape") closeLightbox();
            else if (e.key === "ArrowLeft") showLightbox(galleryIndex - 1);
            else if (e.key === "ArrowRight") showLightbox(galleryIndex + 1);
            return;
        }
        if ((e.key === "Enter" || e.key === " ") && e.target.id === "zoomWrap") {
            e.preventDefault();
            showLightbox(galleryIndex);
            return;
        }
        if (e.key === "Escape") closeAll();
        if (e.key === "Enter" && e.target.id === "discountCode") {
            e.preventDefault();
            applyDiscount(e.target.value);
        }
    });

    document.addEventListener("DOMContentLoaded", function () {
        $("cartButton").addEventListener("click", openCart);
        $("overlay").addEventListener("click", closeAll);
        $("backButton").addEventListener("click", function () { setStep("cart"); });
        $("nextButton").addEventListener("click", function () {
            if (step === "cart") setStep("checkout");
            else if (!busy) submitOrder();
        });
        $("checkoutStep").addEventListener("submit", function (e) { e.preventDefault(); submitOrder(); });
        if ($("notifyForm")) {
            $("notifyForm").addEventListener("submit", function (e) { e.preventDefault(); submitNotify(e.target); });
        }
        renderCart();
        load();
    });

    window.addEventListener("storage", function () { renderCart(); });
})();
