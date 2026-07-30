const CACHE_NAME = "noteflow-v11";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Stale-while-revalidate: serve instantly from cache, then fetch a fresh copy
// in the background and update the cache for next time. If the fresh copy
// differs from what was just served, tell open tabs a new version is ready
// (app.js listens and offers a reload) instead of silently waiting for the
// next full reload cycle before an update takes effect.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then(async (response) => {
          if (response && response.ok) {
            const cachedClone = cached ? await cached.clone().text() : null;
            const freshClone = await response.clone().text();
            if (cached && cachedClone !== freshClone) {
              const clients = await self.clients.matchAll();
              clients.forEach((c) => c.postMessage({ type: "noteflow-update-available" }));
            }
            cache.put(event.request, response.clone());
          }
          return response;
        })
        .catch(() => null);
      return cached || network || fetch(event.request);
    })
  );
});
