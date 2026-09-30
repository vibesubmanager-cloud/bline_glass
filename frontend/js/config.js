import { DEFAULT_API_BASE } from "./api-config.js";

const TOKEN_KEY = "VIBE_EYE_TOKEN";
const USER_KEY = "VIBE_EYE_USER";
const SETTINGS_KEY = "VIBE_EYE_SETTINGS";
const LINKED_KEY = "VIBE_EYE_LINKED_BLIND";
const DEVICE_READY_KEY = "AISIGHT_DEVICE_READY";
const GPS_OK_KEY = "AISIGHT_GPS_OK";

function readStore(key) {
  return localStorage.getItem(key) || sessionStorage.getItem(key);
}

function writeStore(key, value) {
  localStorage.setItem(key, value);
  sessionStorage.setItem(key, value);
}

function removeStore(key) {
  localStorage.removeItem(key);
  sessionStorage.removeItem(key);
}

export function getApiBase() {
  const stored = String(localStorage.getItem("VIBE_EYE_API_URL") || "").replace(/\/$/, "");
  if (stored) return stored;
  const baked = String(DEFAULT_API_BASE || "").replace(/\/$/, "");
  if (baked) return baked;
  const origin = String(window.location.origin || "").replace(/\/$/, "");
  if (/\.github\.io$/i.test(window.location.hostname || "")) {
    return baked;
  }
  return origin;
}

export function setApiBase(url) {
  localStorage.setItem("VIBE_EYE_API_URL", url.replace(/\/$/, ""));
}

export function getToken() {
  return readStore(TOKEN_KEY);
}

export function tokenExpired(token = getToken()) {
  if (!token) return false;
  const part = String(token).split(".")[1];
  if (!part) return true;
  try {
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    if (!json || !json.exp) return false;
    return Date.now() >= Number(json.exp) * 1000 - 5000;
  } catch {
    return true;
  }
}

export function takeJustSignedOut() {
  try {
    const ended = sessionStorage.getItem("NYOTA_JUST_SIGNED_OUT") === "1";
    sessionStorage.removeItem("NYOTA_JUST_SIGNED_OUT");
    return ended;
  } catch {
    return false;
  }
}

export function signOutToLogin() {
  if (document.documentElement.dataset.nyotaSigningOut === "1") return;
  document.documentElement.dataset.nyotaSigningOut = "1";
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* speech may already be stopped */
  }
  document.querySelectorAll("audio").forEach((el) => {
    try {
      el.pause();
    } catch {
      /* ignore a player that is already gone */
    }
  });
  const role = getUser()?.role === "assistant" ? "assistant" : "blind";
  clearSession();
  try {
    sessionStorage.setItem("NYOTA_JUST_SIGNED_OUT", "1");
  } catch {
    /* session storage is optional */
  }
  const url = new URL(pages().login);
  url.searchParams.set("role", role);
  location.replace(url.href);
}

export function setSession(token, user, settings, linkedBlind) {
  if (token) writeStore(TOKEN_KEY, token);
  if (user) writeStore(USER_KEY, JSON.stringify(user));
  if (settings) writeStore(SETTINGS_KEY, JSON.stringify(settings));
  if (linkedBlind) writeStore(LINKED_KEY, JSON.stringify(linkedBlind));
  else if (user && user.role !== "assistant") removeStore(LINKED_KEY);
}

export function clearSession() {
  removeStore(TOKEN_KEY);
  removeStore(USER_KEY);
  removeStore(SETTINGS_KEY);
  removeStore(LINKED_KEY);
  removeStore(DEVICE_READY_KEY);
  removeStore(GPS_OK_KEY);
  try {
    sessionStorage.removeItem("NYOTA_PRIVACY_REQUIRED");
  } catch {
    /* session storage is optional */
  }
}

export function getUser() {
  try {
    return JSON.parse(readStore(USER_KEY) || "null");
  } catch {
    return null;
  }
}

export function getSettings() {
  try {
    return JSON.parse(readStore(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

export function getLinkedBlind() {
  try {
    return JSON.parse(readStore(LINKED_KEY) || "null");
  } catch {
    return null;
  }
}

export function pages() {
  return {
    welcome: new URL("../pages/welcome.html", import.meta.url).href,
    home: new URL("../pages/home.html", import.meta.url).href,
    login: new URL("../pages/login.html", import.meta.url).href,
    register: new URL("../pages/register.html", import.meta.url).href,
    registerAssistant: new URL("../pages/register-assistant.html", import.meta.url).href,
    contacts: new URL("../pages/contacts.html", import.meta.url).href,
    chat: new URL("../pages/chat.html", import.meta.url).href,
    settings: new URL("../pages/settings.html", import.meta.url).href,
    profile: new URL("../pages/profile.html", import.meta.url).href,
    plans: new URL("../pages/plans.html", import.meta.url).href,
    navigation: new URL("../pages/navigation.html", import.meta.url).href,
    emergency: new URL("../pages/emergency.html", import.meta.url).href,
    howTo: new URL("../pages/how-to-use.html", import.meta.url).href,
    privacy: new URL("../pages/privacy-policy.html", import.meta.url).href,
    permissions: new URL("../pages/permissions.html", import.meta.url).href,
  };
}

export function homeForUser(user = getUser()) {
  return user?.role === "assistant" ? pages().contacts : pages().home;
}

export function loginUrl(role) {
  const url = new URL(pages().login);
  if (role) url.searchParams.set("role", role);
  return url.href;
}

export function registerUrl(role) {
  if (role === "assistant") return pages().registerAssistant;
  const url = new URL(pages().register);
  url.searchParams.set("role", "blind");
  return url.href;
}

export { DEVICE_READY_KEY, GPS_OK_KEY };
