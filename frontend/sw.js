const CACHE = "vibeeye-shell-v1";
const PRECACHE = [
  "./",
  "./index.html",
  "./offline.html",
  "./manifest.json",
  "./pages/home.html",
  "./pages/welcome.html",
  "./pages/emergency.html",
  "./pages/contacts.html",
  "./pages/chat.html",
  "./pages/settings.html",
  "./pages/profile.html",
  "./pages/how-to-use.html",
  "./css/main.css",
  "./css/accessibility.css",
  "./css/responsive.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => undefined))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
});

function isApi(url) {
  return url.pathname.startsWith("/api") || url.hostname.includes("onrender.com");
}

function isCdn(url) {
  return /jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|tensorflow/i.test(url.hostname);
}

async function fromCache(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const url = new URL(request.url);
  if (url.pathname.endsWith(".html") || request.mode === "navigate") {
    return (await caches.match("./pages/home.html")) || (await caches.match("./offline.html"));
  }
  return null;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isApi(url)) return;

  event.respondWith(
    (async () => {
      if (isCdn(url) || url.origin === self.location.origin) {
        const cached = await caches.match(request);
        if (cached) {
          fetch(request)
            .then((response) => {
              if (response && response.ok) {
                caches.open(CACHE).then((cache) => cache.put(request, response.clone())).catch(() => undefined);
              }
            })
            .catch(() => undefined);
          return cached;
        }
      }
      try {
        const response = await fetch(request);
        if (response && response.ok && (url.origin === self.location.origin || isCdn(url))) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      } catch {
        const fallback = await fromCache(request);
        if (fallback) return fallback;
        throw new Error("offline");
      }
    })()
  );
});
