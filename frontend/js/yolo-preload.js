import { installYolo } from "./yolo-on-device.js";

function swUrl() {
  return new URL("../sw.js", import.meta.url).href;
}

function pingServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register(swUrl())
    .then((reg) => {
      const send = () => reg.active?.postMessage({ type: "INSTALL_YOLO" });
      if (reg.active) send();
      else navigator.serviceWorker.addEventListener("controllerchange", send, { once: true });
    })
    .catch(() => undefined);
}

/** Starts the on-phone YOLO download as soon as the app opens, including before sign-in. */
export function preloadYolo() {
  pingServiceWorker();
  installYolo().catch(() => undefined);
}
