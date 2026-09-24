import { api } from "./api.js";

export async function applyAppLogo() {
  const img = document.getElementById("app-logo");
  const fallback = document.getElementById("app-logo-fallback");
  if (!img) return;
  try {
    const data = await api("/api/branding");
    const url = data.logo_url || "";
    if (!url) return;
    img.src = url;
    img.onload = () => {
      img.classList.remove("hidden");
      fallback?.classList.add("hidden");
    };
    img.onerror = () => {
      img.classList.add("hidden");
      fallback?.classList.remove("hidden");
    };
  } catch {
    img.classList.add("hidden");
    fallback?.classList.remove("hidden");
  }
}
