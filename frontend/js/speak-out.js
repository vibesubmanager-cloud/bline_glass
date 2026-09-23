import { getSettings } from "./config.js";

export function speakOut(text) {
  const cleaned = (text || "").trim();
  if (!cleaned) return Promise.resolve();
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve();
  try {
    if (synth.speaking || synth.pending) synth.cancel();
  } catch {
    /* ignore */
  }
  try {
    synth.resume();
  } catch {
    /* ignore */
  }
  const utter = new SpeechSynthesisUtterance(cleaned);
  const settings = getSettings();
  utter.lang = settings.language || "en-US";
  utter.rate = Number(settings.speech_rate || 1) || 1;
  utter.volume = 1;
  synth.speak(utter);
  return Promise.resolve();
}
