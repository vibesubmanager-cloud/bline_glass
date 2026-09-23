const READY_KEY = "aisight-yolo-ready";
const TF_SRC = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js";
const COCO_SRC = "https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js";

const COUNT_WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
const IRREGULAR = { person: "people", man: "men", woman: "women", child: "children" };

let model = null;
let loading = null;
let frameCanvas = null;
let wakeLock = null;
let progressHandlers = new Set();

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
  return localStorage.getItem(READY_KEY) === "1" || Boolean(model);
}

export async function isYoloReady() {
  return Boolean(model);
}

export function yoloStatus() {
  if (model) return { state: "ready", label: "On this phone. Object detection can run without the server." };
  if (loading) return { state: "downloading", label: "Downloading object detection to this phone…" };
  if (isYoloInstalled()) return { state: "cached", label: "Downloaded. It will load the first time you detect." };
  return { state: "missing", label: "Not on this phone yet. Download once, then detection works in real time." };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = [...document.getElementsByTagName("script")].find((node) => node.src === src);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("I could not load object detection on this phone."));
    document.head.appendChild(script);
  });
}

async function pickBackend(tf) {
  const order = ["webgl", "cpu"];
  for (const name of order) {
    try {
      if (tf.findBackend && !tf.findBackend(name) && name === "webgl") {
        /* register if needed */
      }
      const ok = await tf.setBackend(name);
      if (!ok) continue;
      await tf.ready();
      if (tf.getBackend() === name) return name;
    } catch {
      /* try next */
    }
  }
  await tf.ready();
  return tf.getBackend();
}

async function loadModel() {
  if (model) return model;
  if (loading) return loading;
  loading = (async () => {
    emitProgress({ state: "loading", pct: 20 });
    await loadScript(TF_SRC);
    const tf = window.tf;
    if (!tf) throw new Error("Object detection could not start on this device.");
    await pickBackend(tf);
    emitProgress({ state: "loading", pct: 60 });
    await loadScript(COCO_SRC);
    if (!window.cocoSsd) throw new Error("Object detection could not start on this device.");
    emitProgress({ state: "loading", pct: 80 });
    model = await window.cocoSsd.load({ base: "lite_mobilenet_v2" });
    localStorage.setItem(READY_KEY, "1");
    emitProgress({ state: "ready", pct: 100 });
    return model;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export async function installYolo() {
  await loadModel();
  return true;
}

export async function ensureWorker() {
  await loadModel();
  return true;
}

export async function recoverDetector() {
  try {
    model?.dispose?.();
  } catch {
    /* ignore */
  }
  model = null;
  loading = null;
}

export async function removeYolo() {
  await recoverDetector();
  localStorage.removeItem(READY_KEY);
  emitProgress({ state: "missing", pct: 0 });
}

export async function holdDetectionAwake() {
  try {
    if (navigator.wakeLock?.request) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener?.("release", () => {
        if (document.visibilityState === "visible") holdDetectionAwake().catch(() => undefined);
      });
    }
  } catch {
    /* some browsers block wake lock */
  }
}

export function releaseDetectionAwake() {
  try {
    wakeLock?.release?.();
  } catch {
    /* ignore */
  }
  wakeLock = null;
}

function relativePosition(cx, cy, width, height) {
  if (width <= 0 || height <= 0) return "center";
  const horiz = cx < width * 0.33 ? "left" : cx > width * 0.67 ? "right" : "center";
  const vert = cy < height * 0.33 ? "top" : cy > height * 0.67 ? "bottom" : "middle";
  if (horiz === "center" && vert === "middle") return "center";
  if (horiz === "center") return `${vert} center`;
  if (vert === "middle") return horiz;
  return `${vert} ${horiz}`;
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

function grabFrame(video) {
  const maxW = 320;
  const scale = Math.min(1, maxW / (video.videoWidth || maxW));
  const width = Math.max(1, Math.round((video.videoWidth || maxW) * scale));
  const height = Math.max(1, Math.round((video.videoHeight || maxW) * scale));
  if (!frameCanvas) frameCanvas = document.createElement("canvas");
  if (frameCanvas.width !== width) frameCanvas.width = width;
  if (frameCanvas.height !== height) frameCanvas.height = height;
  const ctx = frameCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);
  return { canvas: frameCanvas, mapX: (video.videoWidth || width) / width, mapY: (video.videoHeight || height) / height };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("DETECT_TIMEOUT")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function detectVideo(video, { objectName, confidence = 0.32 } = {}) {
  if (!video || !video.videoWidth) {
    return { detections: [], spoken: "The camera is not ready yet.", sourceSize: null, onDevice: true };
  }
  const net = await loadModel();
  const frame = grabFrame(video);
  const preds = await withTimeout(net.detect(frame.canvas, 12, confidence), 2500);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  let detections = (preds || []).map((item) => {
    const [x, y, w, h] = item.bbox || [0, 0, 0, 0];
    const x1 = x * frame.mapX;
    const y1 = y * frame.mapY;
    const x2 = (x + w) * frame.mapX;
    const y2 = (y + h) * frame.mapY;
    return {
      label: item.class || "object",
      confidence: Math.round((item.score || 0) * 1000) / 1000,
      bbox: [x1, y1, x2, y2],
      position: relativePosition((x1 + x2) / 2, (y1 + y2) / 2, vw, vh),
    };
  });
  if (objectName) {
    const target = String(objectName).trim().toLowerCase();
    detections = detections.filter((item) => String(item.label || "").toLowerCase().includes(target));
  }
  return {
    detections,
    spoken: speakDetections(detections, objectName),
    sourceSize: { width: vw, height: vh },
    onDevice: true,
  };
}
