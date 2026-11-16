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
        shipped: ["Verzonden (post)", "b-blue"],
        out_for_delivery: ["Onderweg", "b-blue"],
        delivered: ["Afgeleverd", "b-green"],
        completed: ["Afgerond", "b-green"],
        cancelled: ["Geannuleerd", "b-grey"]
    };
    // Statussen waarbij de bestelling "klaar" is (niets meer te doen)
    const DONE_STATUSES = ["delivered", "completed", "cancelled"];
    const INVOICE_LABEL = {
        issued: ["Uitgereikt", "b-green"],
        partially_credited: ["Deels gecrediteerd", "b-orange"],
        credited: ["Gecrediteerd", "b-grey"]
    };
    const DEFAULT_SAFETY = "Niet geschikt voor kinderen jonger dan 3 jaar: kleine onderdelen, verstikkingsgevaar. Enkel spelen onder toezicht van een volwassene. Niet eetbaar.";

    let orders = [];
    let invoicesByOrder = {};
    let products = [];
    let categories = [];
    let discounts = [];
    let waitlist = [];
    let withdrawals = [];
    let settings = null;

    function badge(map, key) {
        const v = map[key] || [key, "b-grey"];
        return '<span class="badge ' + v[1] + '">' + esc(v[0]) + "</span>";
    }

    function toast(msg, isError) {
        const t = $("toast");
        t.textContent = (isError ? "⚠️ " : "✓ ") + msg;
        t.className = "toast show" + (isError ? " error" : "");
        clearTimeout(toast._t);
        toast._t = setTimeout(function () { t.className = "toast"; }, isError ? 6000 : 3500);
    }

    function relTime(iso) {
        const d = new Date(iso), now = new Date();
        const days = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
            new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
        const time = d.toLocaleTimeString("nl-BE", { hour: "2-digit", minute: "2-digit" });
        if (days === 0) {
            const mins = Math.round((now - d) / 60000);
            if (mins < 1) return "zonet";
            if (mins < 60) return mins + " min geleden";
            return "vandaag " + time;
        }
        if (days === 1) return "gisteren " + time;
        if (days < 7) return days + " dagen geleden";
        return d.toLocaleDateString("nl-BE");
    }

    function isPaidLike(o) {
        return ["paid", "refunded", "partially_refunded"].includes(o.payment_status);
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

    let dialogDirty = false;

    function openDialog(html) {
        $("dialogBody").innerHTML = html;
        $("dialog").classList.add("open");
        $("overlay").classList.add("open");
        dialogDirty = false;
        const first = $("dialogBody").querySelector("input:not([type=hidden]), textarea, select");
        if (first && first.closest("form")) setTimeout(function () { first.focus(); }, 50);
    }
    function closeDialog(force) {
        if (!$("dialog").classList.contains("open")) return;
        if (dialogDirty && force !== true && !confirm("Je hebt niet-opgeslagen wijzigingen. Toch sluiten?")) return;
        dialogDirty = false;
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
            const { data: u } = await sb.auth.getUser();
            if (u && u.user) {
                $("userChip").textContent = "👤 " + u.user.email;
                $("userChip").classList.remove("hidden");
            }
            await loadSettings();
            renderShopState();
            await loadCategories();
            await Promise.all([loadOrders(), loadProducts(), loadWaitlist()]);
            loadMailStatus();
            const fromHash = location.hash.slice(1);
            if (!openOrderFromHash()) {
                showTab(document.getElementById("tab-" + fromHash) ? fromHash : "dashboard");
            }
        } else {
            $("loginView").classList.remove("hidden");
            $("appView").classList.add("hidden");
        }
    }

    /* ---------- e-mail ---------- */

    let mailProvider = "unknown";

    async function loadMailStatus() {
        try {
            const res = await callAdmin({ action: "mail_status" });
            mailProvider = res.provider || null;
        } catch (e) {
            mailProvider = "unknown";
        }
        renderMailStatus();
        if (!$("tab-dashboard").classList.contains("hidden")) renderDashboard();
    }

    function renderMailStatus() {
        const el = $("mailStatus");
        if (!el) return;
        if (mailProvider === "smtp") el.innerHTML = '<span class="badge b-green">Actief</span> Mails worden verstuurd via SMTP (Gmail).';
        else if (mailProvider === "emailjs") el.innerHTML = '<span class="badge b-green">Actief</span> Mails worden verstuurd via EmailJS.';
        else if (mailProvider === null) el.innerHTML = '<span class="badge b-red">Niet ingesteld</span> Er worden geen webshopmails verstuurd.';
        else el.textContent = "Status kon niet opgevraagd worden.";
    }

    async function sendTestMail() {
        const btn = $("sendTestMail");
        btn.disabled = true;
        try {
            const res = await callAdmin({ action: "test_email", to: $("testMailTo").value.trim() });
            toast("Testmail verstuurd naar " + res.to + ". Kijk ook in je spam.");
        } catch (e) {
            toast(e.message, true);
        }
        btn.disabled = false;
    }

    /* ---------- webshop open/dicht in de kop ---------- */

    // Link van de QR-code op label/pakbon: admin.html#order=B2026-0042
    function openOrderFromHash() {
        const m = location.hash.match(/^#order=(.+)$/);
        if (!m) return false;
        const nr = decodeURIComponent(m[1]);
        const o = orders.find(function (x) { return x.order_number === nr; });
        showTab("orders");
        orderFilter = "all";
        renderOrders();
        if (o) openOrder(o.id); else toast("Bestelling " + nr + " niet gevonden.", true);
        return true;
    }
    window.addEventListener("hashchange", function () {
        if (!$("appView").classList.contains("hidden")) openOrderFromHash();
    });

    function renderShopState() {
        const b = $("shopStateButton");
        if (!settings) return;
        b.classList.remove("hidden");
        b.classList.toggle("open", !!settings.shop_open);
        b.innerHTML = '<span class="dot"></span>' + (settings.shop_open ? "Shop open" : "Shop gesloten");
    }

    async function toggleShopState() {
        const open = !settings.shop_open;
        if (open && (!settings.enterprise_number || !settings.business_address)) {
            toast("Vul eerst je ondernemingsnummer en adres in bij Instellingen.", true);
            showTab("settings");
            return;
        }
        if (open && !settings.pickup_enabled && !settings.shipping_enabled) {
            toast("Zet eerst afhalen of verzenden aan bij Instellingen.", true);
            showTab("settings");
            return;
        }
        if (!confirm(open ? "De webshop openen? Klanten kunnen dan bestellen en betalen."
            : "De webshop sluiten? Klanten kunnen dan niet meer bestellen.")) return;
        const { error } = await sb.from("shop_settings").update({ shop_open: open }).eq("id", 1);
        if (error) { toast("Mislukt: " + error.message, true); return; }
        await loadSettings();
        renderShopState();
        toast(open ? "De webshop is open." : "De webshop is gesloten.");
        if (!$("tab-dashboard").classList.contains("hidden")) renderDashboard();
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
            t.setAttribute("aria-selected", t.dataset.tab === name ? "true" : "false");
        });
        document.querySelectorAll(".panel").forEach(function (p) {
            p.classList.toggle("hidden", p.id !== "tab-" + name);
        });
        history.replaceState(null, "", "#" + name);
        window.scrollTo(0, 0);
        if (name === "dashboard") renderDashboard();
        if (name === "production") renderProduction();
        if (name === "deliveries") renderDeliveries();
        if (name === "settings") renderMailStatus();
        if (name === "invoices") loadInvoices();
        if (name === "discounts") loadDiscounts();
        if (name === "waitlist") loadWaitlist();
        if (name === "overview") loadOverview();
        if (name === "settings") fillSettings();
    }

    /* ======================== DASHBOARD ======================== */

    function dayKey(d) {
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    function sumOrders(list) {
        return list.reduce(function (s, o) { return s + Number(o.total); }, 0);
    }

    function kpi(icon, label, value, sub, cls) {
        return '<div class="kpi ' + (cls || "") + '"><div class="kpi-icon">' + icon + "</div><div>" +
            '<div class="label">' + esc(label) + '</div><div class="value">' + esc(value) + "</div>" +
            (sub ? '<div class="sub">' + sub + "</div>" : "") + "</div></div>";
    }

    function trend(now, before) {
        if (!before) return now ? '<span class="up">nieuw</span>' : '<span class="muted">–</span>';
        const pct = Math.round((now - before) / before * 100);
        return '<span class="' + (pct >= 0 ? "up" : "down") + '">' + (pct >= 0 ? "▲ " : "▼ ") + Math.abs(pct) + "%</span> t.o.v. vorige maand";
    }

    function renderDashboard() {
        const now = new Date();
        const hour = now.getHours();
        $("greeting").textContent = (hour < 12 ? "Goeiemorgen" : hour < 18 ? "Goeiemiddag" : "Goeieavond") + " 👋";
        $("todayLine").textContent = now.toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

        const paid = orders.filter(function (o) { return isPaidLike(o); });
        const at = function (o) { return new Date(o.paid_at || o.created_at); };
        const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const sameDayPrev = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate(), 23, 59);

        const today = paid.filter(function (o) { return at(o) >= startToday; });
        const month = paid.filter(function (o) { return at(o) >= startMonth; });
        const prevMonth = paid.filter(function (o) { return at(o) >= startPrevMonth && at(o) <= sameDayPrev; });
        const todo = orders.filter(isTodo);
        const avg = month.length ? sumOrders(month) / month.length : 0;

        $("kpis").innerHTML =
            kpi("💶", "Omzet vandaag", S.euro(sumOrders(today)), today.length + " bestelling" + (today.length === 1 ? "" : "en")) +
            kpi("📈", "Omzet deze maand", S.euro(sumOrders(month)), trend(sumOrders(month), sumOrders(prevMonth))) +
            kpi("🧺", "Gem. bestelling", S.euro(avg), month.length + " betaalde bestellingen deze maand") +
            kpi("📦", "Te behandelen", String(todo.length), todo.length ? '<button class="link-btn" type="button" data-goto-orders="todo">Bekijk →</button>' : "Alles afgehandeld 🎉",
                todo.length ? "attention" : "");

        // Grafiek: 30 dagen
        const days = [];
        for (let i = 29; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
            days.push({ key: dayKey(d), date: d, total: 0, count: 0 });
        }
        const byKey = {};
        days.forEach(function (d) { byKey[d.key] = d; });
        paid.forEach(function (o) {
            const d = byKey[dayKey(at(o))];
            if (d) { d.total += Number(o.total); d.count++; }
        });
        const max = Math.max.apply(null, days.map(function (d) { return d.total; }).concat([1]));
        const total30 = days.reduce(function (s, d) { return s + d.total; }, 0);
        $("chartTotal").textContent = S.euro(total30) + " · " + days.reduce(function (s, d) { return s + d.count; }, 0) + " bestellingen";
        const W = 600, H = 160, bw = W / days.length;
        $("revenueChart").innerHTML = '<svg viewBox="0 0 ' + W + " " + (H + 22) + '" preserveAspectRatio="none" role="img" aria-label="Omzet per dag">' +
            [0.25, 0.5, 0.75].map(function (f) {
                return '<line x1="0" x2="' + W + '" y1="' + (H - H * f) + '" y2="' + (H - H * f) + '" class="grid-line"/>';
            }).join("") +
            days.map(function (d, i) {
                const h = d.total ? Math.max(3, d.total / max * (H - 8)) : 0;
                const weekend = d.date.getDay() === 0 || d.date.getDay() === 6;
                return '<g><rect x="' + (i * bw + 2) + '" y="' + (H - h) + '" width="' + (bw - 4) + '" height="' + h +
                    '" rx="3" class="cbar' + (i === days.length - 1 ? " today" : "") + '"><title>' +
                    esc(d.date.toLocaleDateString("nl-BE", { weekday: "short", day: "numeric", month: "short" }) + ": " + S.euro(d.total) +
                        " (" + d.count + ")") + "</title></rect>" +
                    (d.date.getDate() === 1 || i % 7 === 0
                        ? '<text x="' + (i * bw + bw / 2) + '" y="' + (H + 16) + '" class="axis' + (weekend ? " we" : "") + '">' +
                          d.date.getDate() + "/" + (d.date.getMonth() + 1) + "</text>"
                        : "") + "</g>";
            }).join("") + "</svg>" +
            (total30 ? "" : '<p class="muted chart-empty">Nog geen verkopen in de laatste 30 dagen.</p>');

        // Te doen
        const todos = [];
        const newOnes = orders.filter(function (o) { return o.payment_status === "paid" && o.order_status === "new"; });
        const prod = orders.filter(function (o) { return o.payment_status === "paid" && o.order_status === "in_production"; });
        const ready = orders.filter(function (o) { return o.payment_status === "paid" && o.order_status === "ready_for_pickup"; });
        const invErr = orders.filter(function (o) { return isPaidLike(o) && !invoicesByOrder[o.id]; });
        const stalePending = orders.filter(function (o) {
            return o.payment_status === "pending" && (now - new Date(o.created_at)) > 86400000;
        });
        const liveTest = products.filter(function (p) { return p.active && /^test-/.test(p.slug); });
        const noPhoto = products.filter(function (p) { return p.active && !p.image_path; });
        const waiting = waitlist.filter(function (w) { return !w.notified_at; });

        if (liveTest.length && settings && settings.shop_open) {
            todos.push(["danger", "🧪", liveTest.length + " testproduct(en) zichtbaar in de open webshop", "Echte klanten kunnen ze kopen.", "products:test"]);
        }
        const openWd = withdrawals.filter(function (w) { return w.status === "received"; });
        if (mailProvider === null) {
            todos.push(["danger", "✉️", "Er worden geen e-mails verstuurd", "Stel de mailinstellingen in voor je de shop opent (Instellingen → E-mails).", "settings"]);
        }
        openWd.forEach(function (w) {
            const wo = orders.find(function (x) { return x.id === w.order_id; });
            todos.unshift(["danger", "↩️", "Herroeping ontvangen voor " + (wo ? wo.order_number : "een bestelling"),
                "Neem contact op, en maak na terugontvangst een creditnota met terugbetaling.", wo ? "order:" + wo.order_number : ""]);
        });
        if (invErr.length) todos.push(["danger", "🧾", invErr.length + " betaalde bestelling(en) zonder factuur", "Open de bestelling en klik op 'Factuur aanmaken'.", "orders:paid"]);
        if (newOnes.length) todos.push(["warn", "🆕", newOnes.length + " nieuwe bestelling(en) om te starten", "Bekijk wat je moet maken in Productie.", "production"]);
        if (prod.length) todos.push(["info", "✂️", prod.length + " bestelling(en) in productie", "", "production"]);
        if (ready.length) todos.push(["info", "🏠", ready.length + " bestelling(en) wachten op afhaling", "", "orders:ready"]);
        const toDeliver = orders.filter(isToDeliver);
        if (toDeliver.length) {
            const onWay = toDeliver.filter(function (o) { return o.order_status === "out_for_delivery"; }).length;
            todos.push(["info", "🚗", toDeliver.length + " thuislevering(en) nog af te leveren",
                onWay ? onWay + " ervan onderweg" : "Plan je leverronde in Leveringen.", "deliveries"]);
        }
        if (stalePending.length) todos.push(["muted", "⏳", stalePending.length + " onbetaalde bestelling(en) ouder dan 1 dag", "Eventueel annuleren.", "orders:unpaid"]);
        if (noPhoto.length) todos.push(["muted", "📷", noPhoto.length + " zichtbaar product(en) zonder foto", "", "products:visible"]);
        if (waiting.length && settings && settings.shop_open) {
            todos.push(["warn", "💌", waiting.length + " persoon/personen wacht(en) op bericht dat de shop open is", "", "waitlist"]);
        }
        if (settings && !settings.shop_open) todos.push(["muted", "🔒", "De webshop is gesloten", "Klik bovenaan op 'Shop gesloten' om te openen.", ""]);

        $("todoList").innerHTML = todos.length ? todos.map(function (t) {
            return '<li class="todo ' + t[0] + '"' + (t[4] ? ' data-goto="' + t[4] + '" tabindex="0" role="button"' : "") + ">" +
                '<span class="ti">' + t[1] + "</span><div><strong>" + esc(t[2]) + "</strong>" +
                (t[3] ? '<br><span class="muted">' + esc(t[3]) + "</span>" : "") + "</div>" +
                (t[4] ? '<span class="chev">›</span>' : "") + "</li>";
        }).join("") : "<li>" + emptyState("🌈", "Niets te doen", "Alles is up-to-date. Tijd voor een koffie!") + "</li>";

        // Laatste bestellingen
        const recent = orders.slice(0, 6);
        $("recentOrders").innerHTML = recent.length ? '<ul class="mini-list">' + recent.map(function (o) {
            return '<li data-order="' + o.id + '" class="clickable"><div><strong>' + esc(o.order_number) + "</strong> · " + esc(o.customer_name) +
                '<br><span class="muted">' + esc(relTime(o.created_at)) + "</span></div><div class=\"right\">" + S.euro(o.total) +
                "<br>" + badge(isPaidLike(o) ? ORDER_LABEL : PAYMENT_LABEL, isPaidLike(o) ? o.order_status : o.payment_status) + "</div></li>";
        }).join("") + "</ul>" : emptyState("🛍️", "Nog geen bestellingen", "Zodra iemand bestelt, zie je het hier.");

        // Topproducten 30 dagen
        const since = new Date(now.getTime() - 30 * 86400000);
        const agg = {};
        paid.filter(function (o) { return at(o) >= since; }).forEach(function (o) {
            (o.shop_order_items || []).forEach(function (i) {
                agg[i.product_name] = agg[i.product_name] || { q: 0, t: 0 };
                agg[i.product_name].q += i.quantity;
                agg[i.product_name].t += Number(i.line_total);
            });
        });
        const top = Object.keys(agg).map(function (k) { return [k, agg[k]]; })
            .sort(function (a, b) { return b[1].q - a[1].q; }).slice(0, 5);
        const topMax = top.length ? top[0][1].q : 1;
        $("dashTop").innerHTML = top.length ? '<ul class="top-list">' + top.map(function (t, i) {
            return "<li><span class=\"rank\">" + (i + 1) + "</span><div><strong>" + esc(t[0]) + "</strong>" +
                '<div class="bar"><div class="bar-fill" style="width:' + (t[1].q / topMax * 100) + '%"></div></div></div>' +
                '<div class="right">' + t[1].q + " st.<br><span class=\"muted\">" + S.euro(t[1].t) + "</span></div></li>";
        }).join("") + "</ul>" : emptyState("📊", "Nog geen verkopen", "De bestsellers van de laatste 30 dagen verschijnen hier.");
    }

    function gotoTarget(target) {
        const parts = target.split(":");
        if (parts[0] === "order") {
            const nr = parts.slice(1).join(":");
            const o = orders.find(function (x) { return x.order_number === nr; });
            if (o) openOrder(o.id);
            return;
        }
        if (parts[0] === "orders") {
            orderFilter = parts[1] || "todo";
            showTab("orders");
            renderOrders();
        } else if (parts[0] === "products") {
            $("productFilterAdmin").value = parts[1] || "";
            showTab("products");
            renderProducts();
        } else {
            showTab(parts[0]);
        }
    }

    /* ======================== PRODUCTIE ======================== */

    function productionOrders() {
        return orders.filter(function (o) {
            return o.payment_status === "paid" && ["new", "in_production"].includes(o.order_status);
        }).sort(function (a, b) { return String(a.paid_at || a.created_at).localeCompare(String(b.paid_at || b.created_at)); });
    }

    function productionData() {
        const list = productionOrders();
        const agg = {};
        list.forEach(function (o) {
            (o.shop_order_items || []).forEach(function (i) {
                const key = i.product_id || i.product_name;
                if (!agg[key]) {
                    const p = products.find(function (x) { return x.id === i.product_id; });
                    agg[key] = { name: i.product_name, image: p ? p.image_path : null, weight: p ? p.weight_grams : null, qty: 0, orders: [] };
                }
                agg[key].qty += i.quantity;
                agg[key].orders.push({ o: o, qty: i.quantity });
            });
        });
        const rows = Object.keys(agg).map(function (k) { return agg[k]; })
            .sort(function (a, b) { return b.qty - a.qty || a.name.localeCompare(b.name, "nl"); });
        return { list: list, rows: rows };
    }

    function ageDays(o) {
        return Math.floor((Date.now() - new Date(o.paid_at || o.created_at)) / 86400000);
    }

    function renderProduction() {
        const d = productionData();
        const pieces = d.rows.reduce(function (s, r) { return s + r.qty; }, 0);
        const grams = d.rows.reduce(function (s, r) { return s + (r.weight ? r.weight * r.qty : 0); }, 0);
        const oldest = d.list.length ? ageDays(d.list[0]) : 0;
        $("prodCount").textContent = d.list.length ? String(pieces) : "";
        $("prodKpis").innerHTML =
            kpi("🧺", "Te maken stuks", String(pieces), d.rows.length + " verschillende producten") +
            kpi("📦", "Bestellingen", String(d.list.length),
                d.list.filter(function (o) { return o.order_status === "new"; }).length + " nog niet gestart") +
            kpi("⚖️", "Totaal gewicht", grams ? (grams / 1000).toFixed(1).replace(".", ",") + " kg" : "–", "op basis van productgewichten") +
            kpi("⏱️", "Oudste bestelling", d.list.length ? oldest + " dag" + (oldest === 1 ? "" : "en") : "–",
                d.list.length ? esc(d.list[0].order_number) : "", oldest >= 5 ? "attention" : "");

        if (!d.rows.length) {
            $("prodList").innerHTML = '<div class="card-plain">' + emptyState("🎨", "Niets te maken", "Er zijn geen betaalde bestellingen die nog gemaakt moeten worden.") + "</div>";
            return;
        }
        $("prodList").innerHTML = d.rows.map(function (r) {
            return '<div class="card-plain prod-card"><div class="prod-head">' +
                '<img src="' + S.imageUrl(r.image) + '" alt="">' +
                '<div><h3>' + esc(r.name) + "</h3>" +
                '<span class="muted">' + r.orders.length + " bestelling" + (r.orders.length === 1 ? "" : "en") +
                (r.weight ? " · ± " + (r.weight * r.qty >= 1000 ? (r.weight * r.qty / 1000).toFixed(1).replace(".", ",") + " kg" : r.weight * r.qty + " g") : "") +
                "</span></div>" +
                '<div class="prod-qty">' + r.qty + "<small>stuks</small></div></div>" +
                '<ul class="prod-orders">' + r.orders.map(function (x) {
                    const o = x.o, age = ageDays(o);
                    return '<li data-order="' + o.id + '" class="clickable">' +
                        '<span class="q">' + x.qty + "×</span>" +
                        "<span><strong>" + esc(o.order_number) + "</strong> · " + esc(o.customer_name) +
                        ' <span class="muted">· ' + (o.delivery_method === "pickup" ? "🏠" : "📮") + " · " + age + "d</span>" +
                        (o.customer_note ? '<br><span class="note">💬 ' + esc(o.customer_note) + "</span>" : "") +
                        (o.gift_wrap ? '<br><span class="note gift">🎁 Cadeauverpakking' + (o.gift_message ? ": “" + esc(o.gift_message) + "”" : "") + "</span>" : "") +
                        "</span>" + badge(ORDER_LABEL, o.order_status) + "</li>";
                }).join("") + "</ul></div>";
        }).join("");
    }

    function printProduction() {
        const d = productionData();
        if (!d.rows.length) { toast("Niets te maken.", true); return; }
        const html = '<div class="slip prod-print"><div class="slip-head"><div><div class="slip-brand">Productieplanning</div>' +
            '<div class="muted">' + new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" }) + "</div></div>" +
            '<div class="slip-title">' + d.rows.reduce(function (s, r) { return s + r.qty; }, 0) + "<br><span>stuks</span></div></div>" +
            '<table class="slip-table"><thead><tr><th>✓</th><th>Aantal</th><th>Product</th><th>Bestellingen &amp; opmerkingen</th></tr></thead><tbody>' +
            d.rows.map(function (r) {
                return '<tr><td class="box">☐</td><td><strong>' + r.qty + " ×</strong></td><td><strong>" + esc(r.name) + "</strong></td><td>" +
                    r.orders.map(function (x) {
                        return esc(x.o.order_number) + " (" + x.qty + "×, " + esc(x.o.customer_name) + ")" +
                            (x.o.customer_note ? " – <em>" + esc(x.o.customer_note) + "</em>" : "") +
                            (x.o.gift_wrap ? " – 🎁" : "");
                    }).join("<br>") + "</td></tr>";
            }).join("") + "</tbody></table></div>";
        doPrint("slips", html);
    }

    /* ======================== LEVERINGEN (eigen thuislevering) ======================== */

    function deliveryOrders() {
        return orders.filter(isToDeliver).sort(function (a, b) {
            return String(a.postal_code || "").localeCompare(String(b.postal_code || "")) ||
                String(a.city || "").localeCompare(String(b.city || "")) ||
                String(a.street || "").localeCompare(String(b.street || ""), "nl", { numeric: true });
        });
    }

    function addressLine(o) {
        return [o.street, (o.postal_code || "") + " " + (o.city || ""), o.country === "NL" ? "Nederland" : "België"].join(", ");
    }

    function renderDeliveries() {
        if (!$("deliveryList")) return;
        const list = deliveryOrders();
        const out = list.filter(function (o) { return o.order_status === "out_for_delivery"; }).length;
        $("deliverCount").textContent = list.length ? String(list.length) : "";
        $("routeDeliveries").disabled = !list.length;
        $("deliverAllOut").disabled = !list.some(function (o) { return o.order_status !== "out_for_delivery"; });
        if (!list.length) {
            $("deliveryList").innerHTML = '<div class="card-plain">' + emptyState("🚗", "Niets te leveren", "Alle thuisleveringen zijn afgeleverd.") + "</div>";
            return;
        }
        $("deliveryList").innerHTML =
            '<p class="muted" style="margin-bottom:10px">' + list.length + " adres" + (list.length === 1 ? "" : "sen") +
            " · " + out + " onderweg</p>" +
            list.map(function (o, idx) {
                const items = (o.shop_order_items || []).map(function (i) { return i.quantity + "× " + esc(i.product_name); }).join(", ");
                const maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addressLine(o));
                const ready = o.order_status !== "new";
                return '<div class="card-plain delivery-card st-' + esc(o.order_status) + '">' +
                    '<div class="dc-head"><span class="dc-nr">' + (idx + 1) + "</span>" +
                    "<div><strong>" + esc(o.customer_name) + "</strong> · " + esc(o.order_number) + "<br>" +
                    '<a href="' + maps + '" target="_blank" rel="noopener">📍 ' + esc(o.street) + ", " + esc(o.postal_code) + " " + esc(o.city) + "</a>" +
                    (o.phone ? '<br><a href="tel:' + esc(String(o.phone).replace(/\s+/g, "")) + '">📞 ' + esc(o.phone) + "</a>" : "") +
                    "</div>" + badge(ORDER_LABEL, o.order_status) + "</div>" +
                    '<p class="dc-items">' + items + "</p>" +
                    (o.delivery_slot ? '<p class="dc-slot">🕒 ' + esc(o.delivery_slot) + "</p>" : "") +
                    (o.customer_note ? '<p class="note">💬 ' + esc(o.customer_note) + "</p>" : "") +
                    (o.gift_wrap ? '<p class="note gift">🎁 Cadeau' + (o.gift_message ? ": “" + esc(o.gift_message) + "”" : "") + "</p>" : "") +
                    (!ready ? '<p class="muted small">⚠️ Nog niet in productie gezet.</p>' : "") +
                    '<div class="actions">' +
                    (o.order_status !== "out_for_delivery"
                        ? '<button class="btn small secondary" type="button" data-deliver-order="' + o.id + '" data-deliver-status="out_for_delivery">🚗 Onderweg</button>'
                        : "") +
                    '<button class="btn small big-tap" type="button" data-deliver-order="' + o.id + '" data-deliver-status="delivered">✓ Afgeleverd</button>' +
                    '<button class="link-btn" type="button" data-goto="order:' + esc(o.order_number) + '">Details</button>' +
                    "</div></div>";
            }).join("");
    }

    async function deliveryAction(orderId, status, btn) {
        const o = orderById(orderId);
        if (!o) return;
        if (status === "delivered" && !confirm("Bestelling " + o.order_number + " (" + o.customer_name + ") markeren als afgeleverd?")) return;
        const notify = $("deliverNotify") ? $("deliverNotify").checked : false;
        if (btn) btn.disabled = true;
        try {
            await callAdmin({ action: "set_status", order_id: o.id, status: status, notify: notify, tracking_code: "" });
            toast((status === "delivered" ? "Afgeleverd" : "Onderweg") + ": " + o.order_number + (notify ? " (klant verwittigd)" : ""));
            await loadOrders();
        } catch (e) {
            toast(e.message || "Mislukt.", true);
            if (btn) btn.disabled = false;
        }
    }

    async function markAllOut() {
        const list = deliveryOrders().filter(function (o) { return o.order_status !== "out_for_delivery"; });
        if (!list.length) return;
        const notify = $("deliverNotify").checked;
        if (!confirm(list.length + " bestelling(en) op \"Onderweg\" zetten" + (notify ? " en de klanten mailen" : "") + "?")) return;
        let ok = 0;
        for (const o of list) {
            try {
                await callAdmin({ action: "set_status", order_id: o.id, status: "out_for_delivery", notify: notify, tracking_code: "" });
                ok++;
            } catch (e) {
                toast(o.order_number + ": " + e.message, true);
            }
        }
        toast(ok + " bestelling(en) onderweg.");
        await loadOrders();
    }

    function openRoute() {
        const list = deliveryOrders();
        if (!list.length) return;
        const origin = settings && settings.business_address ? String(settings.business_address).replace(/\n/g, ", ") : "";
        // Google Maps laat tot 9 tussenstops toe in een link; rest volgt in een tweede route.
        const stops = list.map(addressLine);
        const chunk = stops.slice(0, 10);
        const dest = chunk[chunk.length - 1];
        const way = chunk.slice(0, -1);
        const url = "https://www.google.com/maps/dir/?api=1" +
            (origin ? "&origin=" + encodeURIComponent(origin) : "") +
            "&destination=" + encodeURIComponent(dest) +
            (way.length ? "&waypoints=" + encodeURIComponent(way.join("|")) : "") +
            "&travelmode=driving";
        window.open(url, "_blank", "noopener");
        if (stops.length > 10) toast("Google Maps toont max. 10 adressen; de eerste 10 (per postcode) zijn geopend.", true);
    }

    function printDeliveryList() {
        const list = deliveryOrders();
        if (!list.length) { toast("Niets te leveren.", true); return; }
        const html = '<div class="slip"><div class="slip-head"><div><div class="slip-brand">Leverlijst</div>' +
            '<div class="muted">' + new Date().toLocaleDateString("nl-BE", { weekday: "long", day: "numeric", month: "long" }) + "</div></div>" +
            '<div class="slip-title">' + list.length + "<br><span>adressen</span></div></div>" +
            '<table class="slip-table"><thead><tr><th>✓</th><th>#</th><th>Klant &amp; adres</th><th>Producten</th></tr></thead><tbody>' +
            list.map(function (o, i) {
                return '<tr><td class="box">☐</td><td>' + (i + 1) + "</td><td><strong>" + esc(o.customer_name) + "</strong> (" + esc(o.order_number) + ")<br>" +
                    esc(o.street) + "<br>" + esc(o.postal_code) + " " + esc(o.city) +
                    (o.phone ? "<br>☎ " + esc(o.phone) : "") +
                    (o.delivery_slot ? "<br>🕒 " + esc(o.delivery_slot) : "") + "</td><td>" +
                    (o.shop_order_items || []).map(function (it) { return it.quantity + "× " + esc(it.product_name); }).join("<br>") +
                    (o.gift_wrap ? "<br>🎁 cadeau" : "") +
                    (o.customer_note ? "<br><em>" + esc(o.customer_note) + "</em>" : "") + "</td></tr>";
            }).join("") + "</tbody></table></div>";
        doPrint("slips", html);
    }

    /* ======================== BESTELLINGEN ======================== */

    async function loadOrders() {
        const [o, inv, wd] = await Promise.all([
            sb.from("shop_orders").select("*, shop_order_items(*)").order("created_at", { ascending: false }).limit(1000),
            sb.from("shop_invoices").select("id, invoice_number, order_id, pdf_path, status, total, invoice_date"),
            sb.from("shop_withdrawals").select("*").order("created_at", { ascending: false })
        ]);
        if (o.error) { toast("Bestellingen laden mislukt.", true); return; }
        orders = o.data || [];
        withdrawals = wd.error ? [] : (wd.data || []);
        invoicesByOrder = {};
        (inv.data || []).forEach(function (i) { invoicesByOrder[i.order_id] = i; });
        renderOrders();
        renderProduction();
        renderDeliveries();
        if (products.length) renderProducts();
        if (!$("tab-dashboard").classList.contains("hidden")) renderDashboard();
    }

    function isTodo(o) {
        return o.payment_status === "paid" && !DONE_STATUSES.includes(o.order_status);
    }

    // Thuislevering die nog niet afgeleverd is
    function isToDeliver(o) {
        return o.payment_status === "paid" && o.delivery_method === "shipping" &&
            !DONE_STATUSES.includes(o.order_status) && o.order_status !== "shipped";
    }

    const ORDER_FILTERS = [
        ["todo", "Te behandelen", isTodo],
        ["new", "Nieuw", function (o) { return o.payment_status === "paid" && o.order_status === "new"; }],
        ["in_production", "In productie", function (o) { return o.payment_status === "paid" && o.order_status === "in_production"; }],
        ["deliver", "Te leveren", isToDeliver],
        ["ready", "Klaar / onderweg", function (o) { return o.payment_status === "paid" && ["ready_for_pickup", "shipped", "out_for_delivery"].includes(o.order_status); }],
        ["done", "Afgeleverd / afgehaald", function (o) { return o.payment_status === "paid" && ["delivered", "completed"].includes(o.order_status); }],
        ["paid", "Alle betaalde", isPaidLike],
        ["unpaid", "Niet betaald", function (o) { return !isPaidLike(o); }],
        ["all", "Alle", function () { return true; }]
    ];
    let orderFilter = "todo";

    function renderOrders() {
        const q = $("orderSearch").value.trim().toLowerCase();
        $("openCount").textContent = String(orders.filter(isTodo).length || "");

        $("orderChips").innerHTML = ORDER_FILTERS.map(function (f) {
            const n = orders.filter(f[2]).length;
            return '<button type="button" class="status-chip' + (f[0] === orderFilter ? " active" : "") +
                '" data-order-filter="' + f[0] + '">' + esc(f[1]) + ' <span class="n">' + n + "</span></button>";
        }).join("");

        const test = ORDER_FILTERS.find(function (f) { return f[0] === orderFilter; })[2];
        const list = orders.filter(function (o) {
            if (!test(o)) return false;
            if (q && !(String(o.order_number) + " " + o.customer_name + " " + o.email).toLowerCase().includes(q)) return false;
            return true;
        });

        $("orderRows").innerHTML = list.length ? list.map(function (o) {
            const inv = invoicesByOrder[o.id];
            const items = (o.shop_order_items || []).reduce(function (s, i) { return s + i.quantity; }, 0);
            return '<tr class="clickable st-' + esc(o.order_status) + (isPaidLike(o) ? "" : " unpaid") +
                (selectedOrders.has(o.id) ? " selected" : "") + '" data-order="' + o.id + '">' +
                '<td class="sel"><input type="checkbox" data-select="' + o.id + '"' + (selectedOrders.has(o.id) ? " checked" : "") +
                ' aria-label="Selecteer ' + esc(o.order_number) + '"></td>' +
                '<td data-label="Nr."><strong>' + esc(o.order_number) + "</strong></td>" +
                '<td data-label="Datum" title="' + esc(new Date(o.created_at).toLocaleString("nl-BE")) + '">' + esc(relTime(o.created_at)) + "</td>" +
                '<td data-label="Klant">' + esc(o.customer_name) + '<br><span class="muted">' + esc(o.email) + "</span></td>" +
                '<td data-label="Levering">' + (o.delivery_method === "pickup" ? "🏠 Afhalen" : "🚗 Levering") +
                '<br><span class="muted">' + items + " stuk" + (items === 1 ? "" : "s") + (o.gift_wrap ? " · 🎁" : "") + "</span></td>" +
                '<td data-label="Totaal" class="num"><strong>' + S.euro(o.total) + "</strong>" +
                (Number(o.discount_amount) > 0 ? '<br><span class="muted">🏷️ ' + esc(o.discount_code || "korting") + "</span>" : "") + "</td>" +
                '<td data-label="Betaling">' + badge(PAYMENT_LABEL, o.payment_status) + "</td>" +
                '<td data-label="Status">' + badge(ORDER_LABEL, o.order_status) + "</td>" +
                '<td data-label="Factuur">' + (inv ? esc(inv.invoice_number)
                    : (o.invoice_error ? '<span class="badge b-red">Factuur ontbreekt</span>' : '<span class="muted">–</span>')) + "</td></tr>";
        }).join("") : '<tr><td colspan="9">' + emptyState("📭", orderFilter === "todo" ? "Alles is afgehandeld!" : "Geen bestellingen",
            orderFilter === "todo" ? "Er wachten geen betaalde bestellingen op jou. 🎉" : "Pas de filter of zoekterm aan.") + "</td></tr>";
        visibleOrderIds = list.map(function (o) { return o.id; });
        renderBulkBar();
    }

    /* ---------- selectie (labels / pakbonnen) ---------- */

    const selectedOrders = new Set();
    let visibleOrderIds = [];

    function renderBulkBar() {
        const n = selectedOrders.size;
        $("bulkBar").classList.toggle("hidden", n === 0);
        $("bulkCount").textContent = n + " geselecteerd";
        const all = $("selectAllOrders");
        const vis = visibleOrderIds.filter(function (id) { return selectedOrders.has(id); }).length;
        all.checked = vis > 0 && vis === visibleOrderIds.length;
        all.indeterminate = vis > 0 && vis < visibleOrderIds.length;
    }

    function isToShip(o) { return isToDeliver(o); }

    function emptyState(icon, title, text) {
        return '<div class="empty-state"><div class="es-icon">' + icon + "</div><strong>" + esc(title) + "</strong>" +
            (text ? '<p class="muted">' + esc(text) + "</p>" : "") + "</div>";
    }

    function orderDetailHtml(o) {
        const inv = invoicesByOrder[o.id];
        const items = (o.shop_order_items || []).map(function (i) {
            return "<tr><td>" + i.quantity + " ×</td><td>" + esc(i.product_name) + '</td><td class="num">' + S.euro(i.line_total) + "</td></tr>";
        }).join("");
        const paid = o.payment_status === "paid";
        const pickup = o.delivery_method === "pickup";

        let statusButtons = "";
        if (paid) {
            const steps = pickup
                ? [["in_production", "✂️ In productie"], ["ready_for_pickup", "🏠 Klaar voor afhaling"], ["completed", "✓ Afgehaald"]]
                : [["in_production", "✂️ In productie"], ["out_for_delivery", "🚗 Onderweg"], ["delivered", "✓ Afgeleverd"]];
            statusButtons = steps.map(function (s) {
                return '<button class="btn small' + (o.order_status === s[0] ? " secondary" : "") + '" type="button" data-set-status="' + s[0] + '">' +
                    esc(s[1]) + "</button>";
            }).join("");
        }

        const flow = pickup
            ? ["new", "in_production", "ready_for_pickup", "completed"]
            : ["new", "in_production", "out_for_delivery", "delivered"];
        let at = flow.indexOf(o.order_status);
        if (!pickup && o.order_status === "shipped") at = 2;
        if (!pickup && o.order_status === "completed") at = 3;
        const stepLabel = function (s) { return s === "completed" && pickup ? "Afgehaald" : ORDER_LABEL[s][0]; };
        const stepper = (paid || o.order_status !== "new") && o.order_status !== "cancelled"
            ? '<ol class="stepper-line">' + flow.map(function (s, i) {
                return '<li class="' + (i <= at ? "done" : "") + (i === at ? " current" : "") + '"><span>' + (i <= at ? "✓" : i + 1) +
                    "</span>" + esc(stepLabel(s)) + "</li>";
            }).join("") + "</ol>"
            : "";
        const wd = withdrawals.filter(function (w) { return w.order_id === o.id; });
        const mapsUrl = "https://www.google.com/maps/search/?api=1&query=" +
            encodeURIComponent([o.street, o.postal_code, o.city, o.country === "NL" ? "Nederland" : "België"].join(" "));

        return '<div class="detail-head"><div><h2>Bestelling ' + esc(o.order_number) + "</h2>" +
            '<p class="muted">' + new Date(o.created_at).toLocaleString("nl-BE") + " · " +
            badge(PAYMENT_LABEL, o.payment_status) + " " + badge(ORDER_LABEL, o.order_status) + "</p></div>" +
            '<div class="detail-total">' + S.euro(o.total) + "</div></div>" +
            stepper +
            wd.map(function (w) {
                return '<div class="withdraw-note"><strong>↩️ Herroeping ontvangen</strong> op ' +
                    esc(new Date(w.created_at).toLocaleString("nl-BE")) + " · " +
                    (w.status === "processed" ? '<span class="badge b-green">Verwerkt</span>' : '<span class="badge b-red">Te verwerken</span>') +
                    "<br><strong>Producten:</strong> " + esc(w.items) +
                    (w.reason ? "<br><strong>Reden:</strong> " + esc(w.reason) : "") +
                    (w.status !== "processed"
                        ? '<div class="actions"><button class="btn small" type="button" data-withdraw-done="' + w.id + '">✓ Markeer als verwerkt</button>' +
                          (inv && inv.status !== "credited" ? '<button class="btn small warn" type="button" data-credit="' + inv.id + '">Creditnota / terugbetaling</button>' : "") +
                          "</div>"
                        : "") + "</div>";
            }).join("") +
            '<div class="detail-grid"><div>' +
            "<h3>Klant</h3><p>" + esc(o.customer_name) + "<br>" +
            '<a href="mailto:' + esc(o.email) + "?subject=" + encodeURIComponent("Je bestelling " + o.order_number) + '">✉️ ' + esc(o.email) + "</a>" +
            (o.phone ? '<br><a href="tel:' + esc(String(o.phone).replace(/\s+/g, "")) + '">📞 ' + esc(o.phone) + "</a>" : "") +
            (o.company_name ? "<br>🏢 " + esc(o.company_name) + (o.company_vat ? " – " + esc(o.company_vat) : "") : "") + "</p>" +
            (function () {
                const prev = orders.filter(function (x) { return x.id !== o.id && x.email === o.email && isPaidLike(x); });
                if (!prev.length) return '<p class="muted">🌱 Eerste bestelling van deze klant</p>';
                const sum = prev.reduce(function (s, x) { return s + Number(x.total); }, 0);
                return '<p class="muted">⭐ Terugkerende klant: ' + prev.length + " eerdere bestelling" +
                    (prev.length === 1 ? "" : "en") + " (" + S.euro(sum) + ")</p>";
            })() +
            "<h3>Levering</h3><p>" + (pickup ? "🏠 Afhalen" :
                "🚗 Levering aan huis<br>" + esc(o.street) + "<br>" + esc(o.postal_code) + " " + esc(o.city) + " (" + esc(o.country) + ")" +
                '<br><a href="' + mapsUrl + '" target="_blank" rel="noopener">🗺️ Open in Google Maps</a>') +
            (o.delivery_slot ? "<br>🕒 Bezorgmoment: <strong>" + esc(o.delivery_slot) + "</strong>" : "") +
            (o.delivered_at ? "<br>✓ " + (pickup ? "Afgehaald" : "Afgeleverd") + " op " + esc(new Date(o.delivered_at).toLocaleString("nl-BE")) : "") +
            (o.tracking_code ? "<br>Track &amp; trace: " + esc(o.tracking_code) : "") + "</p>" +
            (o.customer_note ? "<h3>Opmerking klant</h3><p>" + esc(o.customer_note) + "</p>" : "") +
            (o.gift_wrap ? '<div class="gift-note"><strong>🎁 Inpakken als cadeau</strong>' +
                (o.gift_message ? "<br>Kaartje: <em>“" + esc(o.gift_message) + "”</em>" : "<br><span class=\"muted\">Geen boodschap</span>") + "</div>" : "") +
            "<h3>Interne notitie</h3>" +
            '<textarea id="adminNote" rows="2" maxlength="2000">' + esc(o.admin_note || "") + "</textarea>" +
            '<div class="actions"><button class="btn small secondary" type="button" data-save-note>Notitie opslaan</button></div>' +
            "</div><div>" +
            '<h3>Producten</h3><table class="data">' + items +
            (Number(o.discount_amount) > 0
                ? '<tr><td></td><td>Korting' + (o.discount_code ? " (" + esc(o.discount_code) + ")" : "") +
                  '</td><td class="num">− ' + S.euro(o.discount_amount) + "</td></tr>"
                : "") +
            '<tr><td></td><td>' + (pickup ? "Verzending" : "Levering") + '</td><td class="num">' + S.euro(o.shipping_cost) + "</td></tr>" +
            (o.gift_wrap ? '<tr><td></td><td>🎁 Cadeauverpakking</td><td class="num">' + S.euro(o.gift_wrap_cost || 0) + "</td></tr>" : "") +
            '<tr><td></td><td><strong>Totaal</strong></td><td class="num"><strong>' + S.euro(o.total) + "</strong></td></tr></table>" +

            (paid ? "<h3>Status aanpassen</h3>" +
                (!pickup
                    ? '<label>Bezorgmoment (optioneel, komt in de mail)<input id="deliverySlot" maxlength="150" placeholder="bv. dinsdag 18/11 tussen 17 en 19 uur" value="' + esc(o.delivery_slot || "") + '"></label>'
                    : "") +
                '<label class="check"><input type="checkbox" id="notifyCustomer" checked> Klant verwittigen per mail</label>' +
                '<div class="actions">' + statusButtons + "</div>" +
                (!pickup
                    ? '<details class="post-ship"><summary>Toch per post verzonden?</summary>' +
                      '<label>Track &amp; trace<input id="trackingCode" maxlength="100" value="' + esc(o.tracking_code || "") + '"></label>' +
                      '<div class="actions"><button class="btn small secondary" type="button" data-set-status="shipped">📮 Markeer als verzonden (post)</button></div></details>'
                    : "") : "") +

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
            (o.delivery_method === "shipping"
                ? '<button class="btn small secondary" type="button" data-label-order="' + o.id + '">🏷️ Adreslabel</button>' : "") +
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

    /* ======================== AFDRUKKEN: LABELS & PAKBONNEN ======================== */

    const LABEL_FORMATS = {
        "4": { perPage: 4, name: "4 per A4 (105 × 148 mm)" },
        "8": { perPage: 8, name: "8 per A4 (105 × 74 mm)" }
    };

    function orderById(id) { return orders.find(function (o) { return o.id === id; }); }

    function countryName(c) { return c === "NL" ? "NEDERLAND" : "BELGIË"; }

    function orderWeightGrams(o) {
        let total = 0, known = false;
        (o.shop_order_items || []).forEach(function (i) {
            const p = products.find(function (x) { return x.id === i.product_id; });
            if (p && p.weight_grams) { total += p.weight_grams * i.quantity; known = true; }
        });
        return known ? total : null;
    }

    function orderLink(o) {
        return location.origin + location.pathname + "#order=" + encodeURIComponent(o.order_number);
    }

    function qrSvg(text) {
        if (typeof window.qrcode !== "function") return "";
        const qr = window.qrcode(0, "M");
        qr.addData(text);
        qr.make();
        return qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
    }

    function senderLine() {
        const s = settings || {};
        return [s.business_name, String(s.business_address || "").replace(/\s*\n\s*/g, " · ")].filter(Boolean).join(" · ");
    }

    function labelHtml(o) {
        const items = (o.shop_order_items || []).reduce(function (s, i) { return s + i.quantity; }, 0);
        const w = orderWeightGrams(o);
        return '<div class="slabel">' +
            '<div class="lb-from">Afz.: ' + esc(senderLine()) + "</div>" +
            '<div class="lb-main"><div class="lb-to">' +
            '<div class="lb-name">' + esc(o.customer_name) + "</div>" +
            (o.company_name ? "<div>" + esc(o.company_name) + "</div>" : "") +
            "<div>" + esc(o.street) + "</div>" +
            '<div class="lb-city">' + esc(o.postal_code) + " " + esc(String(o.city || "").toUpperCase()) + "</div>" +
            '<div class="lb-country">' + countryName(o.country) + "</div>" +
            '</div><div class="lb-qr">' + qrSvg(orderLink(o)) + "</div></div>" +
            '<div class="lb-foot"><strong>' + esc(o.order_number) + "</strong> · " + items + " art." +
            (w ? " · ± " + (w >= 1000 ? (w / 1000).toFixed(1).replace(".", ",") + " kg" : w + " g") : "") +
            (o.phone ? " · ☎ " + esc(o.phone) : "") + "</div></div>";
    }

    function labelSheetsHtml(list, format, start) {
        const per = LABEL_FORMATS[format].perPage;
        const cells = [];
        for (let i = 1; i < start; i++) cells.push('<div class="slabel empty"></div>');
        list.forEach(function (o) { cells.push(labelHtml(o)); });
        let html = "";
        for (let i = 0; i < cells.length; i += per) {
            const page = cells.slice(i, i + per);
            while (page.length < per) page.push('<div class="slabel empty"></div>');
            html += '<div class="sheet sheet-' + format + '">' + page.join("") + "</div>";
        }
        return html;
    }

    function packingSlipHtml(o) {
        const s = settings || {};
        return '<div class="slip">' +
            '<div class="slip-head"><div><div class="slip-brand">' + esc(s.business_name || "") + "</div>" +
            '<div class="muted">' + esc(String(s.business_address || "").replace(/\n/g, " · ")) + "</div></div>" +
            '<div class="slip-title">PAKBON<br><span>' + esc(o.order_number) + "</span></div></div>" +
            '<div class="slip-meta"><div><strong>' + (o.delivery_method === "shipping" ? "Leveradres" : "Afhalen") + "</strong><br>" +
            esc(o.customer_name) + (o.company_name ? "<br>" + esc(o.company_name) : "") +
            (o.delivery_method === "shipping"
                ? "<br>" + esc(o.street) + "<br>" + esc(o.postal_code) + " " + esc(o.city) + "<br>" + (o.country === "NL" ? "Nederland" : "België")
                : "") +
            (o.phone ? "<br>☎ " + esc(o.phone) : "") + "</div>" +
            "<div><strong>Besteld op</strong><br>" + new Date(o.created_at).toLocaleDateString("nl-BE") + "</div>" +
            '<div class="lb-qr">' + qrSvg(orderLink(o)) + "</div></div>" +
            '<table class="slip-table"><thead><tr><th>✓</th><th>Aantal</th><th>Product</th></tr></thead><tbody>' +
            (o.shop_order_items || []).map(function (i) {
                return '<tr><td class="box">☐</td><td>' + i.quantity + " ×</td><td>" + esc(i.product_name) + "</td></tr>";
            }).join("") + "</tbody></table>" +
            (o.customer_note ? '<div class="slip-note"><strong>Opmerking klant:</strong> ' + esc(o.customer_note) + "</div>" : "") +
            (o.gift_wrap ? '<div class="slip-note slip-gift"><strong>🎁 Inpakken als cadeau</strong>' +
                (o.gift_message ? '<div class="gift-card-text">“' + esc(o.gift_message) + "”</div>" : " – zonder boodschap") + "</div>" : "") +
            '<p class="slip-thanks">Bedankt voor je bestelling en veel speelplezier! 🌈</p></div>';
    }

    function doPrint(mode, html) {
        const area = $("printArea");
        area.className = "print-" + mode;
        area.innerHTML = html;
        document.body.classList.add("printing-" + mode);
        const done = function () {
            document.body.classList.remove("printing-" + mode);
            window.removeEventListener("afterprint", done);
        };
        window.addEventListener("afterprint", done);
        setTimeout(function () { window.print(); }, 50);
    }

    function printPackingSlips(ids) {
        const list = ids.map(orderById).filter(Boolean);
        if (!list.length) { toast("Geen bestellingen geselecteerd.", true); return; }
        doPrint("slips", list.map(packingSlipHtml).join(""));
    }

    function printPackingSlip(o) { printPackingSlips([o.id]); }

    function openLabelDialog(ids) {
        const all = ids.map(orderById).filter(Boolean);
        const list = all.filter(function (o) { return o.delivery_method === "shipping"; });
        const skipped = all.length - list.length;
        if (!list.length) {
            toast("Geen thuisleveringen geselecteerd (afhaalbestellingen krijgen geen label).", true);
            return;
        }
        const pref = JSON.parse(localStorage.getItem("kww_label_pref") || '{"format":"4"}');
        const format = LABEL_FORMATS[pref.format] ? pref.format : "4";

        openDialog("<h2>🏷️ Adreslabels afdrukken</h2>" +
            '<p class="muted">' + list.length + " label" + (list.length === 1 ? "" : "s") +
            (skipped ? " · " + skipped + " afhaalbestelling" + (skipped === 1 ? "" : "en") + " overgeslagen" : "") + "</p>" +
            '<form id="labelForm" class="label-form">' +
            '<div class="form-grid">' +
            '<div class="choice-row">' + Object.keys(LABEL_FORMATS).map(function (k) {
                return '<label class="fmt"><input type="radio" name="format" value="' + k + '"' + (k === format ? " checked" : "") + ">" +
                    '<span class="fmt-icon fmt-' + k + '">' + new Array(LABEL_FORMATS[k].perPage + 1).join("<i></i>") + "</span>" +
                    "<span>" + esc(LABEL_FORMATS[k].name) + "</span></label>";
            }).join("") + "</div>" +
            '<label>Begin op label nr. <select name="start" id="labelStart"></select></label>' +
            '<p class="muted small">Tip: kies in het afdrukvenster <strong>Marges: geen</strong> en <strong>Schaal: 100 %</strong>. ' +
            "Druk eerst eens af op gewoon papier en leg het tegen je etiketvel om te controleren.</p>" +
            '<div class="actions"><button class="btn" type="submit">🖨 Afdrukken</button>' +
            '<button class="btn secondary" type="button" data-close>Annuleren</button></div>' +
            "</div>" +
            '<div class="label-preview" id="labelPreview" aria-label="Voorbeeld"></div>' +
            "</form>");
        $("labelForm").dataset.ids = list.map(function (o) { return o.id; }).join(",");
        renderLabelPreview();
    }

    function labelFormState() {
        const form = $("labelForm");
        const format = form.elements.format.value;
        const per = LABEL_FORMATS[format].perPage;
        const sel = $("labelStart");
        const prev = parseInt(sel.value, 10) || 1;
        if (sel.options.length !== per) {
            sel.innerHTML = Array.from({ length: per }, function (_, i) { return '<option value="' + (i + 1) + '">' + (i + 1) + "</option>"; }).join("");
            sel.value = String(Math.min(prev, per));
        }
        const ids = form.dataset.ids.split(",");
        return { format: format, start: parseInt(sel.value, 10) || 1, list: ids.map(orderById).filter(Boolean) };
    }

    function renderLabelPreview() {
        const st = labelFormState();
        $("labelPreview").innerHTML = '<div class="preview-scale">' + labelSheetsHtml(st.list, st.format, st.start) + "</div>";
    }

    function submitLabels() {
        const st = labelFormState();
        localStorage.setItem("kww_label_pref", JSON.stringify({ format: st.format }));
        closeDialog(true);
        doPrint("labels", labelSheetsHtml(st.list, st.format, st.start));
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
            lines.push({ description: "Levering", quantity: 1, unit_price: Number(inv.shipping_cost) });
        }
        if (Number(inv.gift_wrap_cost || 0) > 0) {
            lines.push({ description: "Cadeauverpakking", quantity: 1, unit_price: Number(inv.gift_wrap_cost) });
        }

        openDialog("<h2>Creditnota voor " + esc(inv.invoice_number) + "</h2>" +
            '<p class="muted">Nog te crediteren: <strong>' + S.euro(remaining) + "</strong>. " +
            "Pas de lijnen aan of verwijder wat je niet wil crediteren.</p>" +
            (Number(inv.discount_amount) > 0
                ? '<p class="error">Let op: op deze factuur werd ' + S.euro(inv.discount_amount) + " korting gegeven" +
                  (inv.discount_code ? " (" + esc(inv.discount_code) + ")" : "") +
                  ". De lijnen hieronder zijn de prijzen zónder korting – verlaag ze zodat je niet meer crediteert dan de klant betaalde.</p>"
                : "") +
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
        renderProducts();
    }

    function soldCounts() {
        const sold = {};
        orders.filter(isPaidLike).forEach(function (o) {
            (o.shop_order_items || []).forEach(function (i) {
                if (i.product_id) sold[i.product_id] = (sold[i.product_id] || 0) + i.quantity;
            });
        });
        return sold;
    }

    function renderProducts() {
        const q = ($("productSearchAdmin").value || "").trim().toLowerCase();
        const f = $("productFilterAdmin").value;
        const sold = soldCounts();
        const list = products.filter(function (p) {
            if (f === "visible" && !p.active) return false;
            if (f === "hidden" && p.active) return false;
            if (f === "featured" && !p.featured) return false;
            if (f === "sale" && !(p.compare_at_price != null && Number(p.compare_at_price) > Number(p.price))) return false;
            if (f === "test" && !/^test-/.test(p.slug)) return false;
            if (q && !(p.name + " " + p.slug + " " + (p.short_text || "")).toLowerCase().includes(q)) return false;
            return true;
        });
        $("productRows").innerHTML = list.length ? list.map(function (p) {
            const cat = categories.find(function (c) { return c.id === p.category_id; });
            const sale = p.compare_at_price != null && Number(p.compare_at_price) > Number(p.price);
            return '<tr class="clickable' + (p.active ? "" : " row-muted") + '" data-product="' + p.id + '">' +
                '<td data-label=""><img src="' + S.imageUrl(p.image_path) + '" alt="">' + (p.image_path ? "" : '<span class="no-photo" title="Geen foto">📷</span>') + "</td>" +
                '<td data-label="Naam"><strong>' + esc(p.name) + "</strong>" +
                (p.badge ? ' <span class="badge b-pink">' + esc(p.badge) + "</span>" : "") +
                (/^test-/.test(p.slug) ? ' <span class="badge b-orange">test</span>' : "") +
                '<br><span class="muted">' + esc(p.short_text || "") + "</span></td>" +
                '<td data-label="Categorie">' + (cat ? esc((cat.icon ? cat.icon + " " : "") + cat.name) : '<span class="muted">–</span>') + "</td>" +
                '<td data-label="Prijs" class="num"><strong>' + S.euro(p.price) + "</strong>" +
                (sale ? '<br><s class="muted">' + S.euro(p.compare_at_price) + "</s>" : "") + "</td>" +
                '<td data-label="Verkocht">' + (sold[p.id] || 0) + "</td>" +
                '<td data-label="Volgorde">' + p.sort_order + "</td>" +
                '<td data-label="Uitgelicht"><label class="toggle" title="Uitgelicht"><input type="checkbox" data-toggle="featured" data-id="' + p.id + '"' +
                (p.featured ? " checked" : "") + '><span></span></label></td>' +
                '<td data-label="Zichtbaar"><label class="toggle" title="Zichtbaar in de webshop"><input type="checkbox" data-toggle="active" data-id="' + p.id + '"' +
                (p.active ? " checked" : "") + '><span></span></label></td>' +
                '<td><button class="btn small secondary" type="button" data-product="' + p.id + '">Bewerken</button></td></tr>';
        }).join("") : '<tr><td colspan="9">' + (products.length
            ? emptyState("🔍", "Geen producten gevonden", "Pas de filter of zoekterm aan.")
            : emptyState("🧺", "Nog geen producten", "Klik op '+ Nieuw product' om te beginnen.")) + "</td></tr>";
    }

    async function toggleProductField(input) {
        const field = input.dataset.toggle;
        const id = input.dataset.id;
        const val = input.checked;
        const p = products.find(function (x) { return x.id === id; });
        if (field === "active" && val && /^test-/.test(p.slug) && settings && settings.shop_open &&
            !confirm("Dit is een testproduct en de webshop is open. Echt zichtbaar maken voor klanten?")) {
            input.checked = false;
            return;
        }
        input.disabled = true;
        const row = {};
        row[field] = val;
        const { error } = await sb.from("shop_products").update(row).eq("id", id);
        input.disabled = false;
        if (error) {
            input.checked = !val;
            toast("Opslaan mislukt: " + error.message, true);
            return;
        }
        p[field] = val;
        toast(field === "active" ? (val ? "Product is zichtbaar." : "Product is verborgen.") : (val ? "Product uitgelicht." : "Niet meer uitgelicht."));
        renderProducts();
    }

    /* ---------- categorieën ---------- */

    async function loadCategories() {
        const { data, error } = await sb.from("shop_categories").select("*").order("sort_order").order("name");
        if (error) { categories = []; return; }
        categories = data || [];
    }

    function openCategories() {
        const rows = categories.map(function (c) {
            const count = products.filter(function (p) { return p.category_id === c.id; }).length;
            return '<div class="cat-row" data-cat-id="' + c.id + '">' +
                '<input data-f="icon" maxlength="8" value="' + esc(c.icon || "") + '" aria-label="Icoon (emoji)" placeholder="🍚" style="width:60px;flex:0 0 60px;min-width:0">' +
                '<input data-f="name" maxlength="60" value="' + esc(c.name) + '" aria-label="Naam">' +
                '<input data-f="sort_order" type="number" value="' + c.sort_order + '" aria-label="Volgorde" style="width:90px">' +
                '<label class="check"><input data-f="active" type="checkbox"' + (c.active ? " checked" : "") + "> Zichtbaar</label>" +
                '<span class="muted">' + count + " product" + (count === 1 ? "" : "en") + "</span>" +
                '<button class="btn small" type="button" data-save-cat="' + c.id + '">Opslaan</button>' +
                '<button class="btn small danger" type="button" data-delete-cat="' + c.id + '">×</button></div>';
        }).join("");

        openDialog("<h2>Categorieën</h2>" +
            '<p class="muted">Klanten kunnen in de webshop filteren op categorie. Categorieën zonder zichtbare ' +
            "producten worden niet getoond. Een categorie verwijderen verwijdert géén producten.</p>" +
            '<div class="form-grid">' + (rows || '<p class="muted">Nog geen categorieën.</p>') + "</div>" +
            '<h3 style="margin-top:18px">Nieuwe categorie</h3>' +
            '<form id="categoryForm" class="cat-row">' +
            '<input name="icon" maxlength="8" placeholder="🍚" aria-label="Icoon (emoji)" style="width:60px;flex:0 0 60px;min-width:0">' +
            '<input name="name" maxlength="60" required placeholder="bv. Gekleurde rijst">' +
            '<input name="sort_order" type="number" value="' + ((categories.length + 1) * 10) + '" style="width:90px" aria-label="Volgorde">' +
            '<button class="btn small" type="submit">+ Toevoegen</button></form>' +
            '<div class="error" id="categoryError"></div>');
    }

    function uniqueSlug(base, excludeId) {
        let slug = slugify(base) || "categorie";
        let i = 2;
        const taken = function (s) { return categories.some(function (c) { return c.slug === s && c.id !== excludeId; }); };
        while (taken(slug)) slug = slugify(base) + "-" + i++;
        return slug;
    }

    async function addCategory(form) {
        const f = new FormData(form);
        const name = String(f.get("name") || "").trim();
        if (!name) return;
        const { error } = await sb.from("shop_categories").insert({
            name: name, slug: uniqueSlug(name), sort_order: parseInt(f.get("sort_order"), 10) || 0, active: true,
            icon: String(f.get("icon") || "").trim() || null
        });
        if (error) { $("categoryError").textContent = "Toevoegen mislukt: " + error.message; return; }
        await loadCategories();
        openCategories();
        loadProducts();
    }

    async function saveCategory(id) {
        const row = document.querySelector('.cat-row[data-cat-id="' + id + '"]');
        const name = row.querySelector('[data-f="name"]').value.trim();
        if (!name) { $("categoryError").textContent = "Naam is verplicht."; return; }
        // Het webadres (slug) blijft behouden, zodat gedeelde links blijven werken.
        const { error } = await sb.from("shop_categories").update({
            name: name,
            icon: row.querySelector('[data-f="icon"]').value.trim() || null,
            sort_order: parseInt(row.querySelector('[data-f="sort_order"]').value, 10) || 0,
            active: row.querySelector('[data-f="active"]').checked
        }).eq("id", id);
        if (error) { $("categoryError").textContent = "Opslaan mislukt: " + error.message; return; }
        toast("Categorie opgeslagen.");
        await loadCategories();
        loadProducts();
    }

    async function deleteCategory(id) {
        if (!confirm("Categorie verwijderen? De producten blijven bestaan, maar zonder categorie.")) return;
        const { error } = await sb.from("shop_categories").delete().eq("id", id);
        if (error) { $("categoryError").textContent = "Verwijderen mislukt: " + error.message; return; }
        await loadCategories();
        await loadProducts();
        openCategories();
    }

    let editImages = { main: null, extra: [] };

    function openProduct(id) {
        const p = products.find(function (x) { return x.id === id; }) || {
            name: "", slug: "", short_text: "", description: "", safety_note: DEFAULT_SAFETY,
            price: "", max_per_order: 10, weight_grams: "", sort_order: (products.length + 1) * 10,
            active: false, image_path: null, extra_images: []
        };
        editImages = { main: p.image_path, extra: (p.extra_images || []).slice() };

        openDialog('<div class="detail-head"><div><h2>' + (p.id ? "Product bewerken" : "Nieuw product") + "</h2>" +
            (p.id ? '<p class="muted">' + (p.active ? "🟢 Zichtbaar in de webshop" : "⚪ Verborgen") + "</p>" : "") + "</div></div>" +
            '<form id="productForm" class="product-editor">' +
            '<div class="pe-main form-grid">' +

            '<fieldset><legend>Basis</legend><div class="form-grid">' +
            '<div class="form-row"><label>Naam *<input name="name" required maxlength="120" value="' + esc(p.name) + '"></label>' +
            '<label>Webadres (slug) *<input name="slug" required maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" value="' + esc(p.slug) + '"></label></div>' +
            '<label>Korte tekst (op het overzicht) <span class="counter" data-count-for="short_text"></span><input name="short_text" maxlength="300" value="' + esc(p.short_text || "") + '"></label>' +
            '<label>Categorie<select name="category_id"><option value="">– geen –</option>' +
            categories.map(function (c) {
                return '<option value="' + c.id + '"' + (c.id === p.category_id ? " selected" : "") + ">" + esc((c.icon ? c.icon + " " : "") + c.name) +
                    (c.active ? "" : " (verborgen)") + "</option>";
            }).join("") + "</select></label>" +
            '<label>Beschrijving<textarea name="description" rows="5" maxlength="5000">' + esc(p.description || "") + "</textarea></label>" +
            '<label>Veiligheidswaarschuwing<textarea name="safety_note" rows="2" maxlength="500">' + esc(p.safety_note || "") + "</textarea></label>" +
            "</div></fieldset>" +

            "<fieldset><legend>Foto's</legend>" +
            '<p class="muted">De eerste foto is de hoofdfoto. Klik op ★ om een andere foto hoofdfoto te maken. jpg/png/webp, max 10 MB.</p>' +
            '<div class="img-list" id="imgList"></div>' +
            '<label class="dropzone" id="dropzone"><input type="file" id="imgUpload" accept="image/jpeg,image/png,image/webp" multiple>' +
            "<span>📸 Sleep foto's hierheen of <u>klik om te kiezen</u></span></label></fieldset>" +

            '<fieldset><legend>Prijs &amp; voorstelling</legend><div class="form-grid">' +
            '<div class="form-row"><label>Prijs (€) *<input name="price" type="number" min="0" max="10000" step="0.01" required value="' + esc(p.price) + '"></label>' +
            '<label>Van-prijs (€, optioneel – doorstreept)<input name="compare_at_price" type="number" min="0" max="10000" step="0.01" value="' +
            esc(p.compare_at_price == null ? "" : p.compare_at_price) + '"></label></div>' +
            '<div class="form-row"><label>Label (optioneel)<input name="badge" maxlength="20" list="badgeSuggestions" value="' + esc(p.badge || "") + '">' +
            '<datalist id="badgeSuggestions"><option value="Nieuw"><option value="Promo"><option value="Bestseller"><option value="Beperkte oplage"></datalist></label>' +
            '<label>Volgorde<input name="sort_order" type="number" value="' + esc(p.sort_order) + '"></label></div>' +
            '<div class="form-row"><label>Max. per bestelling<input name="max_per_order" type="number" min="1" max="99" value="' + esc(p.max_per_order) + '"></label>' +
            '<label>Gewicht (gram, optioneel)<input name="weight_grams" type="number" min="0" value="' + esc(p.weight_grams == null ? "" : p.weight_grams) + '"></label></div>' +
            '<label class="check switch"><input type="checkbox" name="featured"' + (p.featured ? " checked" : "") + '> <span>Uitgelicht <small class="muted">bovenaan bij "Aanbevolen"</small></span></label>' +
            '<label class="check switch"><input type="checkbox" name="active"' + (p.active ? " checked" : "") + "> <span>Zichtbaar in de webshop</span></label>" +
            "</div></fieldset>" +
            "</div>" +

            '<aside class="pe-side"><div class="pe-sticky"><strong class="muted small-caps">Voorbeeld in de webshop</strong>' +
            '<div id="productPreview"></div></div></aside>' +

            '<div class="pe-foot"><div class="error" id="productError"></div><div class="actions">' +
            '<button class="btn" type="submit">💾 Opslaan</button>' +
            (p.id ? '<button class="btn secondary" type="button" data-duplicate-product>⧉ Dupliceren</button>' : "") +
            (p.id && p.active ? '<a class="btn secondary" href="product.html?p=' + encodeURIComponent(p.slug) +
                '" target="_blank" rel="noopener">Bekijk in webshop ↗</a>' : "") +
            (p.id ? '<button class="btn danger ghost-danger" type="button" data-delete-product>Verwijderen</button>' : "") +
            "</div></div></form>");
        $("productForm").dataset.id = p.id || "";
        renderImgList();
    }

    function renderPreview() {
        const form = $("productForm");
        if (!form || !$("productPreview")) return;
        const f = new FormData(form);
        const price = parseFloat(f.get("price")) || 0;
        const cmp = parseFloat(f.get("compare_at_price"));
        const sale = cmp > price;
        let badgeText = String(f.get("badge") || "").trim();
        if (!badgeText && sale) badgeText = "−" + Math.round((1 - price / cmp) * 100) + "%";
        const cat = categories.find(function (c) { return c.id === f.get("category_id"); });
        $("productPreview").innerHTML = '<article class="preview-card' + (form.elements.active.checked ? "" : " is-hidden") + '">' +
            '<div class="pv-img"><img src="' + S.imageUrl(editImages.main) + '" alt="">' +
            (badgeText ? '<span class="pv-ribbon">' + esc(badgeText) + "</span>" : "") +
            (form.elements.active.checked ? "" : '<span class="pv-hidden">Verborgen</span>') + "</div>" +
            '<div class="pv-body">' + (cat ? '<span class="pv-eyebrow">' + esc(cat.name) + "</span>" : "") +
            "<h4>" + esc(f.get("name") || "Productnaam") + "</h4>" +
            "<p>" + esc(f.get("short_text") || "Korte tekst…") + "</p>" +
            '<div class="pv-foot"><span><strong>' + S.euro(price) + "</strong>" + (sale ? " <s>" + S.euro(cmp) + "</s>" : "") +
            '</span><span class="pv-btn">+ Mandje</span></div></div></article>';
        const cnt = form.querySelector('[data-count-for="short_text"]');
        if (cnt) cnt.textContent = String(f.get("short_text") || "").length + "/300";
    }

    function renderImgList() {
        const all = [editImages.main].concat(editImages.extra).filter(Boolean);
        $("imgList").innerHTML = all.map(function (path, i) {
            return '<figure' + (i === 0 ? ' class="main"' : "") + '><img src="' + S.imageUrl(path) + '" alt="">' +
                (i === 0 ? '<span class="main-tag">Hoofdfoto</span>'
                    : '<button type="button" class="star" data-main-img="' + i + '" title="Maak hoofdfoto" aria-label="Maak hoofdfoto">★</button>') +
                '<button type="button" data-remove-img="' + i + '" aria-label="Foto verwijderen">×</button></figure>';
        }).join("") || '<span class="muted">Nog geen foto\'s.</span>';
        renderPreview();
    }

    async function uploadImages(files) {
        const dz = $("dropzone");
        if (dz) dz.classList.add("busy");
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
            dialogDirty = true;
        }
        if (dz) dz.classList.remove("busy");
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
            category_id: String(f.get("category_id") || "") || null,
            description: String(f.get("description")).trim() || null,
            safety_note: String(f.get("safety_note")).trim() || null,
            price: Math.round(parseFloat(f.get("price")) * 100) / 100,
            max_per_order: parseInt(f.get("max_per_order"), 10) || 10,
            compare_at_price: f.get("compare_at_price") === "" ? null : Math.round(parseFloat(f.get("compare_at_price")) * 100) / 100,
            badge: String(f.get("badge") || "").trim() || null,
            featured: form.elements.featured.checked,
            weight_grams: f.get("weight_grams") === "" ? null : parseInt(f.get("weight_grams"), 10),
            sort_order: parseInt(f.get("sort_order"), 10) || 0,
            active: form.elements.active.checked,
            image_path: editImages.main,
            extra_images: editImages.extra
        };
        if (!row.name || !row.slug || !(row.price >= 0)) { err.textContent = "Naam, webadres en prijs zijn verplicht."; return; }
        if (row.compare_at_price != null && !(row.compare_at_price > row.price)) {
            err.textContent = "De van-prijs moet hoger zijn dan de prijs (of laat ze leeg)."; return;
        }

        const id = form.dataset.id;
        const res = id
            ? await sb.from("shop_products").update(row).eq("id", id)
            : await sb.from("shop_products").insert(row);
        if (res.error) {
            err.textContent = res.error.code === "23505" ? "Dit webadres (slug) bestaat al." : "Opslaan mislukt: " + res.error.message;
            return;
        }
        toast("Product opgeslagen.");
        closeDialog(true);
        loadProducts();
    }

    async function duplicateProduct(id) {
        const p = products.find(function (x) { return x.id === id; });
        if (!p) return;
        let slug = p.slug + "-kopie", i = 2;
        while (products.some(function (x) { return x.slug === slug; })) slug = p.slug + "-kopie-" + i++;
        const copy = Object.assign({}, p, { name: (p.name + " (kopie)").slice(0, 120), slug: slug, active: false });
        delete copy.id; delete copy.created_at; delete copy.updated_at;
        const { data, error } = await sb.from("shop_products").insert(copy).select("id").single();
        if (error) { toast("Dupliceren mislukt: " + error.message, true); return; }
        toast("Kopie aangemaakt (verborgen). Pas ze aan en zet ze op zichtbaar.");
        await loadProducts();
        openProduct(data.id);
    }

    async function deleteProduct(id) {
        if (!confirm("Product definitief verwijderen? (Tip: verbergen kan ook.) Bestaande bestellingen en facturen blijven bewaard.")) return;
        const { error } = await sb.from("shop_products").delete().eq("id", id);
        if (error) { toast("Verwijderen mislukt: " + error.message, true); return; }
        toast("Product verwijderd.");
        closeDialog(true);
        loadProducts();
    }

    /* ======================== KORTINGSCODES ======================== */

    function todayIso() {
        const d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    function discountState(d) {
        const today = todayIso();
        if (!d.active) return ["Uitgeschakeld", "b-grey"];
        if (d.valid_until && today > d.valid_until) return ["Verlopen", "b-grey"];
        if (d.valid_from && today < d.valid_from) return ["Gepland", "b-blue"];
        if (d.max_uses != null && d.used_count >= d.max_uses) return ["Opgebruikt", "b-orange"];
        return ["Actief", "b-green"];
    }

    function discountLabel(d) {
        return d.kind === "percent"
            ? String(Number(d.value)).replace(".", ",") + " %"
            : S.euro(d.value);
    }

    async function loadDiscounts() {
        const { data, error } = await sb.from("shop_discount_codes").select("*").order("created_at", { ascending: false });
        if (error) { toast("Kortingscodes laden mislukt. Draaide je shop.sql opnieuw?", true); return; }
        discounts = data || [];
        $("discountRows").innerHTML = discounts.length ? discounts.map(function (d) {
            const st = discountState(d);
            return '<tr class="clickable" data-discount="' + d.id + '">' +
                "<td><strong>" + esc(d.code) + "</strong>" + (d.description ? '<br><span class="muted">' + esc(d.description) + "</span>" : "") + "</td>" +
                "<td>" + discountLabel(d) + "</td>" +
                "<td>" + (d.min_order != null ? "vanaf " + S.euro(d.min_order) : '<span class="muted">–</span>') + "</td>" +
                "<td>" + (d.valid_from || d.valid_until
                    ? (d.valid_from ? S.formatDate(d.valid_from) : "…") + " – " + (d.valid_until ? S.formatDate(d.valid_until) : "…")
                    : '<span class="muted">altijd</span>') + "</td>" +
                "<td>" + d.used_count + (d.max_uses != null ? " / " + d.max_uses : "") + "</td>" +
                '<td><span class="badge ' + st[1] + '">' + esc(st[0]) + "</span></td>" +
                '<td><button class="btn small secondary" type="button" data-discount="' + d.id + '">Bewerken</button></td></tr>';
        }).join("") : '<tr><td colspan="7" class="empty">Nog geen kortingscodes.</td></tr>';
    }

    function openDiscount(id) {
        const d = discounts.find(function (x) { return x.id === id; }) || {
            code: "", description: "", kind: "percent", value: "", min_order: null,
            valid_from: null, valid_until: null, max_uses: null, used_count: 0, active: true
        };
        const val = function (v) { return v == null ? "" : esc(v); };
        openDialog("<h2>" + (d.id ? "Kortingscode bewerken" : "Nieuwe kortingscode") + "</h2>" +
            '<form id="discountForm" class="form-grid">' +
            '<div class="form-row"><label>Code *<input name="code" required maxlength="30" pattern="[A-Za-z0-9_\\-]{3,30}" ' +
            'style="text-transform:uppercase" value="' + val(d.code) + '"' + (d.used_count > 0 ? " readonly" : "") + "></label>" +
            '<label>Omschrijving (intern)<input name="description" maxlength="200" value="' + val(d.description) + '"></label></div>' +
            '<div class="form-row"><label>Soort<select name="kind">' +
            '<option value="percent"' + (d.kind === "percent" ? " selected" : "") + ">Percentage (%)</option>" +
            '<option value="fixed"' + (d.kind === "fixed" ? " selected" : "") + ">Vast bedrag (€)</option></select></label>" +
            '<label>Waarde *<input name="value" type="number" min="0.01" step="0.01" required value="' + val(d.value) + '"></label></div>' +
            '<div class="form-row"><label>Minimum subtotaal (€, optioneel)<input name="min_order" type="number" min="0" step="0.01" value="' + val(d.min_order) + '"></label>' +
            '<label>Max. aantal keer te gebruiken (optioneel)<input name="max_uses" type="number" min="1" step="1" value="' + val(d.max_uses) + '"></label></div>' +
            '<div class="form-row"><label>Geldig vanaf (optioneel)<input name="valid_from" type="date" value="' + val(d.valid_from) + '"></label>' +
            '<label>Geldig tot en met (optioneel)<input name="valid_until" type="date" value="' + val(d.valid_until) + '"></label></div>' +
            '<label class="check"><input type="checkbox" name="active"' + (d.active ? " checked" : "") + "> Actief</label>" +
            (d.id ? '<p class="muted">Al ' + d.used_count + " keer gebruikt in een betaalde bestelling.</p>" : "") +
            '<div class="error" id="discountError"></div>' +
            '<div class="actions"><button class="btn" type="submit">Opslaan</button>' +
            (d.id && d.used_count === 0 ? '<button class="btn danger" type="button" data-delete-discount>Verwijderen</button>' : "") +
            "</div></form>");
        $("discountForm").dataset.id = d.id || "";
    }

    async function saveDiscount(form) {
        const f = new FormData(form);
        const err = $("discountError");
        err.textContent = "";
        const num = function (k) { const v = f.get(k); return v === "" || v == null ? null : Number(v); };
        const row = {
            code: String(f.get("code") || "").trim().toUpperCase(),
            description: String(f.get("description") || "").trim() || null,
            kind: f.get("kind") === "fixed" ? "fixed" : "percent",
            value: Math.round((num("value") || 0) * 100) / 100,
            min_order: num("min_order"),
            max_uses: num("max_uses") == null ? null : Math.floor(num("max_uses")),
            valid_from: f.get("valid_from") || null,
            valid_until: f.get("valid_until") || null,
            active: form.elements.active.checked
        };
        if (!/^[A-Z0-9_-]{3,30}$/.test(row.code)) { err.textContent = "Code: 3 tot 30 tekens, enkel letters, cijfers, - en _."; return; }
        if (!(row.value > 0)) { err.textContent = "Geef een waarde groter dan 0."; return; }
        if (row.kind === "percent" && row.value > 100) { err.textContent = "Een percentage kan maximaal 100 zijn."; return; }
        if (row.valid_from && row.valid_until && row.valid_from > row.valid_until) {
            err.textContent = "De einddatum ligt vóór de begindatum."; return;
        }

        const id = form.dataset.id;
        const res = id
            ? await sb.from("shop_discount_codes").update(row).eq("id", id)
            : await sb.from("shop_discount_codes").insert(row);
        if (res.error) {
            err.textContent = res.error.code === "23505" ? "Deze code bestaat al." : "Opslaan mislukt: " + res.error.message;
            return;
        }
        toast("Kortingscode opgeslagen.");
        closeDialog(true);
        loadDiscounts();
    }

    async function deleteDiscount(id) {
        if (!confirm("Kortingscode verwijderen?")) return;
        const { error } = await sb.from("shop_discount_codes").delete().eq("id", id);
        if (error) { toast("Verwijderen mislukt: " + error.message, true); return; }
        toast("Kortingscode verwijderd.");
        closeDialog(true);
        loadDiscounts();
    }

    /* ======================== WACHTLIJST ======================== */

    async function loadWaitlist() {
        const { data, error } = await sb.from("shop_notify_signups").select("*").order("created_at", { ascending: false });
        if (error) { waitlist = []; return; }
        waitlist = data || [];
        const open = waitlist.filter(function (w) { return !w.notified_at; });
        $("waitCount").textContent = open.length ? String(open.length) : "";
        $("waitRows").innerHTML = waitlist.length ? waitlist.map(function (w) {
            return "<tr><td>" + esc(w.email) + "</td>" +
                "<td>" + new Date(w.created_at).toLocaleDateString("nl-BE") + "</td>" +
                "<td>" + (w.notified_at ? '<span class="badge b-green">' + new Date(w.notified_at).toLocaleDateString("nl-BE") + "</span>"
                    : '<span class="badge b-orange">Nog niet</span>') + "</td>" +
                '<td><button class="btn small secondary" type="button" data-delete-wait="' + w.id + '">Wissen</button></td></tr>';
        }).join("") : '<tr><td colspan="4" class="empty">Nog niemand op de wachtlijst.</td></tr>';
    }

    async function copyWaitlist() {
        const emails = waitlist.filter(function (w) { return !w.notified_at; }).map(function (w) { return w.email; });
        if (!emails.length) { toast("Geen niet-verwittigde adressen.", true); return; }
        try {
            await navigator.clipboard.writeText(emails.join(", "));
            toast(emails.length + " adres(sen) gekopieerd. Plak ze in BCC.");
        } catch (e) {
            prompt("Kopieer deze adressen:", emails.join(", "));
        }
    }

    async function markWaitlist() {
        const ids = waitlist.filter(function (w) { return !w.notified_at; }).map(function (w) { return w.id; });
        if (!ids.length) { toast("Geen niet-verwittigde adressen.", true); return; }
        if (!confirm(ids.length + " adres(sen) markeren als verwittigd?")) return;
        const { error } = await sb.from("shop_notify_signups").update({ notified_at: new Date().toISOString() }).in("id", ids);
        if (error) { toast("Mislukt: " + error.message, true); return; }
        toast("Gemarkeerd als verwittigd.");
        loadWaitlist();
    }

    async function purgeWaitlist() {
        const ids = waitlist.filter(function (w) { return w.notified_at; }).map(function (w) { return w.id; });
        if (!ids.length) { toast("Geen verwittigde adressen om te wissen.", true); return; }
        if (!confirm(ids.length + " verwittigde adres(sen) definitief wissen?")) return;
        const { error } = await sb.from("shop_notify_signups").delete().in("id", ids);
        if (error) { toast("Wissen mislukt: " + error.message, true); return; }
        toast("Adressen gewist.");
        loadWaitlist();
    }

    async function deleteWait(id) {
        if (!confirm("Dit adres wissen?")) return;
        const { error } = await sb.from("shop_notify_signups").delete().eq("id", id);
        if (error) { toast("Wissen mislukt: " + error.message, true); return; }
        loadWaitlist();
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
        // Enkel meesturen als de database deze kolommen al kent (shop.sql opnieuw gedraaid)
        if (settings && "gift_wrap_enabled" in settings) {
            row.gift_wrap_enabled = form.elements.gift_wrap_enabled.checked;
            row.gift_wrap_price = num("gift_wrap_price") || 0;
            row.gift_wrap_text = String(f.get("gift_wrap_text") || "").trim() ||
                "Mooi ingepakt met een lintje en een kaartje met jouw boodschap.";
        } else if (form.elements.gift_wrap_enabled.checked) {
            $("settingsError").textContent = "Cadeauverpakking kan pas nadat sql/shop.sql opnieuw gedraaid is.";
            return;
        }
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
        renderShopState();
        settingsDirty = false;
        $("settingsDirty").textContent = "";
        toast("Instellingen opgeslagen.");
    }

    let settingsDirty = false;

    /* ======================== EVENTS ======================== */

    document.addEventListener("click", function (e) {
        // Schakelaars in de producttabel: niet het product openen
        if (e.target.closest("label.toggle")) return;
        // Selectievakjes bij bestellingen: niet de bestelling openen
        const selCell = e.target.closest("td.sel, th.sel");
        if (selCell) {
            if (e.target.tagName !== "INPUT") {
                const cb = selCell.querySelector("input");
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event("change", { bubbles: true }));
            }
            return;
        }

        const go = e.target.closest("[data-goto]");
        if (go) { gotoTarget(go.dataset.goto); return; }
        const mini = e.target.closest("li[data-order]");
        if (mini) { openOrder(mini.dataset.order); return; }

        const t = e.target.closest("button, tr[data-order], tr[data-product], tr[data-discount], [data-close]");
        if (!t) return;
        const d = t.dataset;

        if (d.tab) showTab(d.tab);
        else if (d.labelOrder) openLabelDialog([d.labelOrder]);
        else if (t.id === "bulkLabels") openLabelDialog(Array.from(selectedOrders));
        else if (t.id === "bulkSlips") printPackingSlips(Array.from(selectedOrders));
        else if (t.id === "printProduction") printProduction();
        else if (t.id === "bulkClear") { selectedOrders.clear(); renderOrders(); }
        else if (t.id === "selectToShip") {
            const ship = orders.filter(isToShip);
            if (!ship.length) { toast("Er zijn geen betaalde thuisleveringen die nog afgeleverd moeten worden.", true); return; }
            selectedOrders.clear();
            ship.forEach(function (o) { selectedOrders.add(o.id); });
            orderFilter = "paid";
            renderOrders();
            toast(ship.length + " bestelling(en) geselecteerd om te leveren.");
        }
        else if (d.orderFilter) { orderFilter = d.orderFilter; renderOrders(); }
        else if (d.gotoOrders) gotoTarget("orders:" + d.gotoOrders);
        else if (t.id === "shopStateButton") toggleShopState();
        else if (t.id === "reloadDashboard") { loadOrders(); loadWaitlist(); }
        else if (d.mainImg !== undefined) {
            const all = [editImages.main].concat(editImages.extra).filter(Boolean);
            const pick = all.splice(parseInt(d.mainImg, 10), 1)[0];
            all.unshift(pick);
            editImages = { main: all[0], extra: all.slice(1) };
            dialogDirty = true;
            renderImgList();
        }
        else if (t.hasAttribute("data-close")) closeDialog();
        else if (d.order) openOrder(d.order);
        else if (d.product) openProduct(d.product);
        else if (d.discount) openDiscount(d.discount);
        else if (d.saveCat) saveCategory(d.saveCat);
        else if (d.deleteCat) deleteCategory(d.deleteCat);
        else if (d.deleteWait) deleteWait(d.deleteWait);
        else if (t.hasAttribute("data-delete-discount")) deleteDiscount($("discountForm").dataset.id);
        else if (t.id === "newDiscount") openDiscount(null);
        else if (t.id === "manageCategories") openCategories();
        else if (t.id === "copyWaitlist") copyWaitlist();
        else if (t.id === "markWaitlist") markWaitlist();
        else if (t.id === "purgeWaitlist") purgeWaitlist();
        else if (d.setStatus) {
            const notify = $("notifyCustomer") ? $("notifyCustomer").checked : false;
            orderAction(function () {
                const payload = {
                    action: "set_status", order_id: currentOrder.id, status: d.setStatus, notify: notify,
                    tracking_code: $("trackingCode") ? $("trackingCode").value : ""
                };
                if ($("deliverySlot")) payload.delivery_slot = $("deliverySlot").value;
                return callAdmin(payload);
            }, "Status bijgewerkt" + (notify ? " en klant verwittigd." : "."));
        }
        else if (d.withdrawDone) {
            orderAction(async function () {
                const { error } = await sb.from("shop_withdrawals")
                    .update({ status: "processed", processed_at: new Date().toISOString() }).eq("id", d.withdrawDone);
                if (error) throw new Error(error.message);
            }, "Herroeping gemarkeerd als verwerkt.");
        }
        else if (d.deliverStatus) {
            deliveryAction(d.deliverOrder, d.deliverStatus, t);
        }
        else if (t.id === "sendTestMail") sendTestMail();
        else if (t.id === "deliverAllOut") markAllOut();
        else if (t.id === "printDeliveries") printDeliveryList();
        else if (t.id === "routeDeliveries") openRoute();
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
            dialogDirty = true;
            renderImgList();
        }
        else if (t.hasAttribute("data-delete-product")) deleteProduct($("productForm").dataset.id);
        else if (t.hasAttribute("data-duplicate-product")) duplicateProduct($("productForm").dataset.id);
        else if (d.doc !== undefined) downloadDoc(invoiceDocs[parseInt(d.doc, 10)]);
        else if (t.id === "newProduct") openProduct(null);
        else if (t.id === "reloadOrders") loadOrders();
        else if (t.id === "exportCsv") exportCsv();
        else if (t.id === "logoutButton") sb.auth.signOut().then(function () { location.reload(); });
    });

    document.addEventListener("input", function (e) {
        if (e.target.closest("#creditLines")) updateCreditTotal();
        if (e.target.id === "orderSearch") renderOrders();
        if (e.target.id === "productSearchAdmin") renderProducts();
        if (e.target.closest("#dialogBody form")) dialogDirty = true;
        if (e.target.closest("#productForm")) renderPreview();
        if (e.target.closest("#settingsForm")) {
            settingsDirty = true;
            $("settingsDirty").textContent = "● Niet-opgeslagen wijzigingen";
        }
        if (e.target.name === "name" && e.target.form && e.target.form.id === "productForm" && !e.target.form.dataset.id) {
            e.target.form.elements.slug.value = slugify(e.target.value);
        }
    });

    document.addEventListener("change", function (e) {
        if (e.target.dataset && e.target.dataset.select) {
            if (e.target.checked) selectedOrders.add(e.target.dataset.select); else selectedOrders.delete(e.target.dataset.select);
            e.target.closest("tr").classList.toggle("selected", e.target.checked);
            renderBulkBar();
            return;
        }
        if (e.target.id === "selectAllOrders") {
            visibleOrderIds.forEach(function (id) { if (e.target.checked) selectedOrders.add(id); else selectedOrders.delete(id); });
            renderOrders();
            return;
        }
        if (e.target.closest && e.target.closest("#labelForm")) { renderLabelPreview(); return; }
        if (e.target.dataset && e.target.dataset.toggle) { toggleProductField(e.target); return; }
        if (e.target.id === "productFilterAdmin") renderProducts();
        if (e.target.closest && e.target.closest("#productForm")) { dialogDirty = true; renderPreview(); }
        if (e.target.closest && e.target.closest("#settingsForm")) {
            settingsDirty = true;
            $("settingsDirty").textContent = "● Niet-opgeslagen wijzigingen";
        }
        if (e.target.id === "orderFilter") renderOrders();
        if (e.target.id === "invYear" || e.target.id === "invPeriod") loadInvoices();
        if (e.target.id === "imgUpload") uploadImages(Array.from(e.target.files || []));
    });

    // Foto's slepen naar de dropzone
    ["dragenter", "dragover"].forEach(function (ev) {
        document.addEventListener(ev, function (e) {
            const dz = e.target.closest && e.target.closest("#dropzone");
            if (!dz) return;
            e.preventDefault();
            dz.classList.add("over");
        });
    });
    document.addEventListener("dragleave", function (e) {
        const dz = e.target.closest && e.target.closest("#dropzone");
        if (dz && !dz.contains(e.relatedTarget)) dz.classList.remove("over");
    });
    document.addEventListener("drop", function (e) {
        const dz = e.target.closest && e.target.closest("#dropzone");
        if (!dz) return;
        e.preventDefault();
        dz.classList.remove("over");
        uploadImages(Array.from(e.dataTransfer.files || []));
    });

    window.addEventListener("beforeunload", function (e) {
        if (dialogDirty || settingsDirty) { e.preventDefault(); e.returnValue = ""; }
    });

    document.addEventListener("submit", function (e) {
        e.preventDefault();
        if (e.target.id === "productForm") saveProduct(e.target);
        else if (e.target.id === "settingsForm") saveSettings(e.target);
        else if (e.target.id === "creditForm") submitCredit(e.target);
        else if (e.target.id === "discountForm") saveDiscount(e.target);
        else if (e.target.id === "categoryForm") addCategory(e.target);
        else if (e.target.id === "labelForm") submitLabels();
    });

    $("overlay").addEventListener("click", function () { closeDialog(); });
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { closeDialog(); return; }
        // "/" = zoeken in het actieve onderdeel
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
        if (e.key === "/" && !typing && !$("dialog").classList.contains("open")) {
            const panel = document.querySelector(".panel:not(.hidden)");
            const s = panel && panel.querySelector("[data-search]");
            if (s) { e.preventDefault(); s.focus(); }
        }
        if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("li[data-goto]")) {
            e.preventDefault();
            gotoTarget(e.target.dataset.goto);
        }
    });

    // Jaarkeuze facturen
    const thisYear = new Date().getFullYear();
    for (let y = thisYear; y >= 2026; y--) {
        $("invYear").insertAdjacentHTML("beforeend", '<option value="' + y + '">' + y + "</option>");
    }

    start();
})();
