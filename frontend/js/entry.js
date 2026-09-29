import { api } from "./api.js";
import { getToken, getUser, setSession } from "./config.js";

export const ENTRY_OK_KEY = "NYOTA_HOME_ENTRY_OK";
export const LEFT_APP_KEY = "NYOTA_LEFT_APP";

export function privacyStorageKey(userId) {
  return `NYOTA_PRIVACY_POLICY_${userId || "account"}`;
}

export function hasPrivacyAgreement(user = getUser()) {
  if (user?.privacy_policy_agreed_at) return true;
  try {
    return Boolean(user?.id && localStorage.getItem(privacyStorageKey(user.id)));
  } catch {
    return false;
  }
}

export function markPrivacyAgreed(userId) {
  const iso = new Date().toISOString();
  localStorage.setItem(privacyStorageKey(userId), iso);
  return iso;
}

export function markHomeEntryOk() {
  sessionStorage.setItem(ENTRY_OK_KEY, "1");
  sessionStorage.removeItem(LEFT_APP_KEY);
}

export function homeNeedsPermissionCheck() {
  try {
    if (sessionStorage.getItem(LEFT_APP_KEY) === "1") return true;
    return sessionStorage.getItem(ENTRY_OK_KEY) !== "1";
  } catch {
    return true;
  }
}

export async function syncPrivacyAgreement(userId) {
  const id = userId || getUser()?.id;
  let stamp = "";
  try {
    stamp = localStorage.getItem(privacyStorageKey(id)) || "";
  } catch {
    stamp = "";
  }
  if (!stamp || !getToken()) return null;
  try {
    const data = await api("/api/auth/privacy-policy", {
      method: "POST",
      body: { agreed_at: stamp },
    });
    const user = getUser();
    if (user && data?.privacy_policy_agreed_at) {
      user.privacy_policy_agreed_at = data.privacy_policy_agreed_at;
      setSession(getToken(), user);
    }
    return data;
  } catch {
    return null;
  }
}
