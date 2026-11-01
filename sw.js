const CACHE_NAME = "kleine-wonderwereld-v6";
const ASSETS = [
    "./",
    "./index.html",
    "./favicon.png",
    "./logosite.webp",
    "./Valerie.webp",
    "./gekleurderijst.webp",
    "./speelatteliervoorbeeld1.webp",
    "./speelatteliervoorbeeld2.webp",
    "./waterenspel.webp",
    "./beurtenkaart5.webp",
    "./beurtenkaart10.webp",
    "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== CACHE_NAME)
                        .map((key) => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const request = event.request;

    if (request.method !== "GET") {
        return;
    }

    const url = new URL(request.url);

    if (url.origin !== location.origin) {
        return;
    }

    // Admin-pagina nooit cachen (gevoelige gegevens, altijd vers).
    if (/\/admin(\.html)?$/i.test(url.pathname)) {
        return;
    }

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response && response.ok) {
                    const clone = response.clone();
                    caches
                        .open(CACHE_NAME)
                        .then((cache) =>
                            cache.put(request, clone)
                        );
                }
                return response;
            })
            .catch(() => caches.match(request))
    );
});