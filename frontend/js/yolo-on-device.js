const CACHE_NAME = "aisight-yolo-v1";
const MODEL_KEY = "/aisight-yolo/yolov8n.onnx";
const READY_KEY = "aisight-yolo-ready";
const MODEL_URLS = [
  new URL("../models/yolov8n.onnx", import.meta.url).href,
  "https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx",
];

const COUNT_WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
const IRREGULAR = { person: "people", man: "men", woman: "women", child: "children" };

let worker = null;
let workerReady = false;
let workerFailed = false;
let inputSize = 640;
let letterCanvas = null;
let tensorData = null;
let inferBusy = false;
let installPromise = null;
let requestId = 0;
const pending = new Map();
const progressHandlers = new Set();

function emitProgress(payload) {
  progressHandlers.forEach((fn) => {
    try {
      fn(payload);
    } catch {
      /* ignore */
    }
  });
}

export function onYoloProgress(fn) {
  progressHandlers.add(fn);
  return () => progressHandlers.delete(fn);
}

export function isYoloInstalled() {
  return localStorage.getItem(READY_KEY) === "1";
}

export async function isYoloReady() {
  if (workerFailed) return false;
  if (workerReady) return true;
  return false;
}

export function yoloStatus() {
  if (workerReady) return { state: "ready", label: "On this phone. Object detection can run without the server." };
  if (installPromise) return { state: "downloading", label: "Downloading object detection to this phone…" };
  if (isYoloInstalled()) return { state: "cached", label: "Downloaded. It will load the first time you detect." };
  return { state: "missing", label: "Not on this phone yet. Download once, then detection works in real time." };
}

async function readProgress(response, onProgress) {
  const total = Number(response.headers.get("Content-Length") || 0);
  if (!response.body || !response.body.getReader) {
    const blob = await response.blob();
    onProgress?.({ loaded: blob.size, total: blob.size, pct: 100 });
    return blob;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const pct = total ? Math.min(99, Math.round((loaded / total) * 100)) : Math.min(99, Math.round(loaded / 80000));
    onProgress?.({ loaded, total, pct });
    emitProgress({ state: "downloading", pct, loaded, total });
  }
  onProgress?.({ loaded, total: total || loaded, pct: 100 });
  return new Blob(chunks);
}

export async function installYolo({ onProgress } = {}) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(MODEL_KEY);
  if (cached && cached.ok) {
    localStorage.setItem(READY_KEY, "1");
    emitProgress({ state: "ready", pct: 100 });
    return true;
  }
  if (installPromise) return installPromise;
  installPromise = (async () => {
    emitProgress({ state: "downloading", pct: 0 });
    let lastError = null;
    for (const url of MODEL_URLS) {
      try {
        const response = await fetch(url, { mode: "cors" });
        if (!response.ok) continue;
        const blob = await readProgress(response, onProgress);
        if (!blob || blob.size < 800000) continue;
        await cache.put(
          MODEL_KEY,
          new Response(blob, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(blob.size) } })
        );
        localStorage.setItem(READY_KEY, "1");
        emitProgress({ state: "ready", pct: 100 });
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("I could not download object detection to this phone. Check the internet and try again.");
  })().finally(() => {
    installPromise = null;
  });
  return installPromise;
}

export async function removeYolo() {
  workerReady = false;
  workerFailed = false;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  localStorage.removeItem(READY_KEY);
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
  emitProgress({ state: "missing", pct: 0 });
}

function onWorkerMessage(event) {
  const msg = event.data || {};
  if (msg.type === "ready") {
    workerReady = true;
    workerFailed = false;
    inputSize = msg.inputSize || 640;
    emitProgress({ state: "ready", pct: 100 });
    return;
  }
  if (msg.type === "error") {
    const wait = pending.get(msg.id);
    if (wait) {
      pending.delete(msg.id);
      wait.reject(new Error(msg.message || "Object detection failed."));
      return;
    }
    workerFailed = true;
    emitProgress({ state: "missing", pct: 0 });
    return;
  }
  if (msg.type === "detections") {
    const wait = pending.get(msg.id);
    if (!wait) return;
    pending.delete(msg.id);
    wait.resolve(msg);
  }
}

function startWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./yolo-worker.js", import.meta.url));
  worker.onmessage = onWorkerMessage;
  worker.onerror = () => {
    workerFailed = true;
    emitProgress({ state: "missing", pct: 0 });
  };
  return worker;
}

