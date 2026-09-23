import { voice } from "./voice.js?v=49";

/** GitHub Pages, APK WebView, and phones should talk with the device voice. */
export function usePhoneVoice() {
  const host = String(location.hostname || "");
  return !/^(localhost|127\.0\.0\.1)$/i.test(host);
}

export function speakOut(text, opts = {}) {
  const cleaned = (text || "").trim();
  if (!cleaned) return Promise.resolve();
  voice.unlock({ fromGesture: true });
  if (usePhoneVoice()) {
    voice.sayNow(cleaned);
    return Promise.resolve();
  }
  return voice.speak(cleaned, opts);
}
