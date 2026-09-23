const CACHE = "aisight-static-v5";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./offline.html",
  "./css/main.css",
  "./css/accessibility.css",
  "./css/responsive.css",
  "./pages/home.html",
  "./pages/login.html",
  "./pages/register.html",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api")) return;
  event.respondWith(
    fetch(event.request).catch(async () => {
      const cached = await caches.match(event.request);
      return cached || caches.match("./offline.html");
    })
  );
});
