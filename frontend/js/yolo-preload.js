/** Register the offline cache. Do not unregister — that made the app blank without internet. */
import { registerOffline } from "./offline.js";

export function preloadYolo() {
  registerOffline();
}
