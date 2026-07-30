const CACHE_NAME = "noteflow-v13";
const ASSETS = ["./", "./index.html", "./style.css", "./app.js", "./manifest.json", "./search-worker.js"];

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
//
// Scoped to same-origin app shell requests only: Firestore's long-polling
// GETs and CDN scripts (tesseract.js, jsQR) must never be intercepted here —
// caching a Firestore channel response breaks sync, and diffing a multi-MB
// CDN script on every load is wasted work for a resource we don't own.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const isNavigation = event.request.mode === "navigate";
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: isNavigation });
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
      if (cached) return cached;
      const fresh = await network;
      if (fresh) return fresh;
      return isNavigation ? cache.match("./index.html") : Response.error();
    })
  );
});

// The "Dans 10 min" action button on a reminder notification (see
// notifyReminder() in app.js) needs a click handler here — a notification
// created via ServiceWorkerRegistration.showNotification() has no other way
// to hand its action back to the app.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const noteId = event.notification.data && event.notification.data.noteId;
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      if (event.action === "snooze" && noteId) {
        clients.forEach((c) => c.postMessage({ type: "noteflow-snooze-reminder", noteId }));
      } else if (clients.length) {
        clients[0].focus();
      }
    })
  );
});
