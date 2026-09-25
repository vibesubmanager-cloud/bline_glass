import { getToken, pages } from "./config.js";
import { voice } from "./voice.js?v=44";
import { recorder } from "./recorder.js";
import {
  loadGroupMessages,
  loadThread,
  markMessagesRead,
  mediaObjectUrl,
  sendChatLocation,
  sendChatMessage,
} from "./messages.js";
import { startMessageNotices } from "./notify.js";

const params = new URLSearchParams(location.search);
const peerId = params.get("with") || "";
const groupMode = params.get("group") === "1";
const title = document.getElementById("chat-title");
const status = document.getElementById("chat-status");
const thread = document.getElementById("chat-thread");
const form = document.getElementById("chat-form");
const input = document.getElementById("chat-input");
const fileInput = document.getElementById("chat-file");
const voiceBtn = document.getElementById("chat-voice");

if (!getToken()) location.href = pages().welcome;
if (!peerId && !groupMode) location.href = pages().contacts;

const mediaUrls = new Map();
let lastIds = "";
let peerName = "Them";

function showStatus(message) {
  status.textContent = message || "";
}

function nearBottom() {
  return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
}

function isAudioPlaying() {
  return [...thread.querySelectorAll("audio")].some((el) => !el.paused && !el.ended);
}

async function makeBubble(message) {
  const bubble = document.createElement("article");
  bubble.className = `chat-bubble ${message.mine ? "mine" : "theirs"}`;
  bubble.dataset.id = message.id;
  const label = document.createElement("p");
  label.className = "chat-meta";
  label.textContent = message.mine ? "You" : message.from_name || peerName;
  bubble.appendChild(label);
  if (message.type === "image" && message.has_media) {
    const img = document.createElement("img");
    img.alt = "Sent picture";
    img.className = "chat-media";
    const cached = mediaUrls.get(message.id) || (await mediaObjectUrl(message.id, message.media_url).catch(() => ""));
    if (cached) {
      mediaUrls.set(message.id, cached);
      img.src = cached;
    }
    bubble.appendChild(img);
  } else if (message.type === "voice" && message.has_media) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "auto";
    audio.setAttribute("playsinline", "");
    audio.setAttribute("controlslist", "nodownload");
    const cached = mediaUrls.get(message.id) || (await mediaObjectUrl(message.id, message.media_url).catch(() => ""));
    if (cached) {
      mediaUrls.set(message.id, cached);
      audio.src = cached;
    }
    bubble.appendChild(audio);
  } else if (message.type === "location" && message.maps_url) {
    const link = document.createElement("a");
    link.href = message.maps_url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Open map";
    bubble.appendChild(link);
  } else {
    const copy = document.createElement("p");
    copy.textContent = message.body || "";
    bubble.appendChild(copy);
  }
  return bubble;
}

async function renderMessages(messages) {
  const shouldStick = nearBottom();
  thread.innerHTML = "";
  for (const message of messages) {
    thread.appendChild(await makeBubble(message));
  }
  if (shouldStick) thread.scrollTop = thread.scrollHeight;
}

async function refresh() {
  const data = groupMode ? await loadGroupMessages() : await loadThread(peerId);
  peerName = data.peer?.name || (groupMode ? "Family group" : "Them");
  title.textContent = peerName;
  const messages = data.messages || [];
  const ids = messages.map((item) => item.id).join(",");
  if (ids === lastIds) return;
  const existing = [...thread.querySelectorAll("[data-id]")].map((el) => el.dataset.id);
  const existingSet = new Set(existing);
  const added = messages.filter((item) => !existingSet.has(item.id));
  const canAppend = existing.length && added.length === messages.length - existing.length;
  if (canAppend) {
    const stick = nearBottom();
    for (const message of added) thread.appendChild(await makeBubble(message));
    lastIds = ids;
    if (stick) thread.scrollTop = thread.scrollHeight;
  } else if (isAudioPlaying()) {
    return;
  } else {
    lastIds = ids;
    await renderMessages(messages);
  }
  await markMessagesRead(messages.filter((item) => !item.mine && !item.read_at).map((item) => item.id));
}

async function handleSend(payload) {
  try {
    showStatus("Sending…");
    const result = await sendChatMessage({ recipientId: groupMode ? "" : peerId, ...payload });
    input.value = "";
    const spoken = result.spoken || "Done. I have sent it.";
    showStatus(spoken);
    await voice.speak(spoken);
    await refresh();
  } catch (error) {
    showStatus(error.message);
    await voice.speak(error.message);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = input.value.trim();
  if (!body) return;
  await handleSend({ type: "text", body });
});

document.getElementById("chat-photo").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  fileInput.value = "";
  if (!file) return;
  await handleSend({ type: "image", file });
});

document.getElementById("chat-location").addEventListener("click", async () => {
  try {
    showStatus("Sending location…");
    const result = await sendChatLocation({ recipientId: groupMode ? "" : peerId });
    const spoken = result.spoken || "Done. I have sent your location.";
    showStatus(spoken);
    await voice.speak(spoken);
    await refresh();
  } catch (error) {
    showStatus(error.message);
    await voice.speak(error.message);
  }
});

voiceBtn.addEventListener("click", async () => {
  try {
    if (recorder.recording) {
      const file = await recorder.stop();
      voiceBtn.classList.remove("is-on");
      if (file) await handleSend({ type: "voice", file });
      return;
    }
    await recorder.start();
    voiceBtn.classList.add("is-on");
    showStatus("Recording. Tap the mic again to send.");
  } catch (error) {
    voiceBtn.classList.remove("is-on");
    showStatus(error.message);
    await voice.speak(error.message);
  }
});

refresh().catch(async (error) => {
  showStatus(error.message);
  await voice.speak(error.message);
});
setInterval(() => {
  refresh().catch(() => undefined);
}, 5000);
startMessageNotices({ speak: true, href: groupMode ? "./chat.html?group=1" : `${pages().chat}?with=${encodeURIComponent(peerId)}` });
