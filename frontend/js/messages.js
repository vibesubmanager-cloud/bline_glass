import { api } from "./api.js";
import { getApiBase, getToken } from "./config.js";
import { getCurrentPosition } from "./location.js";

export async function sendChatMessage({
  target,
  recipientId,
  type = "text",
  body,
  file,
  latitude,
  longitude,
} = {}) {
  if (file || type === "image" || type === "voice") {
    const form = new FormData();
    if (target) form.append("target", target);
    if (recipientId) form.append("recipient_id", recipientId);
    form.append("type", type);
    if (body) form.append("body", body);
    if (latitude != null) form.append("latitude", String(latitude));
    if (longitude != null) form.append("longitude", String(longitude));
    if (file) form.append("file", file);
    return api("/api/messages/send", { method: "POST", body: form, isForm: true, timeout: 45000 });
  }
  return api("/api/messages/send", {
    method: "POST",
    body: {
      target: target || "",
      recipient_id: recipientId || "",
      type,
      body: body || "",
      latitude,
      longitude,
    },
  });
}

export async function sendChatLocation({ target, recipientId } = {}) {
  const pos = await getCurrentPosition();
  return sendChatMessage({
    target,
    recipientId,
    type: "location",
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
  });
}

export async function loadThread(userId) {
  return api(`/api/messages?with=${encodeURIComponent(userId)}`);
}

export async function loadConversations() {
  return api("/api/messages");
}

export async function loadGroupMessages() {
  return api("/api/messages?group=1");
}

export async function loadUnread() {
  return api("/api/messages/unread");
}

export async function markMessagesRead(ids) {
  if (!ids?.length) return;
  return api("/api/messages/read", { method: "POST", body: { ids } });
}

export async function mediaObjectUrl(messageId, mediaUrl) {
  if (mediaUrl && /^https?:\/\//i.test(mediaUrl)) return mediaUrl;
  const token = getToken();
  const response = await fetch(`${getApiBase()}/api/messages/media/${messageId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error("I could not open that file.");
  const blob = await response.blob();
  const mime = (response.headers.get("content-type") || blob.type || "").split(";")[0];
  const typed = mime && blob.type !== mime ? new Blob([blob], { type: mime }) : blob;
  return URL.createObjectURL(typed);
}
