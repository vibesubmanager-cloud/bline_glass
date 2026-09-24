/** Loud describe/read playback only. Does not change object-detection voice. */

import { getApiBase, getToken } from "./config.js";

function quietWavUrl() {
  const sampleRate = 22050;
  const samples = Math.floor(sampleRate * 0.4);
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
  const pcm = new Int16Array(bytes, 44);
  for (let i = 0; i < samples; i += 1) pcm[i] = i % 80 === 0 ? 18 : 0;
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}

const KEEP_SRC = quietWavUrl();
let keepEl = null;
let playEl = null;
let objectUrl = "";
let speakToken = 0;

function makeAudio(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("audio");
    el.id = id;
    el.hidden = true;
    document.body?.appendChild(el);
  }
  el.setAttribute("playsinline", "true");
  el.setAttribute("webkit-playsinline", "true");
  el.playsInline = true;
  el.preload = "auto";
  el.muted = false;
  return el;
}

function ensureEls() {
  if (!document.body) return { keep: null, play: null };
  keepEl = makeAudio("vision-keep");
  playEl = makeAudio("vision-tts");
  return { keep: keepEl, play: playEl };
}

async function routeToMediaSpeaker(el) {
  if (!el?.setSinkId || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((item) => item.kind === "audiooutput");
    const skip = /earpiece|receiver|telephony|communication/i;
    const bluetooth = outs.find((item) => /bluetooth|airpod|headset|headphone/i.test(item.label) && !skip.test(item.label));
    const speaker = outs.find((item) => /speaker|loud/i.test(item.label) && !skip.test(item.label));
    const id = bluetooth?.deviceId || speaker?.deviceId;
    if (id) await el.setSinkId(id);
  } catch {
    /* iPhone does not support setSinkId; HTML audio still uses the media speaker / Bluetooth. */
  }
}

export function armVisionSpeaker() {
  const { keep, play } = ensureEls();
  if (!keep || !play) return;
  keep.loop = true;
  keep.muted = false;
  keep.volume = 0.05;
  if (!keep.currentSrc) keep.src = KEEP_SRC;
  play.muted = false;
  play.volume = 1;
  routeToMediaSpeaker(keep);
  routeToMediaSpeaker(play);
  keep.play()?.catch(() => undefined);
}

function splitChunks(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= 220) return [cleaned];
  const chunks = [];
  let buf = "";
  cleaned.split(" ").forEach((word) => {
    const next = buf ? `${buf} ${word}` : word;
    if (next.length > 220 && buf) {
      chunks.push(buf);
      buf = word;
    } else {
      buf = next;
    }
  });
  if (buf) chunks.push(buf);
  return chunks;
}

async function fetchTts(text) {
  const headers = { "Content-Type": "application/json" };
  const auth = getToken();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${getApiBase()}/api/voice/speak`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (!buffer || buffer.byteLength < 44) return null;
    const type = (response.headers.get("content-type") || "").includes("mpeg") ? "audio/mpeg" : "audio/wav";
    return new Blob([buffer], { type });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function playBlob(el, blob) {
  return new Promise((resolve) => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      el.onended = null;
      el.onerror = null;
      resolve(ok);
    };
    el.loop = false;
    el.muted = false;
    el.volume = 1;
    el.onended = () => done(true);
    el.onerror = () => done(false);
    el.src = objectUrl;
    const start = el.play();
    if (start && typeof start.then === "function") {
      start.then(() => {
        const ms = Math.min(25000, Math.max(1200, (el.duration || 8) * 1000 + 400));
        setTimeout(() => done(!el.paused || el.ended), ms);
      }).catch(() => done(false));
    } else {
      setTimeout(() => done(false), 400);
    }
  });
}

export async function speakVision(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return;
  armVisionSpeaker();
  const my = (speakToken += 1);
  const { keep, play } = ensureEls();
  if (!play) return;
  await routeToMediaSpeaker(play);
  const chunks = splitChunks(cleaned);
  for (const chunk of chunks) {
    if (my !== speakToken) return;
    const blob = await fetchTts(chunk);
    if (my !== speakToken) return;
    if (!blob) continue;
    keep?.pause?.();
    const ok = await playBlob(play, blob);
    if (my !== speakToken) return;
    if (!ok) {
      armVisionSpeaker();
      await playBlob(play, blob);
    }
  }
  if (my === speakToken) armVisionSpeaker();
}
