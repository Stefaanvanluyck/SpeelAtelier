const CACHE_NAME = "kleine-wonderwereld-v1";
const ASSETS = [
    "./",
    "./index.html",
    "./favicon.png",
    "./logosite.jpeg",
    "./Valerie.jpeg",
    "./gekleurderijst.jpeg",
    "./speelatteliervoorbeeld1.jpeg",
    "./speelatteliervoorbeeld2.jpeg",
    "./waterenspel.jpeg",
    "./beurtenkaart5.jpeg",
    "./beurtenkaart10.jpeg",
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