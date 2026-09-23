import { installYolo } from "./yolo-on-device.js";

/** Starts the on-phone YOLO download as soon as the app opens, including before sign-in. */
export function preloadYolo() {
  pingServiceWorker();
  installYolo().catch(() => undefined);
}

function pingServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  const url = new URL("../sw.js", import.meta.url).href;
  navigator.serviceWorker.getRegistrations().then((regs) => {
    const hit = regs.find((reg) => (reg.active || reg.installing || reg.waiting)?.scriptURL?.includes("sw.js"));
    if (hit) {
      (hit.active || hit.waiting || hit.installing)?.postMessage({ type: "INSTALL_YOLO" });
      return;
    }
    navigator.serviceWorker.register(url).catch(() => undefined);
  }).catch(() => undefined);
}
