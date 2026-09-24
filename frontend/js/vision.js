import { api } from "./api.js";
import { camera } from "./camera.js";
import { armVisionSpeaker } from "./vision-speak.js";

async function sendVision(path, extra = {}, signal) {
  armVisionSpeaker();
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await camera.captureFile();
      armVisionSpeaker();
      const form = new FormData();
      form.append("image", file, "capture.jpg");
      Object.entries(extra).forEach(([key, value]) => form.append(key, value));
      const data = await api(path, { method: "POST", body: form, isForm: true, signal, timeout: 55000 });
      armVisionSpeaker();
      return data.spoken || data.description || data.answer || data.text || "I could not complete that request.";
    } catch (error) {
      lastError = error;
      const retry = error?.code === "TIMEOUT" || error?.code === "NETWORK_ERROR" || error?.code === "VISION_SERVICE_ERROR";
      if (!retry || attempt === 1) throw error;
      armVisionSpeaker();
    }
  }
  throw lastError;
}

export function readScene(signal) {
  return sendVision("/api/vision/read", {}, signal);
}

export function describeScene(signal) {
  return sendVision("/api/vision/describe", {}, signal);
}

export function askAboutScene(question, signal) {
  return sendVision("/api/vision/question", { question }, signal);
}
