import { api } from "./api.js";
import { camera } from "./camera.js";
import { voice } from "./voice.js?v=49";

export async function detectObjects({ objectName, signal, quiet = false } = {}) {
  if (!quiet) await voice.speak("Capturing image.");
  const file = await camera.captureFile(quiet ? { quality: 0.55, maxW: 640 } : {});
  if (!quiet) await voice.speak("Analyzing.");
  const form = new FormData();
  form.append("image", file, "capture.jpg");
  if (objectName) form.append("object", objectName);
  const data = await api("/api/detection", { method: "POST", body: form, isForm: true, signal, timeout: 45000 });
  return data;
}

export async function runDetection(options = {}) {
  const data = await detectObjects(options);
  return data.spoken || "I did not detect any objects I recognize in this view.";
}
