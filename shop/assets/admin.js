/* =========================================================
   Webshop-admin
   Lezen gebeurt rechtstreeks (RLS: enkel beheerders), acties
   met mails/facturen/terugbetalingen via Edge Function shop-admin.
========================================================= */

(function () {
    "use strict";

    const S = window.SHOP;
    const sb = S.sb;
    const esc = S.escapeHtml;
    const $ = function (id) { return document.getElementById(id); };

    const PAYMENT_LABEL = {
        pending: ["Wacht op betaling", "b-orange"],
        paid: ["Betaald", "b-green"],
        cancelled: ["Geannuleerd", "b-grey"],
        expired: ["Verlopen", "b-grey"],
        failed: ["Mislukt", "b-red"],
        refunded: ["Terugbetaald", "b-blue"],
        partially_refunded: ["Deels terugbetaald", "b-blue"]
    };
    const ORDER_LABEL = {
        new: ["Nieuw", "b-pink"],
        in_production: ["In productie", "b-orange"],
        ready_for_pickup: ["Klaar voor afhaling", "b-blue"],
        shipped: ["Verzonden", "b-blue"],
        completed: ["Afgerond", "b-green"],
        cancelled: ["Geannuleerd", "b-grey"]
    };
    const INVOICE_LABEL = {
        issued: ["Uitgereikt", "b-green"],
        partially_credited: ["Deels gecrediteerd", "b-orange"],
        credited: ["Gecrediteerd", "b-grey"]
    };
    const DEFAULT_SAFETY = "Niet geschikt voor kinderen jonger dan 3 jaar: kleine onderdelen, verstikkingsgevaar. Enkel spelen onder toezicht van een volwassene. Niet eetbaar.";

    let orders = [];
    let invoicesByOrder = {};
    let products = [];
    let settings = null;

    function badge(map, key) {
        const v = map[key] || [key, "b-grey"];
        return '<span class="badge ' + v[1] + '">' + esc(v[0]) + "</span>";
    }

    function toast(msg, isError) {
        const t = $("toast");
        t.textContent = msg;
        t.className = "toast show" + (isError ? " error" : "");
        clearTimeout(toast._t);
        toast._t = setTimeout(function () { t.className = "toast"; }, 3500);
    }

    async function callAdmin(body) {
        const res = await sb.functions.invoke("shop-admin", { body: body });
        if (res.error) {
            let msg = "Actie mislukt.";
            try { const j = await res.error.context.json(); if (j && j.error) msg = j.error; } catch (e) { /* */ }
            throw new Error(msg);
        }
        return res.data;
    }

    function slugify(s) {
        return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    }

    function openDialog(html) {
        $("dialogBody").innerHTML = html;
        $("dialog").classList.add("open");
        $("overlay").classList.add("open");
    }
    function closeDialog() {
        $("dialog").classList.remove("open");
        $("overlay").classList.remove("open");
    }

    /* ======================== AUTH ======================== */

    async function checkAdmin() {
        const { data } = await sb.auth.getSession();
        if (!data || !data.session) return false;
        const { data: ok, error } = await sb.rpc("is_admin");
        if (error || ok !== true) {
            await sb.auth.signOut();
            $("loginError").textContent = "Dit account heeft geen beheerdersrechten.";
            return false;
        }
        return true;
    }

    async function start() {
        if (await checkAdmin()) {
            $("loginView").classList.add("hidden");
            $("appView").classList.remove("hidden");
            $("logoutButton").classList.remove("hidden");
            await loadSettings();
            await Promise.all([loadOrders(), loadProducts()]);
        } else {
            $("loginView").classList.remove("hidden");
            $("appView").classList.add("hidden");
        }
    }

    $("loginForm") && $("loginForm").addEventListener("submit", async function (e) {
        e.preventDefault();
        const f = new FormData(e.target);
        $("loginError").textContent = "";
        const { error } = await sb.auth.signInWithPassword({
            email: String(f.get("email")), password: String(f.get("password"))
        });
        if (error) { $("loginError").textContent = "Aanmelden mislukt."; return; }
        start();
    });

    /* ======================== TABS ======================== */

    function showTab(name) {
        document.querySelectorAll(".tab").forEach(function (t) {
            t.classList.toggle("active", t.dataset.tab === name);
        });
        document.querySelectorAll(".panel").forEach(function (p) {
            p.classList.toggle("hidden", p.id !== "tab-" + name);
        });
        if (name === "invoices") loadInvoices();
        if (name === "overview") loadOverview();
        if (name === "settings") fillSettings();
    }

    /* ======================== BESTELLINGEN ======================== */

    async function loadOrders() {
        const [o, inv] = await Promise.all([
            sb.from("shop_orders").select("*, shop_order_items(*)").order("created_at", { ascending: false }).limit(1000),
            sb.from("shop_invoices").select("id, invoice_number, order_id, pdf_path, status, total, invoice_date")
        ]);
        if (o.error) { toast("Bestellingen laden mislukt.", true); return; }
        orders = o.data || [];
        invoicesByOrder = {};
        (inv.data || []).forEach(function (i) { invoicesByOrder[i.order_id] = i; });
        renderOrders();
    }

    function isTodo(o) {
        return o.payment_status === "paid" && !["completed", "cancelled"].includes(o.order_status);
    }

    function renderOrders() {
        const filter = $("orderFilter").value;
        const q = $("orderSearch").value.trim().toLowerCase();
        $("openCount").textContent = String(orders.filter(isTodo).length || "");

        const list = orders.filter(function (o) {
            if (filter === "todo" && !isTodo(o)) return false;
            if (filter === "paid" && !["paid", "refunded", "partially_refunded"].includes(o.payment_status)) return false;
            if (filter === "unpaid" && ["paid", "refunded", "partially_refunded"].includes(o.payment_status)) return false;
            if (q && !(String(o.order_number) + " " + o.customer_name + " " + o.email).toLowerCase().includes(q)) return false;
            return true;
        });

        $("orderRows").innerHTML = list.length ? list.map(function (o) {
            const inv = invoicesByOrder[o.id];
            return '<tr class="clickable" data-order="' + o.id + '">' +
                "<td><strong>" + esc(o.order_number) + "</strong></td>" +
                "<td>" + new Date(o.created_at).toLocaleDateString("nl-BE") + "</td>" +
                "<td>" + esc(o.customer_name) + '<br><span class="muted">' + esc(o.email) + "</span></td>" +
                "<td>" + (o.delivery_method === "pickup" ? "🏠 Afhalen" : "📮 Verzenden") + "</td>" +
                '<td class="num">' + S.euro(o.total) + "</td>" +
                "<td>" + badge(PAYMENT_LABEL, o.payment_status) + "</td>" +
                "<td>" + badge(ORDER_LABEL, o.order_status) + "</td>" +
                "<td>" + (inv ? esc(inv.invoice_number)
                    : (o.invoice_error ? '<span class="badge b-red">Factuur ontbreekt</span>' : "")) + "</td></tr>";
        }).join("") : '<tr><td colspan="8" class="empty">Geen bestellingen.</td></tr>';
    }

    function orderDetailHtml(o) {
        const inv = invoicesByOrder[o.id];
        const items = (o.shop_order_items || []).map(function (i) {
            return "<tr><td>" + i.quantity + " ×</td><td>" + esc(i.product_name) + '</td><td class="num">' + S.euro(i.line_total) + "</td></tr>";
        }).join("");
        const paid = o.payment_status === "paid";

        let statusButtons = "";
        if (paid) {
            const steps = ["in_production", o.delivery_method === "pickup" ? "ready_for_pickup" : "shipped", "completed"];
            statusButtons = steps.map(function (s) {
                return '<button class="btn small' + (o.order_status === s ? " secondary" : "") + '" type="button" data-set-status="' + s + '">' +
                    esc(ORDER_LABEL[s][0]) + "</button>";
            }).join("");
        }

        return "<h2>Bestelling " + esc(o.order_number) + "</h2>" +
            '<p class="muted">' + new Date(o.created_at).toLocaleString("nl-BE") + " · " +
            badge(PAYMENT_LABEL, o.payment_status) + " " + badge(ORDER_LABEL, o.order_status) + "</p>" +
            '<div class="detail-grid"><div>' +
            "<h3>Klant</h3><p>" + esc(o.customer_name) + "<br>" +
            '<a href="mailto:' + esc(o.email) + '">' + esc(o.email) + "</a>" +
            (o.phone ? "<br>" + esc(o.phone) : "") +
            (o.company_name ? "<br>🏢 " + esc(o.company_name) + (o.company_vat ? " – " + esc(o.company_vat) : "") : "") + "</p>" +
            "<h3>Levering</h3><p>" + (o.delivery_method === "pickup" ? "🏠 Afhalen" :
                "📮 " + esc(o.street) + "<br>" + esc(o.postal_code) + " " + esc(o.city) + " (" + esc(o.country) + ")") +
            (o.tracking_code ? "<br>Track &amp; trace: " + esc(o.tracking_code) : "") + "</p>" +
            (o.customer_note ? "<h3>Opmerking klant</h3><p>" + esc(o.customer_note) + "</p>" : "") +
            "<h3>Interne notitie</h3>" +
            '<textarea id="adminNote" rows="2" maxlength="2000">' + esc(o.admin_note || "") + "</textarea>" +
            '<div class="actions"><button class="btn small secondary" type="button" data-save-note>Notitie opslaan</button></div>' +
            "</div><div>" +
            '<h3>Producten</h3><table class="data">' + items +
            '<tr><td></td><td>Verzending</td><td class="num">' + S.euro(o.shipping_cost) + "</td></tr>" +
            '<tr><td></td><td><strong>Totaal</strong></td><td class="num"><strong>' + S.euro(o.total) + "</strong></td></tr></table>" +

            (paid ? "<h3>Status aanpassen</h3>" +
                (o.delivery_method === "shipping"
                    ? '<label>Track &amp; trace (optioneel)<input id="trackingCode" maxlength="100" value="' + esc(o.tracking_code || "") + '"></label>'
                    : "") +
                '<label class="check"><input type="checkbox" id="notifyCustomer" checked> Klant verwittigen per mail</label>' +
                '<div class="actions">' + statusButtons + "</div>" : "") +

            "<h3>Factuur</h3>" +
            (inv
                ? "<p>" + esc(inv.invoice_number) + " – " + S.formatDate(inv.invoice_date) + " " + badge(INVOICE_LABEL, inv.status) + "</p>" +
                  '<div class="actions">' +
                  '<button class="btn small" type="button" data-download="' + esc(inv.pdf_path || "") + '" data-invoice-order="' + o.id + '">⬇ Pdf</button>' +
                  '<button class="btn small secondary" type="button" data-resend>✉ Opnieuw mailen</button>' +
                  (inv.status !== "credited" ? '<button class="btn small warn" type="button" data-credit="' + inv.id + '">Creditnota / terugbetaling</button>' : "") +
                  "</div>"
                : (["paid", "refunded", "partially_refunded"].includes(o.payment_status)
                    ? '<p class="error">' + esc(o.invoice_error || "Nog geen factuur.") + "</p>" +
                      '<div class="actions"><button class="btn small" type="button" data-retry-invoice>Factuur aanmaken</button></div>'
                    : '<p class="muted">Factuur volgt na betaling.</p>')) +

            '<div class="actions" style="margin-top:18px">' +
            '<button class="btn small secondary" type="button" data-print>🖨 Pakbon</button>' +
            (["pending", "failed", "expired"].includes(o.payment_status)
                ? '<button class="btn small danger" type="button" data-cancel>Bestelling annuleren</button>' : "") +
            (paid && o.order_status !== "cancelled" && !inv
                ? "" : "") +
            "</div></div></div>";
    }

    let currentOrder = null;

    function openOrder(id) {
        currentOrder = orders.find(function (o) { return o.id === id; });
        if (!currentOrder) return;
        openDialog(orderDetailHtml(currentOrder));
    }

    async function refreshCurrent() {
        const id = currentOrder && currentOrder.id;
        await loadOrders();
        if (id && $("dialog").classList.contains("open")) openOrder(id);
    }

    async function orderAction(fn, okMsg) {
        try {
            await fn();
            toast(okMsg);
            await refreshCurrent();
        } catch (e) {
            toast(e.message || "Mislukt.", true);
        }
    }

    function printPackingSlip(o) {
        $("printArea").innerHTML =
            "<h2>" + esc(settings ? settings.business_name : "") + " – Pakbon " + esc(o.order_number) + "</h2>" +
            "<p>" + new Date(o.created_at).toLocaleDateString("nl-BE") + "</p>" +
            "<p><strong>" + esc(o.customer_name) + "</strong><br>" +
            (o.delivery_method === "shipping"
                ? esc(o.street) + "<br>" + esc(o.postal_code) + " " + esc(o.city) + "<br>" + (o.country === "NL" ? "Nederland" : "België")
                : "Afhalen") +
            (o.phone ? "<br>" + esc(o.phone) : "") + "</p>" +
            "<table><tr><th>Aantal</th><th>Product</th></tr>" +
            (o.shop_order_items || []).map(function (i) {
                return "<tr><td>" + i.quantity + "</td><td>" + esc(i.product_name) + "</td></tr>";
            }).join("") + "</table>" +
            (o.customer_note ? "<p><em>Opmerking: " + esc(o.customer_note) + "</em></p>" : "") +
            "<p>Bedankt voor je bestelling! 🌈</p>";
        window.print();
    }

    async function downloadDocument(path, filename) {
        const { data, error } = await sb.storage.from("shop-documents").download(path);
        if (error || !data) { toast("Pdf downloaden mislukt.", true); return; }
        const url = URL.createObjectURL(data);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    }

    /* ---------- creditnota ---------- */

    async function openCreditForm(invoiceId) {
        const { data: inv, error } = await sb.from("shop_invoices").select("*").eq("id", invoiceId).single();
        if (error || !inv) { toast("Factuur niet gevonden.", true); return; }
        const { data: notes } = await sb.from("shop_credit_notes").select("total").eq("invoice_id", invoiceId);
        const credited = (notes || []).reduce(function (s, n) { return s + Number(n.total); }, 0);
        const remaining = Math.round((Number(inv.total) - credited) * 100) / 100;

        const lines = (inv.lines || []).slice();
        if (Number(inv.shipping_cost) > 0) {
            lines.push({ description: "Verzending", quantity: 1, unit_price: Number(inv.shipping_cost) });
        }

        openDialog("<h2>Creditnota voor " + esc(inv.invoice_number) + "</h2>" +
            '<p class="muted">Nog te crediteren: <strong>' + S.euro(remaining) + "</strong>. " +
            "Pas de lijnen aan of verwijder wat je niet wil crediteren.</p>" +
            '<form id="creditForm" class="form-grid">' +
            '<div id="creditLines">' + lines.map(creditLineHtml).join("") + "</div>" +
            '<div><button class="btn small secondary" type="button" data-add-credit-line>+ Lijn</button></div>' +
            '<p>Totaal creditnota: <strong id="creditTotal"></strong></p>' +
            '<label>Reden *<input name="reason" required maxlength="500" placeholder="bv. Herroeping binnen 14 dagen / product beschadigd"></label>' +
            '<label class="check"><input type="checkbox" name="refund" checked> Bedrag ook terugbetalen via Mollie</label>' +
            '<label class="check"><input type="checkbox" name="notify" checked> Creditnota mailen naar de klant</label>' +
            '<div class="error" id="creditError"></div>' +
            '<div class="actions"><button class="btn warn" type="submit">Creditnota aanmaken</button>' +
            '<button class="btn secondary" type="button" data-back-order>Annuleren</button></div>' +
            "</form>");
        $("creditForm").dataset.invoice = invoiceId;
        $("creditForm").dataset.max = String(remaining);
        updateCreditTotal();
    }

    function creditLineHtml(l) {
        return '<div class="credit-line">' +
            '<input data-f="description" maxlength="200" value="' + esc(l.description || "") + '" placeholder="Omschrijving">' +
            '<input data-f="quantity" type="number" min="1" max="99" value="' + (l.quantity || 1) + '">' +
            '<input data-f="unit_price" type="number" min="0.01" step="0.01" value="' + Number(l.unit_price || 0).toFixed(2) + '">' +
            '<button class="icon-btn" type="button" data-remove-line aria-label="Verwijderen">×</button></div>';
    }

    function readCreditLines() {
        return Array.from(document.querySelectorAll("#creditLines .credit-line")).map(function (row) {
            return {
                description: row.querySelector('[data-f="description"]').value.trim(),
                quantity: parseInt(row.querySelector('[data-f="quantity"]').value, 10),
                unit_price: Math.round(parseFloat(row.querySelector('[data-f="unit_price"]').value) * 100) / 100
            };
        });
    }

    function updateCreditTotal() {
        const total = readCreditLines().reduce(function (s, l) {
            return s + (l.quantity > 0 && l.unit_price > 0 ? l.quantity * l.unit_price : 0);
        }, 0);
        if ($("creditTotal")) $("creditTotal").textContent = S.euro(total);
        return total;
    }

    async function submitCredit(form) {
        const lines = readCreditLines();
        const err = $("creditError");
        err.textContent = "";
        if (!lines.length || lines.some(function (l) { return !l.description || !(l.quantity > 0) || !(l.unit_price > 0); })) {
            err.textContent = "Elke lijn heeft een omschrijving, aantal en positief bedrag nodig."; return;
        }
        const total = updateCreditTotal();
        if (total > Number(form.dataset.max) + 0.001) {
            err.textContent = "Het totaal is hoger dan wat nog gecrediteerd kan worden."; return;
        }
        const f = new FormData(form);
        if (!String(f.get("reason") || "").trim()) { err.textContent = "Geef een reden op."; return; }
        if (!confirm("Creditnota van " + S.euro(total) + " aanmaken" +
            (form.elements.refund.checked ? " en terugbetalen via Mollie" : "") + "? Dit kan niet ongedaan gemaakt worden.")) return;

        form.querySelector('button[type="submit"]').disabled = true;
        try {
            const res = await callAdmin({
                action: "credit_note",
                invoice_id: form.dataset.invoice,
                lines: lines,
                reason: f.get("reason"),
                refund: form.elements.refund.checked,
                notify: form.elements.notify.checked
            });
            if (res.refund_error) toast("Creditnota gemaakt, maar: " + res.refund_error, true);
            else toast("Creditnota " + res.credit_note.credit_number + " aangemaakt.");
            await refreshCurrent();
        } catch (e) {
            err.textContent = e.message;
            form.querySelector('button[type="submit"]').disabled = false;
        }
    }

    /* ======================== PRODUCTEN ======================== */

    async function loadProducts() {
        const { data, error } = await sb.from("shop_products").select("*").order("sort_order").order("name");
        if (error) { toast("Producten laden mislukt.", true); return; }
        products = data || [];
        $("productRows").innerHTML = products.length ? products.map(function (p) {
            return '<tr class="clickable" data-product="' + p.id + '">' +
                '<td><img src="' + S.imageUrl(p.image_path) + '" alt=""></td>' +
                "<td><strong>" + esc(p.name) + '</strong><br><span class="muted">' + esc(p.short_text || "") + "</span></td>" +
                '<td class="num">' + S.euro(p.price) + "</td>" +
                "<td>" + p.max_per_order + "</td><td>" + p.sort_order + "</td>" +
                "<td>" + (p.active ? '<span class="badge b-green">Zichtbaar</span>' : '<span class="badge b-grey">Verborgen</span>') + "</td>" +
                '<td><button class="btn small secondary" type="button" data-product="' + p.id + '">Bewerken</button></td></tr>';
        }).join("") : '<tr><td colspan="7" class="empty">Nog geen producten. Klik op "+ Nieuw product".</td></tr>';
    }

    let editImages = { main: null, extra: [] };

    function openProduct(id) {
        const p = products.find(function (x) { return x.id === id; }) || {
            name: "", slug: "", short_text: "", description: "", safety_note: DEFAULT_SAFETY,
            price: "", max_per_order: 10, weight_grams: "", sort_order: (products.length + 1) * 10,
            active: false, image_path: null, extra_images: []
        };
        editImages = { main: p.image_path, extra: (p.extra_images || []).slice() };

        openDialog("<h2>" + (p.id ? "Product bewerken" : "Nieuw product") + "</h2>" +
            '<form id="productForm" class="form-grid">' +
            '<div class="form-row"><label>Naam *<input name="name" required maxlength="120" value="' + esc(p.name) + '"></label>' +
            '<label>Webadres (slug) *<input name="slug" required maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="' + esc(p.slug) + '"></label></div>' +
            '<label>Korte tekst (op het overzicht)<input name="short_text" maxlength="300" value="' + esc(p.short_text || "") + '"></label>' +
            '<label>Beschrijving<textarea name="description" rows="5" maxlength="5000">' + esc(p.description || "") + "</textarea></label>" +
            '<label>Veiligheidswaarschuwing<textarea name="safety_note" rows="2" maxlength="500">' + esc(p.safety_note || "") + "</textarea></label>" +
            '<div class="form-row"><label>Prijs (€) *<input name="price" type="number" min="0" max="10000" step="0.01" required value="' + esc(p.price) + '"></label>' +
            '<label>Max. per bestelling<input name="max_per_order" type="number" min="1" max="99" value="' + esc(p.max_per_order) + '"></label></div>' +
            '<div class="form-row"><label>Gewicht (gram, optioneel)<input name="weight_grams" type="number" min="0" value="' + esc(p.weight_grams == null ? "" : p.weight_grams) + '"></label>' +
            '<label>Volgorde<input name="sort_order" type="number" value="' + esc(p.sort_order) + '"></label></div>' +
            "<div><strong>Foto's</strong> <span class=\"muted\">(eerste = hoofdfoto, jpg/png/webp, max 10 MB)</span>" +
            '<div class="img-list" id="imgList"></div>' +
            '<input type="file" id="imgUpload" accept="image/jpeg,image/png,image/webp" multiple style="margin-top:8px"></div>' +
            '<label class="check"><input type="checkbox" name="active"' + (p.active ? " checked" : "") + "> Zichtbaar in de webshop</label>" +
            '<div class="error" id="productError"></div>' +
            '<div class="actions"><button class="btn" type="submit">Opslaan</button>' +
            (p.id ? '<button class="btn danger" type="button" data-delete-product>Verwijderen</button>' : "") +
            "</div></form>");
        $("productForm").dataset.id = p.id || "";
        renderImgList();
    }

    function renderImgList() {
        const all = [editImages.main].concat(editImages.extra).filter(Boolean);
        $("imgList").innerHTML = all.map(function (path, i) {
            return '<figure><img src="' + S.imageUrl(path) + '" alt="">' +
                '<button type="button" data-remove-img="' + i + '" aria-label="Foto verwijderen">×</button></figure>';
        }).join("") || '<span class="muted">Nog geen foto\'s.</span>';
    }

    async function uploadImages(files) {
        for (const file of files) {
            if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 10 * 1024 * 1024) {
                toast(file.name + ": enkel jpg/png/webp tot 10 MB.", true);
                continue;
            }
            const ext = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
            const path = "products/" + Date.now() + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
            const { error } = await sb.storage.from("shop-products").upload(path, file, { contentType: file.type });
            if (error) { toast("Upload mislukt: " + error.message, true); continue; }
            if (!editImages.main) editImages.main = path; else editImages.extra.push(path);
        }
        renderImgList();
    }

    async function saveProduct(form) {
        const f = new FormData(form);
        const err = $("productError");
        err.textContent = "";
        const row = {
            name: String(f.get("name")).trim(),
            slug: slugify(f.get("slug")),
            short_text: String(f.get("short_text")).trim() || null,
            description: String(f.get("description")).trim() || null,
            safety_note: String(f.get("safety_note")).trim() || null,
            price: Math.round(parseFloat(f.get("price")) * 100) / 100,
            max_per_order: parseInt(f.get("max_per_order"), 10) || 10,
            weight_grams: f.get("weight_grams") === "" ? null : parseInt(f.get("weight_grams"), 10),
            sort_order: parseInt(f.get("sort_order"), 10) || 0,
            active: form.elements.active.checked,
            image_path: editImages.main,
            extra_images: editImages.extra
        };
        if (!row.name || !row.slug || !(row.price >= 0)) { err.textContent = "Naam, webadres en prijs zijn verplicht."; return; }

        const id = form.dataset.id;
        const res = id
            ? await sb.from("shop_products").update(row).eq("id", id)
            : await sb.from("shop_products").insert(row);
        if (res.error) {
            err.textContent = res.error.code === "23505" ? "Dit webadres (slug) bestaat al." : "Opslaan mislukt: " + res.error.message;
            return;
        }
        toast("Product opgeslagen.");
        closeDialog();
        loadProducts();
    }

    async function deleteProduct(id) {
        if (!confirm("Product definitief verwijderen? (Tip: verbergen kan ook.) Bestaande bestellingen en facturen blijven bewaard.")) return;
        const { error } = await sb.from("shop_products").delete().eq("id", id);
        if (error) { toast("Verwijderen mislukt: " + error.message, true); return; }
        toast("Product verwijderd.");
        closeDialog();
        loadProducts();
    }

    /* ======================== FACTUREN ======================== */

    let invoiceDocs = [];

    function periodRange() {
        const y = parseInt($("invYear").value, 10);
        const p = $("invPeriod").value;
        let from = new Date(Date.UTC(y, 0, 1)), to = new Date(Date.UTC(y + 1, 0, 1));
        if (p[0] === "q") {
            const q = parseInt(p.slice(1), 10) - 1;
            from = new Date(Date.UTC(y, q * 3, 1)); to = new Date(Date.UTC(y, q * 3 + 3, 1));
        } else if (p[0] === "m") {
            const m = parseInt(p.slice(1), 10) - 1;
            from = new Date(Date.UTC(y, m, 1)); to = new Date(Date.UTC(y, m + 1, 1));
        }
        return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
    }

    async function loadInvoices() {
        const range = periodRange();
        const [inv, cn] = await Promise.all([
            sb.from("shop_invoices").select("*").gte("invoice_date", range[0]).lt("invoice_date", range[1]).order("invoice_number"),
            sb.from("shop_credit_notes").select("*, shop_invoices(invoice_number, customer, order_id)")
                .gte("credit_date", range[0]).lt("credit_date", range[1]).order("credit_number")
        ]);
        if (inv.error || cn.error) { toast("Facturen laden mislukt.", true); return; }

        invoiceDocs = (inv.data || []).map(function (i) {
            return { kind: "Factuur", number: i.invoice_number, date: i.invoice_date, customer: i.customer,
                order: i.customer.order_number, amount: Number(i.total), status: i.status, pdf: i.pdf_path,
                order_id: i.order_id, ref: "" };
        }).concat((cn.data || []).map(function (c) {
            const parent = c.shop_invoices || {};
            return { kind: "Creditnota", number: c.credit_number, date: c.credit_date, customer: parent.customer || {},
                order: (parent.customer || {}).order_number, amount: -Number(c.total), status: "credit",
                pdf: c.pdf_path, order_id: parent.order_id, ref: parent.invoice_number, reason: c.reason };
        })).sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.number.localeCompare(b.number); });

        const invoiced = invoiceDocs.filter(function (d) { return d.amount > 0; }).reduce(function (s, d) { return s + d.amount; }, 0);
        const credited = invoiceDocs.filter(function (d) { return d.amount < 0; }).reduce(function (s, d) { return s - d.amount; }, 0);
        $("invoiceStats").innerHTML =
            stat("Gefactureerd", S.euro(invoiced)) + stat("Gecrediteerd", S.euro(credited)) +
            stat("Netto omzet", S.euro(invoiced - credited)) +
            stat("Aantal documenten", String(invoiceDocs.length));

        $("invoiceRows").innerHTML = invoiceDocs.length ? invoiceDocs.map(function (d, idx) {
            return "<tr><td><strong>" + esc(d.number) + "</strong></td><td>" + S.formatDate(d.date) + "</td>" +
                "<td>" + (d.kind === "Factuur" ? '<span class="badge b-green">Factuur</span>' : '<span class="badge b-orange">Creditnota</span>' +
                    '<br><span class="muted">op ' + esc(d.ref) + "</span>") + "</td>" +
                "<td>" + esc(d.customer.company_name || d.customer.name || "") + "</td>" +
                "<td>" + esc(d.order || "") + "</td>" +
                '<td class="num">' + S.euro(d.amount) + "</td>" +
                "<td>" + (d.kind === "Factuur" ? badge(INVOICE_LABEL, d.status) : "") + "</td>" +
                '<td><button class="btn small secondary" type="button" data-doc="' + idx + '">⬇ Pdf</button></td></tr>';
        }).join("") : '<tr><td colspan="8" class="empty">Geen facturen in deze periode.</td></tr>';
    }

    function stat(label, value) {
        return '<div class="stat"><div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + "</div></div>";
    }

    function exportCsv() {
        if (!invoiceDocs.length) { toast("Geen documenten om te exporteren.", true); return; }
        const sep = ";";
        const cell = function (v) {
            const s = String(v == null ? "" : v);
            return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const rows = [["Soort", "Nummer", "Datum", "Klant", "Bedrijf", "Ondernemingsnr klant", "E-mail",
            "Bestelling", "Op factuur", "Bedrag", "Reden"]];
        invoiceDocs.forEach(function (d) {
            rows.push([d.kind, d.number, S.formatDate(d.date), d.customer.name, d.customer.company_name,
                d.customer.company_vat, d.customer.email, d.order, d.ref,
                d.amount.toFixed(2).replace(".", ","), d.reason || ""]);
        });
        const csv = "\uFEFF" + rows.map(function (r) { return r.map(cell).join(sep); }).join("\r\n");
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "webshop-facturen-" + $("invYear").value + "-" + $("invPeriod").value + ".csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    async function downloadDoc(d) {
        if (d.pdf) { downloadDocument(d.pdf, d.number + ".pdf"); return; }
        if (d.kind === "Factuur") {
            try {
                const res = await callAdmin({ action: "retry_invoice", order_id: d.order_id });
                downloadDocument(res.invoice.pdf_path, d.number + ".pdf");
                loadInvoices();
            } catch (e) { toast(e.message, true); }
        } else {
            toast("De pdf van deze creditnota wordt nog aangemaakt; probeer zo opnieuw.", true);
        }
    }

    /* ======================== OVERZICHT ======================== */

    async function loadOverview() {
        const year = new Date().getFullYear();
        const from = year + "-01-01", to = (year + 1) + "-01-01";

        const [inv, cn, appts, items] = await Promise.all([
            sb.from("shop_invoices").select("total").gte("invoice_date", from).lt("invoice_date", to),
            sb.from("shop_credit_notes").select("total").gte("credit_date", from).lt("credit_date", to),
            sb.from("appointments").select("amount, payment_status, appointment_date")
                .gte("appointment_date", from).lt("appointment_date", to).eq("payment_status", "paid"),
            sb.from("shop_order_items").select("product_name, quantity, line_total, shop_orders!inner(payment_status, created_at)")
                .eq("shop_orders.payment_status", "paid").gte("shop_orders.created_at", from)
        ]);

        const shopNet = (inv.data || []).reduce(function (s, r) { return s + Number(r.total); }, 0) -
            (cn.data || []).reduce(function (s, r) { return s + Number(r.total); }, 0);
        const bookings = appts.error ? null : (appts.data || []).reduce(function (s, r) { return s + Number(r.amount || 0); }, 0);
        const total = shopNet + (bookings || 0);
        const threshold = Number(settings ? settings.vat_threshold : 25000) || 25000;
        const pct = Math.min(100, (total / threshold) * 100);

        $("overviewStats").innerHTML =
            stat("Webshop netto " + year, S.euro(shopNet)) +
            stat("Inschrijvingen betaald " + year, bookings == null ? "n.v.t." : S.euro(bookings)) +
            stat("Totaal " + year, S.euro(total)) +
            stat("Te behandelen bestellingen", String(orders.filter(isTodo).length));

        const bar = $("thresholdBar");
        bar.style.width = pct.toFixed(1) + "%";
        bar.className = "bar-fill" + (pct >= 90 ? " danger" : pct >= 75 ? " warn" : "");
        $("thresholdText").textContent = S.euro(total) + " van " + S.euro(threshold) + " (" + pct.toFixed(0) + "%)" +
            (bookings == null ? " – omzet inschrijvingen kon niet geladen worden." : "") +
            " Contante betalingen ter plaatse die niet als 'betaald' geregistreerd zijn, tellen hier niet mee.";

        const agg = {};
        (items.data || []).forEach(function (i) {
            agg[i.product_name] = agg[i.product_name] || { q: 0, t: 0 };
            agg[i.product_name].q += i.quantity;
            agg[i.product_name].t += Number(i.line_total);
        });
        const top = Object.keys(agg).map(function (k) { return [k, agg[k]]; })
            .sort(function (a, b) { return b[1].q - a[1].q; }).slice(0, 10);
        $("topProducts").innerHTML = top.length
            ? '<table class="data">' + top.map(function (t) {
                return "<tr><td>" + esc(t[0]) + "</td><td>" + t[1].q + ' stuks</td><td class="num">' + S.euro(t[1].t) + "</td></tr>";
            }).join("") + "</table>"
            : '<p class="muted">Nog geen verkopen dit jaar.</p>';
    }

    /* ======================== INSTELLINGEN ======================== */

    async function loadSettings() {
        const { data } = await sb.from("shop_settings").select("*").eq("id", 1).maybeSingle();
        settings = data;
    }

    function fillSettings() {
        if (!settings) return;
        const form = $("settingsForm");
        Array.from(form.elements).forEach(function (el) {
            if (!el.name || !(el.name in settings)) return;
            if (el.type === "checkbox") el.checked = !!settings[el.name];
            else el.value = settings[el.name] == null ? "" : settings[el.name];
        });
    }

    async function saveSettings(form) {
        const f = new FormData(form);
        const num = function (k) { const v = f.get(k); return v === "" || v == null ? null : Math.round(parseFloat(v) * 100) / 100; };
        const row = {
            show_on_site: form.elements.show_on_site.checked,
            shop_open: form.elements.shop_open.checked,
            pickup_enabled: form.elements.pickup_enabled.checked,
            shipping_enabled: form.elements.shipping_enabled.checked,
            shipping_cost: num("shipping_cost") || 0,
            free_shipping_from: num("free_shipping_from"),
            pickup_info: String(f.get("pickup_info")).trim(),
            lead_time_text: String(f.get("lead_time_text")).trim(),
            announcement: String(f.get("announcement")).trim() || null,
            business_name: String(f.get("business_name")).trim(),
            business_address: String(f.get("business_address")).trim(),
            enterprise_number: String(f.get("enterprise_number")).trim(),
            iban: String(f.get("iban")).trim(),
            business_email: String(f.get("business_email")).trim(),
            business_phone: String(f.get("business_phone")).trim(),
            vat_exempt_text: String(f.get("vat_exempt_text")).trim(),
            invoice_footer: String(f.get("invoice_footer")).trim(),
            vat_threshold: num("vat_threshold") || 25000
        };
        $("settingsError").textContent = "";
        if (!row.pickup_enabled && !row.shipping_enabled && row.shop_open) {
            $("settingsError").textContent = "Zet minstens afhalen of verzenden aan."; return;
        }
        if (row.shop_open && (!row.enterprise_number || !row.business_address)) {
            $("settingsError").textContent = "Vul eerst je ondernemingsnummer en adres in (verplicht op facturen) voor je de shop opent."; return;
        }
        const { error } = await sb.from("shop_settings").update(row).eq("id", 1);
        if (error) { $("settingsError").textContent = "Opslaan mislukt: " + error.message; return; }
        await loadSettings();
        toast("Instellingen opgeslagen.");
    }

    /* ======================== EVENTS ======================== */

    document.addEventListener("click", function (e) {
        const t = e.target.closest("button, tr[data-order], tr[data-product], [data-close]");
        if (!t) return;
        const d = t.dataset;

        if (d.tab) showTab(d.tab);
        else if (t.hasAttribute("data-close")) closeDialog();
        else if (d.order) openOrder(d.order);
        else if (d.product) openProduct(d.product);
        else if (d.setStatus) {
            const notify = $("notifyCustomer") ? $("notifyCustomer").checked : false;
            orderAction(function () {
                return callAdmin({
                    action: "set_status", order_id: currentOrder.id, status: d.setStatus, notify: notify,
                    tracking_code: $("trackingCode") ? $("trackingCode").value : ""
                });
            }, "Status bijgewerkt" + (notify ? " en klant verwittigd." : "."));
        }
        else if (t.hasAttribute("data-save-note")) {
            orderAction(async function () {
                const { error } = await sb.from("shop_orders").update({ admin_note: $("adminNote").value || null }).eq("id", currentOrder.id);
                if (error) throw new Error(error.message);
            }, "Notitie opgeslagen.");
        }
        else if (t.hasAttribute("data-resend")) {
            orderAction(function () { return callAdmin({ action: "resend_invoice", order_id: currentOrder.id }); }, "Factuur opnieuw gemaild.");
        }
        else if (t.hasAttribute("data-retry-invoice")) {
            orderAction(function () { return callAdmin({ action: "retry_invoice", order_id: currentOrder.id }); }, "Factuur aangemaakt.");
        }
        else if (t.hasAttribute("data-cancel")) {
            if (confirm("Deze onbetaalde bestelling annuleren?")) {
                orderAction(function () { return callAdmin({ action: "cancel_order", order_id: currentOrder.id }); }, "Bestelling geannuleerd.");
            }
        }
        else if (d.invoiceOrder !== undefined && t.hasAttribute("data-download")) {
            const inv = invoicesByOrder[currentOrder.id];
            downloadDoc({ kind: "Factuur", pdf: d.download, number: inv.invoice_number, order_id: currentOrder.id });
        }
        else if (t.hasAttribute("data-print")) printPackingSlip(currentOrder);
        else if (d.credit) openCreditForm(d.credit);
        else if (t.hasAttribute("data-back-order")) openOrder(currentOrder.id);
        else if (t.hasAttribute("data-add-credit-line")) {
            $("creditLines").insertAdjacentHTML("beforeend", creditLineHtml({ description: "", quantity: 1, unit_price: 0 }));
        }
        else if (t.hasAttribute("data-remove-line")) { t.closest(".credit-line").remove(); updateCreditTotal(); }
        else if (d.removeImg !== undefined) {
            const all = [editImages.main].concat(editImages.extra).filter(Boolean);
            all.splice(parseInt(d.removeImg, 10), 1);
            editImages = { main: all[0] || null, extra: all.slice(1) };
            renderImgList();
        }
        else if (t.hasAttribute("data-delete-product")) deleteProduct($("productForm").dataset.id);
        else if (d.doc !== undefined) downloadDoc(invoiceDocs[parseInt(d.doc, 10)]);
        else if (t.id === "newProduct") openProduct(null);
        else if (t.id === "reloadOrders") loadOrders();
        else if (t.id === "exportCsv") exportCsv();
        else if (t.id === "logoutButton") sb.auth.signOut().then(function () { location.reload(); });
    });

    document.addEventListener("input", function (e) {
        if (e.target.closest("#creditLines")) updateCreditTotal();
        if (e.target.id === "orderSearch") renderOrders();
        if (e.target.name === "name" && e.target.form && e.target.form.id === "productForm" && !e.target.form.dataset.id) {
            e.target.form.elements.slug.value = slugify(e.target.value);
        }
    });

    document.addEventListener("change", function (e) {
        if (e.target.id === "orderFilter") renderOrders();
        if (e.target.id === "invYear" || e.target.id === "invPeriod") loadInvoices();
        if (e.target.id === "imgUpload") uploadImages(Array.from(e.target.files || []));
    });

    document.addEventListener("submit", function (e) {
        e.preventDefault();
        if (e.target.id === "productForm") saveProduct(e.target);
        else if (e.target.id === "settingsForm") saveSettings(e.target);
        else if (e.target.id === "creditForm") submitCredit(e.target);
    });

    $("overlay").addEventListener("click", closeDialog);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDialog(); });

    // Jaarkeuze facturen
    const thisYear = new Date().getFullYear();
    for (let y = thisYear; y >= 2026; y--) {
        $("invYear").insertAdjacentHTML("beforeend", '<option value="' + y + '">' + y + "</option>");
    }

    start();
})();
