import { api } from "./api.js";
import { camera } from "./camera.js";
import { speakOut } from "./speak-out.js";
import { detectVideo, installYolo, isYoloReady } from "./yolo-on-device.js";

export async function detectObjects({ objectName, signal, quiet = false } = {}) {
  await camera.ensureStarted(document.getElementById("camera-preview"));
  if (await isYoloReady()) {
    const video = document.getElementById("camera-preview");
    const data = await detectVideo(video, { objectName });
    camera.lastCapture = data.sourceSize;
    return data;
  }
  if (!quiet) await speakOut("Capturing image.");
  const file = await camera.captureFile(quiet ? { quality: 0.55, maxW: 640 } : {});
  if (!quiet) await speakOut("Analyzing.");
  const form = new FormData();
  form.append("image", file, "capture.jpg");
  if (objectName) form.append("object", objectName);
  const data = await api("/api/detection", { method: "POST", body: form, isForm: true, signal, timeout: 20000 });
  return data;
}

export async function ensureOnDeviceYolo() {
  if (await isYoloReady()) return true;
  await installYolo();
  return isYoloReady();
}

export async function runDetection(options = {}) {
  const data = await detectObjects(options);
  return data.spoken || "I did not detect any objects I recognize in this view.";
}
