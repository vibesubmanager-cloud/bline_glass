import { getApiBase, getToken, signOutToLogin } from "./config.js";

const REQUEST_TIMEOUT_MS = 45000;
const WAKE_TIMEOUT_MS = 90000;

export class ApiError extends Error {
  constructor(message, code = "NETWORK_ERROR", status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return {
      success: false,
      data: null,
      error: {
        code: "SERVER_ERROR",
        message: "The app could not reach the server. Open Settings, save the Render API address, then refresh.",
      },
    };
  }
}

async function apiOnce(path, { method = "GET", body, signal, timeout = REQUEST_TIMEOUT_MS, isForm = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });

  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isForm && body !== undefined) headers["Content-Type"] = "application/json";

  try {
    const response = await fetch(`${getApiBase()}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await parseBody(response);
    if (!payload) {
      throw new ApiError("The server returned an unexpected response.", "SERVER_ERROR", response.status);
    }
    if (!payload.success) {
      const err = payload.error || {};
      const message =
        err.message ||
        (response.status === 401 ? "Username or password is incorrect." : "Request failed.");
      const signingIn = /\/api\/auth\/(?:login|register)|\/api\/admin\/login/.test(path);
      if (token && response.status === 401 && !signingIn) {
        signOutToLogin();
        throw new ApiError("You have been signed out.", "SESSION_ENDED", 401);
      }
      throw new ApiError(message, err.code || (response.status === 401 ? "AUTH_REQUIRED" : "SERVER_ERROR"), response.status);
    }
    return payload.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) {
      throw new ApiError("That request took too long. Please try again.", "TIMEOUT");
    }
    if (error.name === "AbortError") {
      throw new ApiError("That request took too long. Please try again.", "TIMEOUT");
    }
    throw new ApiError("The internet connection looks unavailable.", "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

export async function api(path, options = {}) {
  try {
    return await apiOnce(path, options);
  } catch (error) {
    if (options._retry || options.signal?.aborted) throw error;
    if (!(error instanceof ApiError)) throw error;
    if (error.code !== "TIMEOUT" && error.code !== "NETWORK_ERROR") throw error;
    return apiOnce(path, { ...options, timeout: Math.max(options.timeout || 0, WAKE_TIMEOUT_MS), _retry: true });
  }
}

export function wakeServer() {
  return api("/api/health", { timeout: WAKE_TIMEOUT_MS, _retry: true }).catch(() => undefined);
}

export function isOnline() {
  return navigator.onLine;
}
