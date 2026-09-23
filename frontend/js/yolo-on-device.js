const CACHE_NAME = "aisight-yolo-v1";
const MODEL_KEY = "/aisight-yolo/yolov8n.onnx";
const READY_KEY = "aisight-yolo-ready";
const ORT_SRC = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js";
const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";

const MODEL_URLS = [
  new URL("../models/yolov8n.onnx", import.meta.url).href,
  "https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx",
  "https://huggingface.co/onnx-community/yolov8n/resolve/main/onnx/model.onnx",
];

const COCO = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat",
  "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack",
  "umbrella", "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball",
  "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket",
  "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair",
  "couch", "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse",
  "remote", "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator",
  "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
];

const COUNT_WORDS = { 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };
const IRREGULAR = { person: "people", man: "men", woman: "women", child: "children" };

let session = null;
let inputName = "images";
let outputName = "output0";
let inputSize = 640;
let letterCanvas = null;
let installPromise = null;
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
  return localStorage.getItem(READY_KEY) === "1";
}

export async function isYoloReady() {
  if (session) return true;
  if (!isYoloInstalled()) return false;
  try {
    await getSession();
    return Boolean(session);
  } catch {
    return false;
  }
}

export function yoloStatus() {
  if (session) return { state: "ready", label: "On this phone. Object detection can run without the server." };
  if (installPromise) return { state: "downloading", label: "Downloading object detection to this phone…" };
  if (isYoloInstalled()) return { state: "cached", label: "Downloaded. It will load the first time you detect." };
  return { state: "missing", label: "Not on this phone yet. Download once, then detection works in real time." };
}

async function loadOrt() {
  if (window.ort) return window.ort;
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ORT_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("I could not load the on-phone detector."));
    document.head.appendChild(script);
  });
  const ort = window.ort;
  if (!ort) throw new Error("I could not load the on-phone detector.");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = ORT_WASM;
  return ort;
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
  if (session || isYoloInstalled()) {
    await getSession();
    emitProgress({ state: "ready", pct: 100 });
    return true;
  }
  if (installPromise) return installPromise;
  installPromise = (async () => {
    emitProgress({ state: "downloading", pct: 0 });
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(MODEL_KEY);
    if (cached && cached.ok) {
      localStorage.setItem(READY_KEY, "1");
      await getSession();
      emitProgress({ state: "ready", pct: 100 });
      return true;
    }
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
        await getSession();
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
  session = null;
  localStorage.removeItem(READY_KEY);
  try {
    await caches.delete(CACHE_NAME);
  } catch {
    /* ignore */
  }
  emitProgress({ state: "missing", pct: 0 });
}

async function getSession() {
  if (session) return session;
  const ort = await loadOrt();
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(MODEL_KEY);
  if (!cached) {
    localStorage.removeItem(READY_KEY);
    throw new Error("Object detection is not on this phone yet.");
  }
  const buffer = await cached.arrayBuffer();
  session = await ort.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
  inputName = session.inputNames[0];
  outputName = session.outputNames[0];
  const meta = session.inputMetadata?.[inputName];
  const dims = meta?.dims || [];
  const hinted = Number(dims[2] || dims[3] || 0);
  inputSize = hinted > 0 ? hinted : 640;
  return session;
}

function letterbox(video, size) {
  if (!letterCanvas) letterCanvas = document.createElement("canvas");
  letterCanvas.width = size;
  letterCanvas.height = size;
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
  const data = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let i = 0; i < plane; i += 1) {
    const p = i * 4;
    data[i] = pixels[p] / 255;
    data[plane + i] = pixels[p + 1] / 255;
    data[plane * 2 + i] = pixels[p + 2] / 255;
  }
  return { data, scale, dx, dy, vw, vh, size };
}

