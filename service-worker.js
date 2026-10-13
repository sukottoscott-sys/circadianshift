// Network-first with cache fallback: the current deploy whenever online, the last
// cached copy when offline or when the network stalls past NET_TIMEOUT.
const CACHE_NAME = "circadianshift-v11";
const ASSETS = ["./", "./index.html", "./manifest.json", "./icon-180.png", "./icon-512.png"];
const NET_TIMEOUT = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), NET_TIMEOUT);
      const res = await fetch(event.request, { signal: controller.signal });
      clearTimeout(timer);
      if (res && res.ok) cache.put(event.request, res.clone());
      return res;
    } catch {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") { const shell = await cache.match("./index.html"); if (shell) return shell; }
      throw new Error("no network and no cache for " + event.request.url);
    }
  })());
});
