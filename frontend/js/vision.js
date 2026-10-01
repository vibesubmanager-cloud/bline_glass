/* DO NOT CHANGE describe, read, or photo questions. This path is working. Leave it alone. */

import { api } from "./api.js";
import { camera } from "./camera.js";
import { armVisionSpeaker } from "./vision-speak.js";

async function normalizeJpeg(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const maxW = 960;
    const scale = Math.min(1, maxW / (bitmap.width || maxW));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(2, Math.round((bitmap.width || maxW) * scale));
    canvas.height = Math.max(2, Math.round((bitmap.height || 720) * scale));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (!blob) return file;
    return new File([blob], "capture.jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

async function sendVision(path, extra = {}) {
  armVisionSpeaker();
  const file = await normalizeJpeg(await camera.captureFile());
  armVisionSpeaker();
  const form = new FormData();
  form.append("image", file, "capture.jpg");
  Object.entries(extra).forEach(([key, value]) => form.append(key, value));
  const data = await api(path, { method: "POST", body: form, isForm: true, timeout: 70000 });
  armVisionSpeaker();
  const spoken = data?.spoken || data?.description || data?.answer || data?.text;
  if (!spoken) {
    throw Object.assign(new Error("I could not describe that picture. Please try again."), { code: "VISION_SERVICE_ERROR" });
  }
  return spoken;
}

export function readScene() {
  return sendVision("/api/vision/read");
}

export function describeScene() {
  return sendVision("/api/vision/describe");
}

export function askAboutScene(question) {
  return sendVision("/api/vision/question", { question });
}