function iou(a, b) {
  const x1 = Math.max(a.bbox[0], b.bbox[0]);
  const y1 = Math.max(a.bbox[1], b.bbox[1]);
  const x2 = Math.min(a.bbox[2], b.bbox[2]);
  const y2 = Math.min(a.bbox[3], b.bbox[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const aa = Math.max(0, a.bbox[2] - a.bbox[0]) * Math.max(0, a.bbox[3] - a.bbox[1]);
  const bb = Math.max(0, b.bbox[2] - b.bbox[0]) * Math.max(0, b.bbox[3] - b.bbox[1]);
  return inter / (aa + bb - inter + 1e-6);
}

function nms(items, iouThresh = 0.45) {
  const sorted = items.slice().sort((a, b) => b.confidence - a.confidence);
  const keep = [];
  for (const item of sorted) {
    if (keep.every((other) => iou(item, other) < iouThresh)) keep.push(item);
    if (keep.length >= 20) break;
  }
  return keep;
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

function decodeOutput(output, prep, confidence) {
  const dims = output.dims || [];
  let rows;
  const raw = output.data;
  if (dims.length === 3 && dims[1] < dims[2] && dims[1] <= 85) {
    const channels = dims[1];
    const anchors = dims[2];
    rows = new Array(anchors);
    for (let i = 0; i < anchors; i += 1) {
      const row = new Float32Array(channels);
      for (let c = 0; c < channels; c += 1) row[c] = raw[c * anchors + i];
      rows[i] = row;
    }
  } else if (dims.length === 3) {
    const anchors = dims[1];
    const channels = dims[2];
    rows = new Array(anchors);
    for (let i = 0; i < anchors; i += 1) {
      rows[i] = raw.subarray(i * channels, (i + 1) * channels);
    }
  } else {
    return [];
  }

  const { scale, dx, dy, vw, vh, size } = prep;
  const found = [];
  for (const row of rows) {
    const channels = row.length;
    const boxOffset = channels >= 85 ? 5 : 4;
    let classId = 0;
    let classScore = 0;
    for (let c = boxOffset; c < channels; c += 1) {
      if (row[c] > classScore) {
        classScore = row[c];
        classId = c - boxOffset;
      }
    }
    const obj = boxOffset === 5 ? row[4] : 1;
    const score = classScore * obj;
    if (score < confidence) continue;
    let x1;
    let y1;
    let x2;
    let y2;
    if (row[2] > 1.5 || row[3] > 1.5) {
      const cx = row[0];
      const cy = row[1];
      const w = row[2];
      const h = row[3];
      x1 = cx - w / 2;
      y1 = cy - h / 2;
      x2 = cx + w / 2;
      y2 = cy + h / 2;
    } else {
      x1 = row[0] * size;
      y1 = row[1] * size;
      x2 = row[2] * size;
      y2 = row[3] * size;
    }
    x1 = (x1 - dx) / scale;
    y1 = (y1 - dy) / scale;
    x2 = (x2 - dx) / scale;
    y2 = (y2 - dy) / scale;
    x1 = Math.max(0, Math.min(vw, x1));
    y1 = Math.max(0, Math.min(vh, y1));
    x2 = Math.max(0, Math.min(vw, x2));
    y2 = Math.max(0, Math.min(vh, y2));
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    found.push({
      label: COCO[classId] || `object`,
      confidence: Math.round(score * 1000) / 1000,
      bbox: [Math.round(x1 * 10) / 10, Math.round(y1 * 10) / 10, Math.round(x2 * 10) / 10, Math.round(y2 * 10) / 10],
      position: relativePosition(cx, cy, vw, vh),
    });
  }
  return nms(found);
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
  const ort = await loadOrt();
  const model = await getSession();
  const prep = letterbox(video, inputSize);
  const tensor = new ort.Tensor("float32", prep.data, [1, 3, prep.size, prep.size]);
  const result = await model.run({ [inputName]: tensor });
  const output = result[outputName] || result[model.outputNames[0]];
  let detections = decodeOutput(output, prep, confidence);
  if (objectName) {
    const target = String(objectName).trim().toLowerCase();
    detections = detections.filter((item) => String(item.label || "").toLowerCase().includes(target)).concat(
      detections.filter((item) => !String(item.label || "").toLowerCase().includes(target))
    );
  }
  return {
    detections,
    spoken: speakDetections(detections, objectName),
    sourceSize: { width: prep.vw, height: prep.vh },
    onDevice: true,
  };
}
