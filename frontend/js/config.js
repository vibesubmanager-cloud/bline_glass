import { DEFAULT_API_BASE } from "./api-config.js";

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
  return sessionStorage.getItem("VIBE_EYE_TOKEN");
}

export function setSession(token, user, settings, linkedBlind) {
  if (token) sessionStorage.setItem("VIBE_EYE_TOKEN", token);
  if (user) sessionStorage.setItem("VIBE_EYE_USER", JSON.stringify(user));
  if (settings) sessionStorage.setItem("VIBE_EYE_SETTINGS", JSON.stringify(settings));
  if (linkedBlind) sessionStorage.setItem("VIBE_EYE_LINKED_BLIND", JSON.stringify(linkedBlind));
  else if (user && user.role !== "assistant") sessionStorage.removeItem("VIBE_EYE_LINKED_BLIND");
}

export function clearSession() {
  sessionStorage.removeItem("VIBE_EYE_TOKEN");
  sessionStorage.removeItem("VIBE_EYE_USER");
  sessionStorage.removeItem("VIBE_EYE_SETTINGS");
  sessionStorage.removeItem("VIBE_EYE_LINKED_BLIND");
}

export function getUser() {
  try {
    return JSON.parse(sessionStorage.getItem("VIBE_EYE_USER") || "null");
  } catch {
    return null;
  }
}

export function getSettings() {
  try {
    return JSON.parse(sessionStorage.getItem("VIBE_EYE_SETTINGS") || "{}");
  } catch {
    return {};
  }
}

export function getLinkedBlind() {
  try {
    return JSON.parse(sessionStorage.getItem("VIBE_EYE_LINKED_BLIND") || "null");
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
