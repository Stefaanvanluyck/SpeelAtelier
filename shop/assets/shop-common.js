/* =========================================================
   Webshop – gedeelde configuratie en hulpfuncties
   (los van index.html / admin.html van de inschrijvingen)
========================================================= */

window.SHOP = (function () {
    "use strict";

    const SUPABASE_URL = "https://nafajvywiknelkgufpac.supabase.co";
    const SUPABASE_ANON_KEY =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5hZmFqdnl3aWtuZWxrZ3VmcGFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyMTQ4ODcsImV4cCI6MjA5Nzc5MDg4N30.ZIrDry9i5slXuyZnSgd6L-baKI72ZtczX1nvoT3Azck";

    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const CART_KEY = "kww_shop_cart_v1";

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function euro(n) {
        return "€ " + Number(n || 0).toFixed(2).replace(".", ",");
    }

    function formatDate(d) {
        if (!d) return "";
        const s = String(d).slice(0, 10).split("-");
        return s.length === 3 ? s[2] + "/" + s[1] + "/" + s[0] : String(d);
    }

    function imageUrl(path) {
        if (!path) return "../gekleurderijst.webp";
        return SUPABASE_URL + "/storage/v1/object/public/shop-products/" +
            String(path).split("/").map(encodeURIComponent).join("/");
    }

    /* ---------- winkelmandje (localStorage) ---------- */

    function readCart() {
        try {
            const raw = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
            return Array.isArray(raw)
                ? raw.filter(function (i) {
                    return i && typeof i.product_id === "string" &&
                        Number.isInteger(i.quantity) && i.quantity > 0;
                })
                : [];
        } catch (e) {
            return [];
        }
    }

    function writeCart(items) {
        localStorage.setItem(CART_KEY, JSON.stringify(items));
        document.dispatchEvent(new CustomEvent("cart:changed"));
    }

    function clearCart() {
        writeCart([]);
    }

    function setQuantity(productId, quantity) {
        const items = readCart().filter(function (i) { return i.product_id !== productId; });
        if (quantity > 0) items.push({ product_id: productId, quantity: quantity });
        writeCart(items);
    }

    function addToCart(productId, quantity) {
        const current = readCart().find(function (i) { return i.product_id === productId; });
        setQuantity(productId, (current ? current.quantity : 0) + quantity);
    }

    function cartCount() {
        return readCart().reduce(function (s, i) { return s + i.quantity; }, 0);
    }

    return {
        SUPABASE_URL: SUPABASE_URL,
        sb: sb,
        escapeHtml: escapeHtml,
        euro: euro,
        formatDate: formatDate,
        imageUrl: imageUrl,
        readCart: readCart,
        writeCart: writeCart,
        clearCart: clearCart,
        setQuantity: setQuantity,
        addToCart: addToCart,
        cartCount: cartCount
    };
})();
