/* Keeps a copy of the app so it opens with no internet. It always asks the
   network first, so an update is never held back: the saved copy is only
   used when there is no connection. The shared calendar itself is never
   cached here; the app keeps its own copy and syncs when it's back online. */
const CACHE = "schedule-sync";
const FILES = ["./", "manifest.webmanifest", "icon.svg", "icon-192.png", "apple-touch-icon.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const r = e.request, url = new URL(r.url);
  if(r.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(fetch(r).then(res => {
    if(res.ok && !url.search){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
    return res;
  }).catch(() => caches.match(r, {ignoreSearch: true})
    .then(hit => hit || (r.mode === "navigate" ? caches.match("./") : Response.error()))));
});