export async function ensureWorker() {
  if (workerFailed) throw new Error("Object detection could not start on this device.");
  if (workerReady) return true;
  emitProgress({ state: "loading", pct: 50 });
  startWorker();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      workerFailed = true;
      reject(new Error("Object detection is taking too long to start."));
    }, 45000);
    const finish = (ok, error) => {
      clearTimeout(timeout);
      worker.onmessage = onWorkerMessage;
      if (ok) resolve(true);
      else reject(error || new Error("Object detection could not start on this device."));
    };
    worker.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === "ready") {
        workerReady = true;
        workerFailed = false;
        inputSize = msg.inputSize || 640;
        emitProgress({ state: "ready", pct: 100 });
        finish(true);
        return;
      }
      if (msg.type === "error" && msg.id == null) {
        workerFailed = true;
        finish(false, new Error(msg.message || "Object detection could not start on this device."));
        return;
      }
      onWorkerMessage(event);
    };
    worker.postMessage({ type: "init" });
  });
}

function letterbox(video, size) {
  if (!letterCanvas) letterCanvas = document.createElement("canvas");
  if (letterCanvas.width !== size) letterCanvas.width = size;
  if (letterCanvas.height !== size) letterCanvas.height = size;
  const ctx = letterCanvas.getContext("2d", { willReadFrequently: true });
  const vw = video.videoWidth || 1;
  const vh = video.videoHeight || 1;
  const scale = Math.min(size / vw, size / vh);
  const nw = vw * scale;
  const nh = vh * scale;
  const dx = (size - nw) / 2;
  const dy = (size - nh) / 2;
  ctx.fillStyle = "#727272";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(video, 0, 0, vw, vh, dx, dy, nw, nh);
  const pixels = ctx.getImageData(0, 0, size, size).data;
  const plane = size * size;
  if (!tensorData || tensorData.length !== 3 * plane) tensorData = new Float32Array(3 * plane);
  const data = tensorData;
  for (let i = 0; i < plane; i += 1) {
    const p = i * 4;
    data[i] = pixels[p] / 255;
    data[plane + i] = pixels[p + 1] / 255;
    data[plane * 2 + i] = pixels[p + 2] / 255;
  }
  return { data, scale, dx, dy, vw, vh, size };
}

function indefinite(label) {
  const name = String(label || "object").replace(/_/g, " ").trim();
  const article = "aeiou".includes(name.slice(0, 1).toLowerCase()) ? "an" : "a";
  return `${article} ${name}`;
}

function countPhrase(label, count) {
  const name = String(label || "object").replace(/_/g, " ").trim();
  if (count === 1) return indefinite(name);
  const number = COUNT_WORDS[count] || String(count);
  const plural = IRREGULAR[name] || `${name}s`;
  return `${number} ${plural}`;
}

function joinEnglish(parts) {
  if (!parts.length) return "";
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

export function speakDetections(detections, queryObject) {
  const items = (detections || []).filter((item) => (item.confidence || 0) >= 0.4);
  if (queryObject) {
    const target = String(queryObject).trim().toLowerCase();
    const matches = items.filter((item) => String(item.label || "").toLowerCase().includes(target));
    if (!matches.length) return `I do not see ${target}.`;
    return `You see ${countPhrase(matches[0].label || target, matches.length)}.`;
  }
  if (!items.length) return "I do not see any objects I recognize.";
  const grouped = {};
  items.forEach((item) => {
    const label = String(item.label || "object");
    grouped[label] = (grouped[label] || 0) + 1;
  });
  const ranked = Object.entries(grouped)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([label, count]) => countPhrase(label, count));
  return `You see ${joinEnglish(ranked)}.`;
}

export async function detectVideo(video, { objectName, confidence = 0.35 } = {}) {
  if (!video || !video.videoWidth) {
    return { detections: [], spoken: "The camera is not ready yet.", sourceSize: null, onDevice: true };
  }
  if (inferBusy) {
    return { detections: [], spoken: "", sourceSize: { width: video.videoWidth, height: video.videoHeight }, onDevice: true, busy: true };
  }
  inferBusy = true;
  try {
    await ensureWorker();
    const prep = letterbox(video, inputSize);
    const id = (requestId += 1);
    const result = await new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({
        type: "infer",
        id,
        data: prep.data.slice().buffer,
        size: prep.size,
        scale: prep.scale,
        dx: prep.dx,
        dy: prep.dy,
        vw: prep.vw,
        vh: prep.vh,
        confidence,
      });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("Object detection timed out."));
        }
      }, 8000);
    });
    let detections = result.detections || [];
    if (objectName) {
      const target = String(objectName).trim().toLowerCase();
      detections = detections.filter((item) => String(item.label || "").toLowerCase().includes(target));
    }
    return {
      detections,
      spoken: speakDetections(detections, objectName),
      sourceSize: { width: prep.vw, height: prep.vh },
      onDevice: true,
    };
  } finally {
    inferBusy = false;
  }
}
