/** Keep the PWA usable offline after the first visit. */
export function registerOffline() {
  if (!("serviceWorker" in navigator)) return;
  const script = new URL("../sw.js", import.meta.url);
  const scope = new URL("../", import.meta.url);
  navigator.serviceWorker.register(script.href, { scope: scope.href }).catch(() => undefined);
}
