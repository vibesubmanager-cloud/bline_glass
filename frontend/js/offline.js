import { isStandaloneApp } from "./location.js";

function isIos() {
  return /iPad|iPhone|iPod/i.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** iPhone home-screen apps break camera if a service worker serves old pages. */
export async function registerOffline() {
  if (!("serviceWorker" in navigator)) return;
  if (isIos() || isStandaloneApp()) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((reg) => reg.unregister()));
    } catch {
      /* camera still needs to start */
    }
    return;
  }
  const script = new URL("../sw.js", import.meta.url);
  const scope = new URL("../", import.meta.url);
  navigator.serviceWorker.register(script.href, { scope: scope.href }).catch(() => undefined);
}
