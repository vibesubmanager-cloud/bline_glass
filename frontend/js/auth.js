import { api, ApiError } from "./api.js";
import { setSession, getApiBase, setApiBase, pages, getToken, getUser, homeForUser, loginUrl } from "./config.js";
import { voice } from "./voice.js?v=44";

function roleFromPage() {
  const params = new URLSearchParams(location.search);
  return params.get("role") === "assistant" ? "assistant" : "blind";
}

export function afterAuth(result) {
  setSession(result.token, result.user, result.settings, result.linked_blind);
  location.assign(homeForUser(result.user));
}

export function bindAuthForm(form, mode) {
  const status = document.getElementById("form-status");
  const submit = form.querySelector("button[type='submit']");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit) submit.disabled = true;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const path = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      if (status) status.textContent = mode === "register" ? "Creating account…" : "Signing in…";
      if (mode === "login") {
        data.username = (data.username || data.email || "").trim();
        data.email = data.username;
      }
      const result = await api(path, { method: "POST", body: data });
      if (status) status.textContent = "Signed in.";
      if (mode === "register" && result.user?.role === "blind" && result.user?.system_id) {
        await voice.speak(`Account created. Your system ID is ${result.user.system_id}. You can find the QR code in settings.`);
      }
      afterAuth(result);
    } catch (error) {
      if (submit) submit.disabled = false;
      const message = error instanceof ApiError ? error.message : "I couldn't complete that request. Please try again.";
      if (status) status.textContent = message;
      voice.speak(message);
    }
  });
}

export function collectEmergencyContacts(root = document) {
  return [...root.querySelectorAll("[data-emergency-row]")].map((row) => {
    const name = row.querySelector("[name='emergency_name']")?.value.trim();
    const phone = row.querySelector("[name='emergency_phone']")?.value.trim();
    const relationship = row.querySelector("[name='emergency_relationship']")?.value.trim() || "family";
    return { name, phone, relationship };
  }).filter((item) => item.name && item.phone);
}

export function bindBlindRegisterForm(form) {
  const status = document.getElementById("form-status");
  const submit = form.querySelector("button[type='submit']");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit) submit.disabled = true;
    const data = Object.fromEntries(new FormData(form).entries());
    const payload = {
      role: "blind",
      first_name: data.first_name,
      last_name: data.last_name,
      username: data.username,
      email: data.email,
      phone: data.phone,
      password: data.password,
      health_notes: data.health_notes,
      other_notes: data.other_notes,
      emergency_contacts: collectEmergencyContacts(form),
    };
    try {
      if (status) status.textContent = "Creating account…";
      const result = await api("/api/auth/register", { method: "POST", body: payload });
      if (status) status.textContent = "Account created.";
      if (result.user?.system_id) {
        await voice.speak(`Account created. Your system ID is ${result.user.system_id}. You can find the QR code in settings.`);
      }
      afterAuth(result);
    } catch (error) {
      if (submit) submit.disabled = false;
      const message = error instanceof ApiError ? error.message : "I couldn't complete that request. Please try again.";
      if (status) status.textContent = message;
      voice.speak(message);
    }
  });
}

export function bindApiField() {
  const input = document.getElementById("api-url");
  const save = document.getElementById("save-api");
  if (input) {
    input.value = getApiBase();
    input.readOnly = false;
  }
  save?.classList.remove("hidden");
  save?.addEventListener("click", () => {
    const next = String(input?.value || "").trim();
    if (!next) return;
    setApiBase(next);
    if (input) input.value = getApiBase();
    const status = document.getElementById("settings-status") || document.getElementById("form-status");
    if (status) status.textContent = "API address saved. Reload the page, then sign in.";
  });
}

export function redirectIfAuthed() {
  if (getToken()) location.href = homeForUser(getUser());
}

export function currentRole() {
  return roleFromPage();
}

export { loginUrl, pages };
