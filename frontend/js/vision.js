import { api } from "./api.js";
import { camera } from "./camera.js";
import { voice } from "./voice.js?v=55";

async function sendVision(path, extra = {}, signal) {
  voice.keepAlive(true);
  try {
    const file = await camera.captureFile();
    const form = new FormData();
    form.append("image", file, "capture.jpg");
    Object.entries(extra).forEach(([key, value]) => form.append(key, value));
    const data = await api(path, { method: "POST", body: form, isForm: true, signal, timeout: 45000 });
    voice.restoreSpeaker();
    return data.spoken || data.description || data.answer || data.text || "I could not complete that request.";
  } catch (error) {
    voice.keepAlive(false);
    throw error;
  }
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
