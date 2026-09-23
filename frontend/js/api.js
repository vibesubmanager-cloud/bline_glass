import { getApiBase, getToken } from "./config.js";

const REQUEST_TIMEOUT_MS = 30000;

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

export async function api(path, { method = "GET", body, signal, timeout = REQUEST_TIMEOUT_MS, isForm = false } = {}) {
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
      if (response.status === 401) {
        throw new ApiError("Please sign in again.", "AUTH_REQUIRED", 401);
      }
    if (!payload) {
      throw new ApiError("The server returned an unexpected response.", "SERVER_ERROR", response.status);
    }
    if (!payload.success) {
      const err = payload.error || {};
      throw new ApiError(err.message || "Request failed.", err.code || "SERVER_ERROR", response.status);
    }
    return payload.data;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === "AbortError") {
      throw new ApiError("That request took too long. Please try again.", "TIMEOUT");
    }
    throw new ApiError("The internet connection looks unavailable.", "NETWORK_ERROR");
  } finally {
    clearTimeout(timer);
  }
}

export function isOnline() {
  return navigator.onLine;
}
