/** Unregister old service workers. They were forcing the camera page to reload. */
export function preloadYolo() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => reg.unregister());
  }).catch(() => undefined);
}
