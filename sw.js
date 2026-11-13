/* ==========================================================================
   Offline support. Deliberately simple:

   - The site's own files: network first, the cache only when offline. A new
     deploy is live on the next load; no stale page against fresh scripts.
   - three.js from jsDelivr: cache first. Its URL pins the exact version, so
     a cached copy can never be out of date.

   The page posts the list of everything it loaded (see registerWorker in
   js/main.js), so the first visit already fills the cache.
   ========================================================================== */

const CACHE = "tangletris-v1";
const CDN = "https://cdn.jsdelivr.net/";
const SHELL = ["./", "./cs/", "./styles.css", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function cacheable(url) {
  return url.startsWith(self.location.origin) || url.startsWith(CDN);
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cache" || !Array.isArray(data.urls)) return;
  const urls = data.urls.filter((u) => typeof u === "string" && cacheable(u)).slice(0, 200);
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        urls.map((url) =>
          cache.match(url).then((hit) => {
            if (hit) return;
            const req = new Request(url, { mode: url.startsWith(CDN) ? "cors" : "same-origin" });
            return fetch(req)
              .then((res) => (res.ok ? cache.put(url, res) : null))
              .catch(() => {});
          })
        )
      )
    )
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.headers.has("range")) return;
  const url = req.url;

  if (url.startsWith(CDN)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
      )
    );
    return;
  }

  if (!url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        // Offline. A page opened with ?mode=… still finds the cached page.
        caches.match(req, { ignoreSearch: req.mode === "navigate" }).then((hit) => {
          if (hit) return hit;
          if (req.mode === "navigate") return caches.match("./");
          return Response.error();
        })
      )
  );
});
