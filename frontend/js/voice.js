import { getApiBase, getSettings, getToken } from "./config.js";
import { smallTalkReply } from "./intent.js?v=37";
import { appState, STATES } from "./state.js";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "");
const IS_ANDROID = /Android/i.test(navigator.userAgent || "");

function quietWavUrl() {
  const sampleRate = 22050;
  const samples = Math.floor(sampleRate * 0.35);
  const dataSize = samples * 2;
  const bytes = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bytes);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(44 + i * 2, ((i % 6) - 3) * 12, true);
  }
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

const KEEP_SRC = quietWavUrl();

function preferredVoice(voices, name) {
  if (name) {
    const match = voices.find((v) => v.name === name);
    if (match) return match;
  }
  return (
    voices.find((v) => v.localService && /en/i.test(v.lang)) ||
    voices.find((v) => /en/i.test(v.lang) && v.localService) ||
    voices.find((v) => /en-US/i.test(v.lang)) ||
    voices[0]
  );
}

function pcmWavToBuffer(ctx, arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    throw new Error("not-wav");
  }
  let offset = 12;
  let channels = 1;
  let sampleRate = 22050;
  let bits = 16;
  let dataOffset = 0;
  let dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(offset + 10, true) || 1;
      sampleRate = view.getUint32(offset + 12, true) || 22050;
      bits = view.getUint16(offset + 22, true) || 16;
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!dataSize) throw new Error("no-data");
  const bytesPerSample = Math.max(1, bits / 8);
  const frameCount = Math.floor(dataSize / (bytesPerSample * channels));
  const buffer = ctx.createBuffer(1, Math.max(1, frameCount), sampleRate);
  const out = buffer.getChannelData(0);
  if (bits === 16) {
    for (let i = 0; i < frameCount; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels; c += 1) {
        sum += view.getInt16(dataOffset + (i * channels + c) * 2, true);
      }
      out[i] = sum / channels / 32768;
    }
  } else {
    throw new Error("bits");
  }
  return buffer;
}

function wavDurationMs(arrayBuffer) {
  try {
    const view = new DataView(arrayBuffer);
    const byteRate = view.getUint32(28, true) || 44100;
    const dataSize = view.getUint32(40, true) || Math.max(0, arrayBuffer.byteLength - 44);
    return Math.min(20000, Math.max(800, Math.ceil((dataSize / byteRate) * 1000) + 350));
  } catch {
    return 4000;
  }
}

function splitSpeakChunks(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= 180) return [cleaned];
  const chunks = [];
  let buf = "";
  cleaned.split(" ").forEach((word) => {
    const next = buf ? `${buf} ${word}` : word;
    if (next.length > 180 && buf) {
      chunks.push(buf);
      buf = word;
    } else {
      buf = next;
    }
  });
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [cleaned];
}

