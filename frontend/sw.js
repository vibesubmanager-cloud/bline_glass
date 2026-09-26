const CACHE = "vibeeye-shell-v2";

self.addEventListener("install", () => {
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

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (isApi(url)) return;
  if (request.mode === "navigate" || url.pathname.endsWith(".html")) return;

  if (url.origin !== self.location.origin && !isCdn(url)) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      } catch {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error("offline");
      }
    })()
  );
});
