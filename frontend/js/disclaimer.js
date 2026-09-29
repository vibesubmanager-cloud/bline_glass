import { api } from "./api.js";
import { getToken, getUser, setSession } from "./config.js";

export const APP_NAME = "Nyota Sight";
export const AGREED_KEY = "NYOTA_DISCLAIMER_AGREED_AT";

export const DISCLAIMER_PARAGRAPHS = [
  "Welcome to Nyota Sight. Before you start, please listen to this short notice.",
  "This app is in beta. It is still being tested and may get things wrong. Please check anything important another way.",
  "Nyota Sight does not replace your cane, guide dog or mobility training. Please keep using them.",
  "We recommend using the app indoors. If you use it outside, you do so at your own risk. Stay aware of your surroundings, and take care when holding your phone out in public.",
  "Emergency chat sends a message to your linked contacts. It does not contact the emergency services. In an emergency, call 999.",
  "When you use the camera features, photos are sent to outside AI services to be processed. You can hear our privacy notice in Settings.",
  'To agree and continue, select "I agree". To hear this again, select "Repeat".',
];

export const DISCLAIMER_SCRIPT = DISCLAIMER_PARAGRAPHS.join(" ");

export const DISAGREE_SCRIPT =
  "Nyota Sight cannot be used without agreeing to this notice.";

export const PRIVACY_PARAGRAPHS = [
  "Nyota Sight privacy and policy.",
  "Please listen before you continue.",
  "Nyota Sight is used in the United Kingdom. The maker is registered with the Information Commissioner's Office.",
  "This app is in beta. It may get things wrong. Please check anything important another way.",
  "When you use the camera, photos are sent to outside AI services to be processed.",
  "Your account stores your name, username, email, phone number, and the notes you add. A Personal Assistant linked to you can see the profile you share.",
  "Location is used when you ask for the map, walking, or to send where you are. Emergency chat sends a message to your linked contacts. It does not contact the emergency services. In an emergency, call 999.",
  "Nyota Sight does not replace your cane, guide dog, or mobility training.",
  'To continue, select "I agree", then select "Next".',
];

export const PRIVACY_NOTICE = PRIVACY_PARAGRAPHS.join(" ");

export function privacyNoticeText() {
  const notice = String(PRIVACY_NOTICE || "").trim();
  if (notice) return notice;
  return "The full privacy notice is not in the app yet. It will be read from Settings when the wording is ready.";
}

export function agreedAt() {
  try {
    return localStorage.getItem(AGREED_KEY) || "";
  } catch {
    return "";
  }
}

export function formatAgreedAt(iso) {
  if (!iso) return "";
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  return when.toLocaleString("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
}

export function agreeNow() {
  const iso = new Date().toISOString();
  localStorage.setItem(AGREED_KEY, iso);
  try {
    sessionStorage.setItem(AGREED_KEY, iso);
  } catch {
    /* session storage is optional */
  }
  return iso;
}

export async function syncDisclaimerAgreement() {
  const stamp = agreedAt();
  if (!stamp || !getToken()) return null;
  try {
    const data = await api("/api/auth/disclaimer", {
      method: "POST",
      body: { agreed_at: stamp },
    });
    const user = getUser();
    if (user && data?.disclaimer_agreed_at) {
      user.disclaimer_agreed_at = data.disclaimer_agreed_at;
      setSession(getToken(), user);
    }
    return data;
  } catch {
    return null;
  }
}