class VoiceService {
  constructor() {
    this.synth = window.speechSynthesis;
    this.recognition = null;
    this.voices = [];
    this.player = document.getElementById("tts-player") || new Audio();
    this.player.setAttribute("playsinline", "true");
    this.player.setAttribute("webkit-playsinline", "true");
    this.player.playsInline = true;
    this.player.preload = "auto";
    this.ctx = null;
    this._utterance = null;
    this._playing = false;
    this._unlocked = false;
    this._serverToken = 0;
    this._objectUrl = "";
    this._pending = null;
    this._webSource = null;
    this._instantChat = "";
    this._usedMic = false;
    this._finishSpeak = null;
    this._keepOsc = null;
    this._keepGain = null;
    this._keepNoise = null;
    this._primed = false;
    this._busy = false;
    this._onStart = null;
    this._synthDone = Promise.resolve(false);
    if (this.synth) {
      this.synth.addEventListener("voiceschanged", () => {
        this.voices = this.synth.getVoices();
      });
      this.voices = this.synth.getVoices();
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.keepAlive(true);
    });
  }

  isSpeaking() {
    return Boolean(this._playing || this._busy);
  }

  _audioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new Ctx();
      this._keepNoise = null;
      this._keepGain = null;
    }
    return this.ctx;
  }

  _stopSpeech() {
    this._stopWebAudio();
    try {
      this.player.pause();
    } catch {
      /* ignore */
    }
  }

  _stopWebAudio() {
    if (this._webSource) {
      try {
        this._webSource.stop();
      } catch {
        /* ignore */
      }
      this._webSource = null;
    }
  }

  _ensureKeepAlive() {
    if (IS_ANDROID) {
      try {
        this._audioContext()?.resume?.();
      } catch {
        /* ignore */
      }
      return;
    }
    const ctx = this._audioContext();
    if (!ctx) return;
    try {
      ctx.resume?.();
    } catch {
      /* ignore */
    }
    if (this._keepNoise) return;
    try {
      const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.4));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i += 1) data[i] = ((i % 7) - 3) / 18000;
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 0.02;
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
      this._keepNoise = source;
      this._keepGain = gain;
    } catch {
      /* ignore */
    }
  }

  _ensurePlayer() {
    if (!this.player || this.player.tagName !== "AUDIO") {
      const next = document.createElement("audio");
      next.id = "tts-player";
      next.setAttribute("playsinline", "true");
      next.setAttribute("webkit-playsinline", "true");
      next.playsInline = true;
      next.preload = "auto";
      next.hidden = true;
      this.player = next;
    }
    if (!this.player.isConnected && document.body) document.body.appendChild(this.player);
    return this.player;
  }

  _startKeepPlayer() {
    if (IS_ANDROID) return;
    const player = this._ensurePlayer();
    if (player && !player.paused && player.currentSrc) return;
    player.loop = true;
    player.muted = false;
    player.volume = 1;
    player.src = KEEP_SRC;
    const play = player.play();
    if (play && typeof play.catch === "function") play.catch(() => {});
  }

  unlock({ fromGesture = false } = {}) {
    this._unlocked = true;
    try {
      this._audioContext()?.resume?.();
    } catch {
      /* ignore */
    }
    this._ensureKeepAlive();
    if (fromGesture) this._startKeepPlayer();
  }

  keepAlive(on) {
    if (!on) return;
    this.unlock({ fromGesture: false });
    if (!this._playing) this._startKeepPlayer();
  }

  _notifyStart() {
    this._playing = true;
    const start = this._onStart;
    this._onStart = null;
    try {
      start?.();
    } catch {
      /* ignore */
    }
  }

  _pauseForMic() {
    this._serverToken += 1;
    this._playing = false;
    this._busy = false;
    this._pending = null;
    this._stopWebAudio();
    try {
      this.player.pause();
    } catch {
      /* ignore */
    }
    this._startKeepPlayer();
  }

  speak(text, { interrupt = true, onStart } = {}) {
    const cleaned = (text || "").trim();
    if (!cleaned) return Promise.resolve();
    appState.lastSpoken = cleaned;
    if (!interrupt && this.isSpeaking()) {
      this._pending = cleaned;
      return Promise.resolve();
    }
    this._pending = null;
    this._onStart = typeof onStart === "function" ? onStart : null;
    if (!IS_IOS) {
      try {
        this.synth?.cancel();
      } catch {
        /* ignore */
      }
    }
    this.unlock();
    this._serverToken += 1;
    const token = this._serverToken;
    this._stopWebAudio();
    const previous = appState.value;
    appState.set(STATES.SPEAKING);
    this._busy = true;
    const finish = () => {
      if (token !== this._serverToken) return;
      this._playing = false;
      this._busy = false;
      this._startKeepPlayer();
      if (appState.value === STATES.SPEAKING) {
        const restore =
          previous &&
          previous !== STATES.SPEAKING &&
          previous !== STATES.IDLE &&
          previous !== STATES.PROCESSING &&
          previous !== STATES.LISTENING
            ? previous
            : STATES.IDLE;
        appState.set(restore);
      }
      const next = this._pending;
      this._pending = null;
      if (next) this.speak(next, { interrupt: false });
    };
    return this._playSpoken(cleaned, finish, token);
  }

  sayNow(text) {
    const cleaned = (text || "").trim();
    if (!cleaned) return;
    this.unlock({ fromGesture: true });
    this._kickSynth(cleaned);
  }

  _kickSynth(text) {
    if (!this.synth) {
      this._synthDone = Promise.resolve(false);
      return;
    }
    this._synthDone = new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        this.synth.cancel();
        this.synth.resume();
        const utter = new SpeechSynthesisUtterance(text);
        const settings = getSettings();
        utter.rate = Number(settings.speech_rate || 1);
        utter.lang = settings.language || "en-US";
        utter.volume = 1;
        const chosen = preferredVoice(this.voices, settings.voice_name);
        if (chosen && chosen.localService && !IS_IOS) utter.voice = chosen;
        utter.onstart = () => {
          this._playing = true;
        };
        utter.onend = () => done(true);
        utter.onerror = () => done(false);
        this._utterance = utter;
        this.synth.speak(utter);
        setTimeout(() => {
          try {
            this.synth.pause();
            this.synth.resume();
          } catch {
            /* iOS sometimes needs this kick */
          }
        }, 40);
        setTimeout(() => done(true), 20000);
      } catch {
        done(false);
      }
    });
  }

  async _playSpoken(text, finish, token) {
    const iosKick = IS_IOS && !this._usedMic;
    if (iosKick) {
      this._kickSynth(text);
      this._notifyStart();
    }
    try {
      await this._audioContext()?.resume?.();
    } catch {
      /* ignore */
    }
    this._ensureKeepAlive();
    try {
      const chunks = splitSpeakChunks(text);
      let wavHeard = false;
      for (let i = 0; i < chunks.length; i += 1) {
        if (token !== this._serverToken) return;
        if (IS_IOS && !wavHeard && i > 0) break;
        const played = await this._speakServer(chunks[i], token);
        if (token !== this._serverToken) return;
        if (played) {
          wavHeard = true;
          continue;
        }
        if (IS_IOS) {
          if (iosKick) {
            await this._synthDone;
            break;
          }
          this._kickSynth(text);
          this._notifyStart();
          await this._synthDone;
          break;
        }
        const started = await this._speakBrowserWait(chunks[i], 4000);
        if (token !== this._serverToken) return;
        if (started) {
          this._notifyStart();
          continue;
        }
        if (i === 0) return;
      }
    } catch {
      /* finish below */
    } finally {
      if (token === this._serverToken) finish();
    }
  }

  _speakBrowserWait(text, waitMs) {
    if (!this.synth) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      let started = false;
      let watch = 0;
      let cap = 0;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(watch);
        clearTimeout(cap);
        resolve(ok);
      };
      try {
        this.synth.cancel();
        this.synth.resume();
        const utter = new SpeechSynthesisUtterance(text);
        const settings = getSettings();
        utter.rate = Number(settings.speech_rate || 1);
        utter.lang = settings.language || "en-US";
        utter.volume = 1;
        const ios = /iPad|iPhone|iPod/.test(navigator.userAgent || "");
        const chosen = preferredVoice(this.voices, settings.voice_name);
        if (chosen && chosen.localService && !ios) utter.voice = chosen;
        utter.onstart = () => {
          started = true;
          this._playing = true;
        };
        utter.onend = () => done(started);
        utter.onerror = () => done(started);
        this._utterance = utter;
        this.synth.speak(utter);
        setTimeout(() => {
          try {
            this.synth.pause();
            this.synth.resume();
          } catch {
            /* iOS sometimes needs this kick */
          }
        }, 40);
      } catch {
        done(false);
        return;
      }
      watch = setTimeout(() => {
        if (!started) done(false);
      }, waitMs);
      cap = setTimeout(() => done(started), 20000);
    });
  }

  _speakBrowser(text, finish) {
    if (!this.synth) return false;
    try {
      this.synth.cancel();
      this.synth.resume();
      const utter = new SpeechSynthesisUtterance(text);
      const settings = getSettings();
      utter.rate = Number(settings.speech_rate || 1);
      utter.lang = settings.language || "en-US";
      utter.volume = 1;
      const chosen = preferredVoice(this.voices, settings.voice_name);
      if (chosen && chosen.localService) utter.voice = chosen;
      utter.onend = () => finish?.();
      utter.onerror = () => finish?.();
      this._utterance = utter;
      this.synth.speak(utter);
      return true;
    } catch {
      return false;
    }
  }

  async _speakServer(text, token) {
    if (token !== this._serverToken) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const headers = { "Content-Type": "application/json" };
      const auth = getToken();
      if (auth) headers.Authorization = `Bearer ${auth}`;
      const response = await fetch(`${getApiBase()}/api/voice/speak`, {
        method: "POST",
        headers,
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (token !== this._serverToken) return false;
      if (!response.ok) return false;
      const buffer = await response.arrayBuffer();
      if (token !== this._serverToken) return false;
      if (!buffer || buffer.byteLength < 44) return false;
      return await this._playWav(buffer, token);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  _confirmProgress(token, ms) {
    const player = this.player;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        player.removeEventListener("timeupdate", onTime);
        player.removeEventListener("playing", onTime);
        resolve(value);
      };
      const onTime = () => {
        if (token !== this._serverToken) return finish(false);
        if (player.currentTime > 0.02) finish(true);
      };
      const timer = setTimeout(() => finish(player.currentTime > 0.02), ms);
      player.addEventListener("timeupdate", onTime);
      player.addEventListener("playing", onTime);
    });
  }

  async _playWav(buffer, token) {
    if (token !== this._serverToken) return false;
    const waitMs = wavDurationMs(buffer);
    const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
    if (this._objectUrl) URL.revokeObjectURL(this._objectUrl);
    this._objectUrl = url;
    const player = this._ensurePlayer();
    const ended = new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        player.onended = null;
        player.onerror = null;
        resolve(ok);
      };
      player.onended = () => done(token === this._serverToken);
      player.onerror = () => done(false);
      setTimeout(() => done(token === this._serverToken), waitMs);
    });
    player.loop = false;
    player.muted = false;
    player.volume = 1;
    player.src = url;
    try {
      await player.play();
      this._notifyStart();
      if (IS_IOS && !this._usedMic) {
        const heard = await this._confirmProgress(token, 700);
        if (!heard) {
          try {
            player.pause();
          } catch {
            /* keep phone synth as the voice */
          }
          return false;
        }
        try {
          this.synth?.cancel();
        } catch {
          /* one voice */
        }
      }
      return ended;
    } catch {
      const web = await this._playWebAudio(buffer, token, waitMs);
      if (web) return true;
      try {
        await player.play();
        this._notifyStart();
        return ended;
      } catch {
        return false;
      }
    }
  }

  async _playWebAudio(arrayBuffer, token, waitMs = 4000) {
    const ctx = this._audioContext();
    if (!ctx) return false;
    try {
      await ctx.resume();
      this._stopWebAudio();
      let decoded;
      try {
        decoded = pcmWavToBuffer(ctx, arrayBuffer);
      } catch {
        decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
      }
      if (token !== this._serverToken) return false;
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.buffer = decoded;
      source.connect(gain);
      gain.connect(ctx.destination);
      this._webSource = source;
      const ended = new Promise((resolve) => {
        let settled = false;
        const done = (ok) => {
          if (settled) return;
          settled = true;
          resolve(ok);
        };
        source.onended = () => {
          if (this._webSource === source) this._webSource = null;
          done(token === this._serverToken);
        };
        setTimeout(() => done(token === this._serverToken), waitMs);
      });
      source.start(0);
      this._notifyStart();
      return ended;
    } catch {
      return false;
    }
  }

  stopSpeaking() {
    this._serverToken += 1;
    this._playing = false;
    this._busy = false;
    this._pending = null;
    this._stopWebAudio();
    this._startKeepPlayer();
  }

  announce(text) {
    const live = document.getElementById("live-status");
    if (live) live.textContent = text;
  }

  consumeInstantChat(text) {
    if (!this._instantChat) return false;
    const same = smallTalkReply(this._instantChat) && smallTalkReply(text);
    this._instantChat = "";
    return Boolean(same);
  }

  listeningSupported() {
    return Boolean(SpeechRecognition);
  }

  startHoldListen({ language } = {}) {
    if (!window.isSecureContext) {
      return Promise.reject(
        Object.assign(new Error("iPhone blocks the microphone on http. Open the https Safari address."), {
          code: "INSECURE_CONTEXT",
        })
      );
    }
    if (!this.listeningSupported()) {
      return Promise.reject(
        Object.assign(new Error("Speech recognition is not available in this browser."), { code: "SPEECH_UNAVAILABLE" })
      );
    }
    this._pauseForMic();
    this.stopListening();
    this._usedMic = true;
    const settings = getSettings();
    this._holdText = "";
    this._holding = true;
    return new Promise((resolve, reject) => {
      const rec = new SpeechRecognition();
      this.recognition = rec;
      rec.lang = language || settings.language || "en-US";
      rec.continuous = true;
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let spoken = "";
        for (let i = 0; i < event.results.length; i += 1) {
          spoken += `${event.results[i][0].transcript} `;
        }
        this._holdText = spoken.trim();
        this.announce(this._holdText || "Listening.");
      };
      rec.onerror = (event) => {
        if (event.error === "aborted" || event.error === "no-speech") return;
        const code = event.error === "not-allowed" ? "MIC_UNAVAILABLE" : "SPEECH_UNAVAILABLE";
        this._holding = false;
        reject(Object.assign(new Error(event.error), { code }));
      };
      rec.onend = () => {
        if (this._holding && this.recognition === rec) {
          try {
            rec.start();
          } catch {
            /* session ended */
          }
        }
      };
      try {
        rec.start();
        appState.set(STATES.LISTENING);
        this.announce("Listening.");
        resolve();
      } catch (error) {
        this._holding = false;
        reject(Object.assign(error, { code: "MIC_UNAVAILABLE" }));
      }
    });
  }

  finishHoldListen() {
    this._holding = false;
    const text = (this._holdText || "").trim();
    this.stopListening();
    try {
      this.synth?.cancel();
    } catch {
      /* release the speaker after the microphone */
    }
    try {
      this._audioContext()?.resume?.();
    } catch {
      /* ignore */
    }
    this._startKeepPlayer();
    if (appState.value === STATES.LISTENING) appState.set(STATES.IDLE);
    return text;
  }

  listen({ language } = {}) {
    if (!window.isSecureContext) {
      return Promise.reject(
        Object.assign(new Error("iPhone blocks the microphone on http. Open the https Safari address."), {
          code: "INSECURE_CONTEXT",
        })
      );
    }
    if (!this.listeningSupported()) {
      return Promise.reject(Object.assign(new Error("Speech recognition is not available in this browser."), { code: "SPEECH_UNAVAILABLE" }));
    }
    this._pauseForMic();
    this.stopListening();
    this._usedMic = true;
    const settings = getSettings();
    return new Promise((resolve, reject) => {
      const rec = new SpeechRecognition();
      this.recognition = rec;
      let finalText = "";
      let settled = false;
      const finish = (text, error) => {
        if (settled) return;
        settled = true;
        if (this.recognition === rec) this.recognition = null;
        clearTimeout(watch);
        if (error) reject(error);
        else resolve(text);
      };
      rec.lang = language || settings.language || "en-US";
      rec.interimResults = true;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        const result = event.results[event.results.length - 1];
        const transcript = (result?.[0]?.transcript || "").trim();
        if (!transcript) return;
        this.announce(transcript);
        if (smallTalkReply(transcript) || result.isFinal) {
          finalText = transcript;
          try {
            rec.stop();
          } catch {
            /* ignore */
          }
        }
      };
      rec.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") {
          try {
            rec.stop();
          } catch {
            /* ignore */
          }
          return;
        }
        const code = event.error === "not-allowed" ? "MIC_UNAVAILABLE" : "SPEECH_UNAVAILABLE";
        finish("", Object.assign(new Error(event.error), { code }));
      };
      rec.onend = () => {
        this._audioContext()?.resume?.();
        this._startKeepPlayer();
        finish(finalText);
      };
      const watch = setTimeout(() => {
        try {
          rec.stop();
        } catch {
          /* ignore */
        }
      }, 8000);
      try {
        rec.start();
        appState.set(STATES.LISTENING);
        this.announce("Listening.");
      } catch (error) {
        finish("", Object.assign(error, { code: "MIC_UNAVAILABLE" }));
      }
    });
  }

  stopListening() {
    if (this.recognition) {
      const rec = this.recognition;
      this.recognition = null;
      try {
        rec.stop();
      } catch {
        try {
          rec.abort();
        } catch {
          /* already stopped */
        }
      }
    }
  }
}

export const voice = new VoiceService();
