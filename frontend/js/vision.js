import { api } from "./api.js";
import { camera } from "./camera.js";
import { armVisionSpeaker } from "./vision-speak.js";
import { GEMINI_API_KEY } from "./vision-config.js";

const KEY_STORE = "NYOTA_GEMINI_KEY";
const MODELS = [
  { model: "gemini-2.0-flash", thinking: false, camel: false },
  { model: "gemini-2.0-flash", thinking: false, camel: true },
  { model: "gemini-2.5-flash", thinking: true, camel: false },
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
  if (!value) return "";
  try {
    localStorage.setItem(KEY_STORE, value);
  } catch {
    /* the baked key still works */
  }
  return value;
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

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const size = 0x2000;
  for (let index = 0; index < bytes.length; index += size) {
    binary += String.fromCharCode(...bytes.subarray(index, index + size));
  }
  return btoa(binary);
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

function refused(text) {
  return /could(?: not|'t) see that clearly|having trouble processing the image/i.test(text || "");
}

async function askGemini(prompt, base64, signal) {
  const key = storedKey() || (await warmGeminiKey());
  if (!key) {
    throw Object.assign(
      new Error("Describe cannot start yet. Open the app once while the server is awake, then try again."),
      { code: "NO_GEMINI_KEY" }
    );
  }
  let lastStatus = 0;
  for (const attempt of MODELS) {
    const imagePart = attempt.camel
      ? { inlineData: { mimeType: "image/jpeg", data: base64 } }
      : { inline_data: { mime_type: "image/jpeg", data: base64 } };
    const generationConfig = { temperature: 0.4, maxOutputTokens: 1024 };
    if (attempt.thinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const onAbort = () => controller.abort();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${attempt.model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [imagePart, { text: prompt }] }],
            generationConfig,
          }),
          signal: controller.signal,
        }
      );
      lastStatus = response.status;
      if (!response.ok) continue;
      const text = partsText(await response.json());
      if (text && !refused(text)) return text;
    } catch (error) {
      if (error?.name === "AbortError" && signal?.aborted) throw error;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }
  if (lastStatus === 401 || lastStatus === 403) {
    throw Object.assign(new Error("The vision key was rejected. Try again in a moment."), { code: "VISION_KEY" });
  }
  throw Object.assign(
    new Error("The camera is on, but that picture did not come through. Hold the phone steady and try again."),
    { code: "VISION_SERVICE_ERROR" }
  );
}

async function see(prompt, signal, { sentences = 4 } = {}) {
  armVisionSpeaker();
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const file = await camera.captureFile();
      armVisionSpeaker();
      const spoken = firstSentences(await askGemini(prompt, await fileToBase64(file), signal), sentences);
      if (!spoken) {
        throw Object.assign(
          new Error("The camera is on, but that picture did not come through. Hold the phone steady and try again."),
          { code: "VISION_SERVICE_ERROR" }
        );
      }
      armVisionSpeaker();
      return spoken;
    } catch (error) {
      lastError = error;
      const retry = error?.code === "VISION_SERVICE_ERROR" || error?.name === "AbortError";
      if (!retry || attempt === 1 || signal?.aborted) throw error;
      armVisionSpeaker();
    }
  }
  throw lastError;
}

export function readScene(signal) {
  return see(READ_PROMPT, signal, { sentences: 8 });
}

export function describeScene(signal) {
  return see(DESCRIBE_PROMPT, signal, { sentences: 4 });
}

export function askAboutScene(question, signal) {
  return see(`${QUESTION_PROMPT}${String(question || "").trim()}`, signal, { sentences: 3 });
}
