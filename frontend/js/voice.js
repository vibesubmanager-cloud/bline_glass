import { getApiBase, getSettings, getToken } from "./config.js";
import { smallTalkReply } from "./intent.js?v=38";
import { appState, STATES } from "./state.js";

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "");
const IS_ANDROID = /Android/i.test(navigator.userAgent || "");

function voiceLog(event, extra) {
  try {
    if (extra !== undefined) console.log(`[VOICE] ${event}`, extra);
    else console.log(`[VOICE] ${event}`);
  } catch {
    /* ignore */
  }
}

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

function audioDurationMs(arrayBuffer) {
  try {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      return 20000;
    }
    if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
      return 20000;
    }
    const view = new DataView(arrayBuffer);
    const byteRate = view.getUint32(28, true) || 44100;
    const dataSize = view.getUint32(40, true) || Math.max(0, arrayBuffer.byteLength - 44);
    return Math.min(20000, Math.max(800, Math.ceil((dataSize / byteRate) * 1000) + 350));
  } catch {
    return 8000;
  }
}

function audioMime(arrayBuffer, headerType) {
  if (headerType && headerType.includes("mpeg")) return "audio/mpeg";
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return "audio/wav";
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
    this.keepEl = null;
    this.ctx = null;
    this._utterance = null;
    this._playing = false;
    this._unlocked = false;
    this._serverToken = 0;
    this._objectUrl = "";
    this._pending = null;
    this._pendingPriority = 0;
    this._webSource = null;
    this._webGain = null;
    this._instantChat = "";
    this._usedMic = false;
    this._keepNoise = null;
    this._keepGain = null;
    this._busy = false;
    this._onStart = null;
    this._synthDone = Promise.resolve(false);
    this._priority = 0;
    this._gestureAt = 0;
    this._boundCtx = null;
    if (this.synth) {
      this.synth.addEventListener("voiceschanged", () => {
        this.voices = this.synth.getVoices();
      });
      this.voices = this.synth.getVoices();
    }
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) this.restoreSpeaker();
    });
    document.addEventListener(
      "pointerdown",
      () => {
        this.unlock({ fromGesture: true });
      },
      { capture: true }
    );
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
      this._bindContext(this.ctx);
    }
    return this.ctx;
  }

  _bindContext(ctx) {
    if (this._boundCtx === ctx) return;
    this._boundCtx = ctx;
    ctx.onstatechange = () => {
      voiceLog("AUDIO CONTEXT", ctx.state);
      if (ctx.state === "interrupted" || ctx.state === "suspended") {
        this._keepNoise = null;
      }
      if (ctx.state === "running") this._ensureKeepAlive();
    };
  }

  _cancelBrowserTts() {
    try {
      this.synth?.cancel();
    } catch {
      /* ignore */
    }
    this._utterance = null;
    this._synthDone = Promise.resolve(false);
  }

  _stopHtmlPlayer() {
    const player = this.player;
    if (!player) return;
    try {
      player.onended = null;
      player.onerror = null;
      player.pause();
      player.removeAttribute("src");
      player.load?.();
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
    this._webGain = null;
  }

  _stopSpeech() {
    this._stopWebAudio();
    this._stopHtmlPlayer();
    this._cancelBrowserTts();
  }

  _ensureKeepAlive() {
    const ctx = this._audioContext();
    if (!ctx) return;
    try {
      ctx.resume?.();
    } catch {
      /* ignore */
    }
    if (this._keepNoise) return;
    try {
      const frames = Math.max(1, Math.floor(ctx.sampleRate * 0.25));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 0;
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

  _ensureKeepEl() {
    if (this.keepEl && this.keepEl.tagName === "AUDIO") {
      if (!this.keepEl.isConnected && document.body) document.body.appendChild(this.keepEl);
      return this.keepEl;
    }
    const el = document.createElement("audio");
    el.id = "tts-keep";
    el.setAttribute("playsinline", "true");
    el.setAttribute("webkit-playsinline", "true");
    el.playsInline = true;
    el.preload = "auto";
    el.hidden = true;
    el.loop = true;
    this.keepEl = el;
    if (document.body) document.body.appendChild(el);
    return el;
  }

  _startKeepPlayer() {
    this._ensureKeepAlive();
    if (IS_IOS || IS_ANDROID) return;
    const keep = this._ensureKeepEl();
    if (keep && !keep.paused && keep.currentSrc) return;
    keep.loop = true;
    keep.muted = true;
    keep.volume = 0;
    keep.src = KEEP_SRC;
    const play = keep.play();
    if (play && typeof play.catch === "function") play.catch(() => {});
  }

  restoreSpeaker() {
    this._unlocked = true;
    const ctx = this._audioContext();
    try {
      ctx?.resume?.();
    } catch {
      /* ignore */
    }
    this._keepNoise = null;
    this._ensureKeepAlive();
    this._startKeepPlayer();
    voiceLog("VOICE RECOVERED", ctx?.state || "no-ctx");
  }

  unlock({ fromGesture = false } = {}) {
    this._unlocked = true;
    if (fromGesture) this._gestureAt = performance.now();
    const ctx = this._audioContext();
    try {
      ctx?.resume?.();
    } catch {
      /* ignore */
    }
    if (fromGesture || ctx?.state !== "running") this._keepNoise = null;
    this._ensureKeepAlive();
    if (fromGesture) this._startKeepPlayer();
  }

  keepAlive(on) {
    if (!on) return;
    this.restoreSpeaker();
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
    voiceLog("MIC START");
    this._serverToken += 1;
    this._playing = false;
    this._busy = false;
    this._pending = null;
    this._stopSpeech();
    this._usedMic = true;
  }

  speak(text, { interrupt = true, onStart, priority = 1 } = {}) {
    const cleaned = (text || "").trim();
    if (!cleaned) return Promise.resolve();
    appState.lastSpoken = cleaned;
    const inGesture = performance.now() - this._gestureAt < 500;
    if (!interrupt && this.isSpeaking()) {
      this._pending = cleaned;
      this._pendingPriority = priority;
      voiceLog("VOICE PENDING", cleaned.slice(0, 80));
      return Promise.resolve();
    }
    if (interrupt && this.isSpeaking() && this._priority > priority) {
      this._pending = cleaned;
      this._pendingPriority = priority;
      voiceLog("VOICE DEFERRED", { priority, current: this._priority });
      return Promise.resolve();
    }
    this._pending = null;
    this._onStart = typeof onStart === "function" ? onStart : null;
    this._priority = priority;
    this._stopSpeech();
    this.unlock({ fromGesture: false });
    this._serverToken += 1;
    const token = this._serverToken;
    voiceLog("VOICE REQUEST", cleaned.slice(0, 120));
    voiceLog("VOICE TOKEN", token);
    const previous = appState.value;
    appState.set(STATES.SPEAKING);
    this._busy = true;
    const finish = () => {
      if (token !== this._serverToken) {
        voiceLog("VOICE CANCELLED", token);
        return;
      }
      this._playing = false;
      this._busy = false;
      this._priority = 0;
      this._startKeepPlayer();
      voiceLog("VOICE FINISHED", token);
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
      const nextPriority = this._pendingPriority || 1;
      this._pending = null;
      if (next) this.speak(next, { interrupt: false, priority: nextPriority });
    };
    return this._playSpoken(cleaned, finish, token, inGesture);
  }

  sayNow(text) {
    return this.speak(text, { interrupt: true, priority: 1 });
  }

  _kickSynth(text, token) {
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
          if (token !== this._serverToken) return;
          voiceLog("BROWSER TTS START");
          this._playing = true;
        };
        utter.onend = () => done(true);
        utter.onerror = (event) => {
          voiceLog("BROWSER TTS ERROR", event?.error || "error");
          done(false);
        };
        this._utterance = utter;
        this.synth.speak(utter);
      } catch (error) {
        voiceLog("BROWSER TTS ERROR", error?.message || "throw");
        done(false);
      }
    });
  }

  async _playSpoken(text, finish, token, inGesture) {
    const canKick = IS_IOS && inGesture;
    if (canKick) {
      this._kickSynth(text, token);
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
      let heard = false;
      for (let i = 0; i < chunks.length; i += 1) {
        if (token !== this._serverToken) return;
        if (IS_IOS && heard && i > 0) break;
        const played = await this._speakServer(chunks[i], token);
        if (token !== this._serverToken) return;
        if (played) {
          heard = true;
          if (canKick) this._cancelBrowserTts();
          continue;
        }
        if (IS_IOS) {
          if (canKick) {
            await this._synthDone;
            break;
          }
          voiceLog("BROWSER TTS START");
          this._kickSynth(text, token);
          this._notifyStart();
          await this._synthDone;
          break;
        }
        const started = await this._speakBrowserWait(chunks[i], token, 4000);
        if (token !== this._serverToken) return;
        if (started) {
          this._notifyStart();
          continue;
        }
        if (i === 0) {
          voiceLog("AUDIO PLAY ERROR", "all playback paths failed");
          this.restoreSpeaker();
          return;
        }
      }
    } catch (error) {
      voiceLog("AUDIO PLAY ERROR", error?.message || "throw");
      this.restoreSpeaker();
    } finally {
      if (token === this._serverToken) finish();
    }
  }

  _speakBrowserWait(text, token, waitMs) {
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
        const chosen = preferredVoice(this.voices, settings.voice_name);
        if (chosen && chosen.localService && !IS_IOS) utter.voice = chosen;
        utter.onstart = () => {
          if (token !== this._serverToken) return done(false);
          started = true;
          voiceLog("BROWSER TTS START");
          this._playing = true;
        };
        utter.onend = () => done(started);
        utter.onerror = (event) => {
          voiceLog("BROWSER TTS ERROR", event?.error || "error");
          done(started);
        };
        this._utterance = utter;
        this.synth.speak(utter);
      } catch (error) {
        voiceLog("BROWSER TTS ERROR", error?.message || "throw");
        done(false);
        return;
      }
      watch = setTimeout(() => {
        if (!started) done(false);
      }, waitMs);
      cap = setTimeout(() => done(started), 20000);
    });
  }

  async _speakServer(text, token) {
    if (token !== this._serverToken) return false;
    voiceLog("SERVER TTS REQUEST");
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
      if (token !== this._serverToken) {
        voiceLog("VOICE CANCELLED", "stale server response");
        return false;
      }
      if (!response.ok) {
        voiceLog("SERVER TTS ERROR", response.status);
        return false;
      }
      const buffer = await response.arrayBuffer();
      if (token !== this._serverToken) return false;
      if (!buffer || buffer.byteLength < 44) {
        voiceLog("SERVER TTS ERROR", "empty audio");
        return false;
      }
      voiceLog("SERVER TTS SUCCESS", buffer.byteLength);
      const mime = audioMime(buffer, response.headers.get("content-type") || "");
      return await this._playWav(buffer, token, mime);
    } catch (error) {
      voiceLog("SERVER TTS ERROR", error?.message || "throw");
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async _playWav(buffer, token, mime = "audio/wav") {
    if (token !== this._serverToken) return false;
    let waitMs = audioDurationMs(buffer);
    try {
      await this._audioContext()?.resume?.();
    } catch {
      /* ignore */
    }
    this._ensureKeepAlive();
    const web = await this._playWebAudio(buffer, token, waitMs);
    if (web) return true;
    const url = URL.createObjectURL(new Blob([buffer], { type: mime || "audio/wav" }));
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
      player.onerror = () => {
        voiceLog("AUDIO PLAY ERROR", "html error");
        done(false);
      };
      setTimeout(() => done(token === this._serverToken && !player.paused), waitMs);
    });
    player.loop = false;
    player.muted = false;
    player.volume = 1;
    player.src = url;
    try {
      await player.play();
      if (token !== this._serverToken) return false;
      voiceLog("AUDIO PLAY START", "html");
      this._notifyStart();
      this._cancelBrowserTts();
      return ended;
    } catch (error) {
      voiceLog("AUDIO PLAY ERROR", error?.message || "html play");
      this.restoreSpeaker();
      const webRetry = await this._playWebAudio(buffer, token, waitMs);
      if (webRetry) return true;
      try {
        await player.play();
        if (token !== this._serverToken) return false;
        voiceLog("AUDIO PLAY START", "html-retry");
        this._notifyStart();
        return ended;
      } catch (retryError) {
        voiceLog("AUDIO PLAY ERROR", retryError?.message || "html retry");
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
        const copy = arrayBuffer.slice(0);
        decoded = await ctx.decodeAudioData(copy);
      }
      if (token !== this._serverToken) return false;
      const durationMs = decoded.duration ? Math.min(20000, decoded.duration * 1000 + 250) : waitMs;
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 1;
      source.buffer = decoded;
      source.connect(gain);
      gain.connect(ctx.destination);
      this._webSource = source;
      this._webGain = gain;
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
        setTimeout(() => done(token === this._serverToken), durationMs);
      });
      source.start(0);
      voiceLog("AUDIO PLAY START", "webaudio");
      this._notifyStart();
      this._cancelBrowserTts();
      return ended;
    } catch (error) {
      voiceLog("AUDIO PLAY ERROR", error?.message || "webaudio");
      return false;
    }
  }

  stopSpeaking() {
    voiceLog("VOICE CANCELLED", "stopSpeaking");
    this._serverToken += 1;
    this._playing = false;
    this._busy = false;
    this._pending = null;
    this._priority = 0;
    this._stopSpeech();
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
    voiceLog("MIC STOP");
    this.unlock({ fromGesture: true });
    this.restoreSpeaker();
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
        voiceLog("MIC STOP");
        this.restoreSpeaker();
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
