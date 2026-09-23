import { getSettings } from "./config.js";
import { voice } from "./voice.js?v=50";

const IS_ANDROID = /Android/i.test(navigator.userAgent || "");
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "");

function pauseKeepPlayer() {
  if (IS_IOS) return;
  const player = document.getElementById("tts-player");
  if (!player) return;
  try {
    player.loop = false;
    player.pause();
  } catch {
    /* ignore */
  }
}

function waitForVoices(synth) {
  const existing = synth.getVoices() || [];
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const done = () => resolve(synth.getVoices() || []);
    synth.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 800);
  });
}

function speakWithDevice(text) {
  const synth = window.speechSynthesis;
  if (!synth) return Promise.resolve(false);
  pauseKeepPlayer();
  try {
    synth.cancel();
    synth.resume();
  } catch {
    /* ignore */
  }
  return waitForVoices(synth).then(
    () =>
      new Promise((resolve) => {
        let settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        try {
          const utter = new SpeechSynthesisUtterance(text);
          const settings = getSettings();
          utter.lang = settings.language || "en-US";
          utter.rate = Number(settings.speech_rate || 1) || 1;
          utter.volume = 1;
          // Android Chrome often goes silent if a specific voice is forced.
          if (!IS_ANDROID) {
            const voices = synth.getVoices() || [];
            const lang = String(utter.lang).toLowerCase();
            const chosen =
              voices.find((item) => String(item.lang || "").toLowerCase().startsWith(lang)) ||
              voices.find((item) => /en/i.test(item.lang || ""));
            if (chosen) utter.voice = chosen;
          }
          utter.onstart = () => finish(true);
          utter.onend = () => finish(true);
          utter.onerror = () => finish(false);
          synth.speak(utter);
          setTimeout(() => {
            try {
              synth.pause();
              synth.resume();
            } catch {
              /* some tablets need this kick */
            }
          }, 40);
          setTimeout(() => finish(synth.speaking || synth.pending), 4000);
        } catch {
          finish(false);
        }
      })
  );
}

export function speakOut(text, opts = {}) {
  const cleaned = (text || "").trim();
  if (!cleaned) return Promise.resolve();
  pauseKeepPlayer();
  try {
    voice.unlock({ fromGesture: false });
  } catch {
    /* ignore */
  }
  return speakWithDevice(cleaned).then((ok) => {
    if (ok) return;
    return voice.speak(cleaned, opts);
  });
}
