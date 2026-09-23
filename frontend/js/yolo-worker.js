/* global ort */
const ORT_SRC = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js";
const ORT_WASM = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";
const CACHE_NAME = "aisight-yolo-v1";
const MODEL_KEY = "/aisight-yolo/yolov8n.onnx";
const MODEL_URLS = [
  new URL("../models/yolov8n.onnx", self.location.href).href,
  "https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx",
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

let session = null;
let inputName = "images";
let outputName = "output0";
let inputSize = 640;

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
    if (keep.length >= 12) break;
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
  const raw = output.data;
  let rows;
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
      x1 = row[0] - row[2] / 2;
      y1 = row[1] - row[3] / 2;
      x2 = row[0] + row[2] / 2;
      y2 = row[1] + row[3] / 2;
    } else {
      x1 = row[0] * size;
      y1 = row[1] * size;
      x2 = row[2] * size;
      y2 = row[3] * size;
    }
    x1 = Math.max(0, Math.min(vw, (x1 - dx) / scale));
    y1 = Math.max(0, Math.min(vh, (y1 - dy) / scale));
    x2 = Math.max(0, Math.min(vw, (x2 - dx) / scale));
    y2 = Math.max(0, Math.min(vh, (y2 - dy) / scale));
    if (x2 - x1 < 2 || y2 - y1 < 2) continue;
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    found.push({
      label: COCO[classId] || "object",
      confidence: Math.round(score * 1000) / 1000,
      bbox: [Math.round(x1 * 10) / 10, Math.round(y1 * 10) / 10, Math.round(x2 * 10) / 10, Math.round(y2 * 10) / 10],
      position: relativePosition(cx, cy, vw, vh),
    });
  }
  return nms(found);
}

async function init() {
  if (session) return inputSize;
  importScripts(ORT_SRC);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = false;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = ORT_WASM;
  const cache = await caches.open(CACHE_NAME);
  let packed = await cache.match(MODEL_KEY);
  if (!packed || !packed.ok) {
    for (const url of MODEL_URLS) {
      try {
        const response = await fetch(url);
        if (!response.ok) continue;
        const blob = await response.blob();
        if (blob.size < 800000) continue;
        packed = new Response(blob, { headers: { "Content-Type": "application/octet-stream" } });
        await cache.put(MODEL_KEY, packed.clone());
        break;
      } catch {
        /* try next */
      }
    }
  }
  if (!packed) throw new Error("Object detection model is not on this device yet.");
  const buffer = await packed.arrayBuffer();
  session = await ort.InferenceSession.create(buffer, { executionProviders: ["wasm"] });
  inputName = session.inputNames[0];
  outputName = session.outputNames[0];
  const dims = session.inputMetadata?.[inputName]?.dims || [];
  const hinted = Number(dims[2] || dims[3] || 0);
  inputSize = hinted > 0 ? hinted : 640;
  return inputSize;
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  try {
    if (msg.type === "init") {
      const size = await init();
      self.postMessage({ type: "ready", inputSize: size });
      return;
    }
    if (msg.type === "infer") {
      if (!session) await init();
      const prep = {
        scale: msg.scale,
        dx: msg.dx,
        dy: msg.dy,
        vw: msg.vw,
        vh: msg.vh,
        size: msg.size,
      };
      const tensor = new ort.Tensor("float32", new Float32Array(msg.data), [1, 3, msg.size, msg.size]);
      const result = await session.run({ [inputName]: tensor });
      const output = result[outputName] || result[session.outputNames[0]];
      const detections = decodeOutput(output, prep, msg.confidence || 0.35);
      self.postMessage({ type: "detections", id: msg.id, detections, vw: prep.vw, vh: prep.vh });
    }
  } catch (error) {
    self.postMessage({ type: "error", id: msg.id, message: String(error && error.message ? error.message : error) });
  }
};
