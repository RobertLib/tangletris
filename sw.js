/* ==========================================================================
   Offline support. Deliberately simple:

   - The site's own files: network first, the cache when offline — or when
     the network hangs for more than a few seconds. A new deploy is live on
     the next load; no stale page against fresh scripts.
   - three.js from jsDelivr: cache first. Its URL pins the exact version, so
     a cached copy can never be out of date.

   The page posts the list of everything it loaded (see registerWorker in
   js/main.js), so the first visit already fills the cache.

   The origin (robertlib.github.io) is shared with other projects and their
   own workers: this one only ever touches caches named "tangletris-…".
   ========================================================================== */

const PREFIX = "tangletris-";
const CACHE = PREFIX + "v2";
const CDN = "https://cdn.jsdelivr.net/";
// Both languages of the game, so either opens offline after one visit.
const SHELL = [
  "./",
  "./cs/",
  "./styles.css",
  "./manifest.webmanifest",
  "./cs/manifest.webmanifest",
  "./icon.svg",
];
// A connection that hangs is worse than none: after this long, a cached
// copy answers, and the network still refreshes it in the background.
const NETWORK_TIMEOUT_MS = 4000;

function scoped(path) {
  return new URL(path, self.registration.scope).href;
}

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
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

function cacheable(url) {
  return url.startsWith(self.location.origin) || url.startsWith(CDN);
}

// The address a response is kept under. A page without its query: every
// challenge link (?mode=…&seed=…) is the same page, and must not pile up a
// copy each. A world fetched again under ?retry=N (js/scenes/index.js) is
// still the same file, and offline the retry has to find it.
function cacheKey(input) {
  const req = typeof input === "string" ? null : input;
  const u = new URL(req ? req.url : input);
  if (req && req.mode === "navigate") {
    u.search = "";
    u.hash = "";
    return u.href;
  }
  if (u.origin === self.location.origin && u.searchParams.has("retry")) {
    u.searchParams.delete("retry");
    return u.href;
  }
  return req || u.href;
}

function store(cache, url) {
  const req = new Request(url, { mode: url.startsWith(CDN) ? "cors" : "same-origin" });
  return fetch(req)
    .then((res) => (res.ok && !res.redirected ? cache.put(cacheKey(url), res) : null))
    .catch(() => {});
}

// "three@0.170.0" from a jsDelivr address.
function cdnPackage(url) {
  const m = /^https:\/\/cdn\.jsdelivr\.net\/npm\/([^/]+@[^/]+)\//.exec(url);
  return m ? m[1] : "";
}

// Old three.js versions after the import map moves on, and copies kept
// under a ?retry address by earlier versions of this worker. Only versions
// the page did not load at all are dropped — never a file of one in use.
function prune(cache, loaded) {
  const inUse = new Set(loaded.map(cdnPackage).filter(Boolean));
  return cache.keys().then((reqs) =>
    Promise.all(
      reqs.map((r) => {
        const oldCdn = r.url.startsWith(CDN) && inUse.size > 0 && !inUse.has(cdnPackage(r.url));
        return oldCdn || /[?&]retry=/.test(r.url) ? cache.delete(r) : null;
      })
    )
  );
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cache" || !Array.isArray(data.urls)) return;
  const urls = data.urls
    .filter((u) => typeof u === "string" && cacheable(u))
    .slice(0, 200)
    .map((u) => cacheKey(u));
  event.waitUntil(
    caches.open(CACHE).then((cache) => {
      const jobs = urls.map((url) => cache.match(url).then((hit) => (hit ? null : store(cache, url))));
      // The page that sent this refreshed its own shell as it loaded; the
      // other language's copy is refreshed here, so offline neither page is
      // older than the scripts it runs.
      if (data.final) for (const url of SHELL.map(scoped)) jobs.push(store(cache, url));
      return Promise.all(jobs).then(() => (data.final ? prune(cache, urls) : null));
    })
  );
});

// A page that is not cached yet (a guide page never opened online) gets
// the game in its language instead. Redirected, not served under the asked
// address: the game page's relative links would point into the wrong
// folder there.
function offlinePage(req) {
  const scope = self.registration.scope;
  const path = req.url.startsWith(scope) ? req.url.slice(scope.length) : "";
  const home = scoped(path === "cs" || path.startsWith("cs/") ? "./cs/" : "./");
  if (home === cacheKey(req)) return Promise.resolve(Response.error());
  return caches.match(home).then((hit) => (hit ? Response.redirect(home, 302) : Response.error()));
}

function fromCache(req, key) {
  return caches.match(key).then((hit) => {
    if (hit) return hit;
    if (req.mode === "navigate") return offlinePage(req);
    return Response.error();
  });
}

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

  const key = cacheKey(req);
  const network = fetch(req).then((res) => {
    // A redirected response cannot answer a navigation later (Safari
    // refuses it), so only the final page is kept.
    if (res.ok && res.type === "basic" && !res.redirected) {
      const copy = res.clone();
      event.waitUntil(
        caches
          .open(CACHE)
          .then((c) => c.put(key, copy))
          .catch(() => {})
      );
    }
    return res;
  });
  // Keeps the worker alive until the fresh copy is stored, even when the
  // cache has already answered.
  event.waitUntil(network.then(() => {}, () => {}));

  event.respondWith(
    new Promise((resolve) => {
      let answered = false;
      const answer = (res) => {
        if (answered) return;
        answered = true;
        resolve(res);
      };
      const timer = setTimeout(() => {
        caches.match(key).then((hit) => hit && answer(hit), () => {});
      }, NETWORK_TIMEOUT_MS);
      network.then(
        (res) => {
          clearTimeout(timer);
          answer(res);
        },
        () => {
          // Offline. A page opened with ?mode=… still finds the cached page.
          clearTimeout(timer);
          fromCache(req, key).then(answer, () => answer(Response.error()));
        }
      );
    })
  );
});
