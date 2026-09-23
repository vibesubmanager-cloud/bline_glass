import { voice } from "./voice.js?v=53";

/** Same speaking path as contacts: do not use a separate home-only synthesizer. */
export function speakOut(text, opts = {}) {
  const cleaned = (text || "").trim();
  if (!cleaned) return Promise.resolve();
  return voice.speak(cleaned, { interrupt: true, ...opts });
}
