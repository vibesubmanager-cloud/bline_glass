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
