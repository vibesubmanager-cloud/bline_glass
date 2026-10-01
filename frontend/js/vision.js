import { api } from "./api.js";
import { camera } from "./camera.js";
import { armVisionSpeaker } from "./vision-speak.js";
import { GEMINI_API_KEY } from "./vision-config.js";

const KEY_STORE = "NYOTA_GEMINI_KEY";
const MODELS = [
  { model: "gemini-2.5-flash", thinking: true },
  { model: "gemini-2.5-flash-lite", thinking: true },
  { model: "gemini-2.0-flash", thinking: false },
];

const DESCRIBE_PROMPT = `You are the eyes of a visually impaired person. Describe what is actually in this camera photo.
Speak 2 to 4 short sentences, as if you are standing next to them.
First say the setting: indoors or outdoors, and the kind of place if it is clear.
Then describe the main things in view: people, furniture, screens, doors, windows, objects in the path, and what is happening.
Use plain spoken English. Do not invent objects.
Describe whatever is visible, even when the picture is dim. Only say the picture is too dark when it is completely black.`;

const READ_PROMPT = `You are assisting a visually impaired person. Read only the page, paper, document, book, menu, sign, or screen that is facing the camera and filling most of the view.
Ignore the room, furniture, hands, people, and anything around that page.
Read the text in a natural order, clearly, as if reading it aloud.
If there is no readable page or text in front of the camera, say you cannot see a page to read.
Do not invent text.`;

const QUESTION_PROMPT = `You are assisting a visually impaired person. Answer the user's question about this image in one or two short spoken sentences.
If you are not sure, say you are not sure. Do not invent details.
User question: `;

function storedKey() {
  const baked = String(GEMINI_API_KEY || "").trim();
  if (baked) return baked;
  try {
    return String(localStorage.getItem(KEY_STORE) || "").trim();
  } catch {
    return "";
  }
}

function rememberKey(key) {
  const value = String(key || "").trim();
  if (!value || value.length < 20) return "";
  try {
    localStorage.setItem(KEY_STORE, value);
  } catch {
    /* the baked key still works */
  }
  return value;
}

function forgetKey() {
  try {
    localStorage.removeItem(KEY_STORE);
  } catch {
    /* storage can be blocked */
  }
}

export function warmGeminiKey() {
  if (storedKey()) return Promise.resolve(storedKey());
  return api("/api/vision/browser-key", { timeout: 8000 })
    .then((data) => rememberKey(data?.key))
    .catch(() => "");
}

function firstSentences(text, count = 4) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  const parts = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (parts.length <= count) return cleaned;
  return parts.slice(0, count).join(" ");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("I could not read the camera picture."));
    reader.readAsDataURL(file);
  });
}

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

function partsText(payload) {
  const bits = [];
  for (const candidate of payload?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (part?.thought) continue;
      const text = String(part?.text || "").trim();
      if (text) bits.push(text);
    }
  }
  return bits.join("\n").trim();
}

async function postGemini(model, prompt, base64, key, { thinking = false, camel = true } = {}) {
  const imagePart = camel
    ? { inlineData: { mimeType: "image/jpeg", data: base64 } }
    : { inline_data: { mime_type: "image/jpeg", data: base64 } };
  const generationConfig = { temperature: 0.4, maxOutputTokens: 1024 };
  if (thinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
  url.searchParams.set("key", key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, imagePart] }],
        generationConfig,
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    return { ok: response.ok, status: response.status, payload };
  } finally {
    clearTimeout(timer);
  }
}

function errorText(payload) {
  return String(payload?.error?.message || "");
}

async function askGemini(prompt, base64, signal) {
  let key = storedKey() || (await warmGeminiKey());
  if (!key) {
    throw Object.assign(
      new Error("Describe cannot start yet. Open the app once while the server is awake, then try again."),
      { code: "NO_GEMINI_KEY" }
    );
  }
  let refreshed = false;
  for (const attempt of MODELS) {
    for (const camel of [true, false]) {
      let result;
      try {
        result = await postGemini(attempt.model, prompt, base64, key, { thinking: attempt.thinking, camel });
      } catch {
        continue;
      }
      const message = errorText(result.payload);
      if (/api key/i.test(message) && !refreshed) {
        refreshed = true;
        forgetKey();
        key = await warmGeminiKey();
        if (!key) break;
        continue;
      }
      const text = partsText(result.payload);
      if (result.ok && text) return text;
      if (camel && (!result.ok && /unknown name|inlinedata|inline_data/i.test(message) || (result.ok && !text))) continue;
      break;
    }
  }
  throw Object.assign(
    new Error("The camera is on, but that picture did not come through. Hold the phone steady and try again."),
    { code: "VISION_SERVICE_ERROR" }
  );
}

async function askServer(kind, file, extra, signal) {
  const form = new FormData();
  form.append("image", file, "capture.jpg");
  Object.entries(extra).forEach(([key, value]) => form.append(key, value));
  const path = kind === "read" ? "/api/vision/read" : kind === "question" ? "/api/vision/question" : "/api/vision/describe";
  const data = await api(path, { method: "POST", body: form, isForm: true, signal, timeout: 20000 });
  return data?.spoken || data?.description || data?.answer || data?.text || "";
}

async function see(kind, prompt, signal, extra = {}, sentences = 4) {
  armVisionSpeaker();
  const file = await normalizeJpeg(await camera.captureFile());
  armVisionSpeaker();
  const base64 = await fileToBase64(file);
  try {
    const spoken = firstSentences(await askGemini(prompt, base64, signal), sentences);
    if (spoken) {
      armVisionSpeaker();
      return spoken;
    }
  } catch (error) {
    if (signal?.aborted || error?.code === "NO_GEMINI_KEY") {
      try {
        const spoken = firstSentences(await askServer(kind, file, extra, signal), sentences);
        if (spoken) return spoken;
      } catch {
        /* Google and the server both missed this picture */
      }
      if (error?.code === "NO_GEMINI_KEY") throw error;
    }
  }
  try {
    const spoken = firstSentences(await askServer(kind, file, extra, signal), sentences);
    if (spoken) return spoken;
  } catch {
    /* The phone already tried Google. */
  }
  throw Object.assign(
    new Error("The camera is on, but that picture did not come through. Hold the phone steady and try again."),
    { code: "VISION_SERVICE_ERROR" }
  );
}

export function readScene(signal) {
  return see("read", READ_PROMPT, signal, {}, 8);
}

export function describeScene(signal) {
  return see("describe", DESCRIBE_PROMPT, signal, {}, 4);
}

export function askAboutScene(question, signal) {
  return see("question", `${QUESTION_PROMPT}${String(question || "").trim()}`, signal, { question }, 3);
}
