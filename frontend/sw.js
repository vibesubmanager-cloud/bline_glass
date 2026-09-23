const CACHE = "aisight-static-v6";
const YOLO_CACHE = "aisight-yolo-v1";
const YOLO_KEY = "/aisight-yolo/yolov8n.onnx";
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

async function cacheYolo() {
  const cache = await caches.open(YOLO_CACHE);
  if (await cache.match(YOLO_KEY)) return;
  const url = new URL("./models/yolov8n.onnx", self.location.href).href;
  const response = await fetch(url, { cache: "reload" });
  if (!response.ok) return;
  await cache.put(YOLO_KEY, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(STATIC_ASSETS).catch(() => undefined);
      await cacheYolo().catch(() => undefined);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE && key !== YOLO_CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "INSTALL_YOLO") {
    event.waitUntil(cacheYolo());
  }
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
