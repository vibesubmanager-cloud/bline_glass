import { api } from "./api.js";

let cache = null;

export async function refreshBilling() {
  try {
    cache = await api("/api/billing/plans");
  } catch {
    cache = null;
  }
  return cache;
}

export function canUseDescribe() {
  if (!cache) return true;
  return Boolean(cache.can_describe);
}

export const PREMIUM_SPOKEN =
  "Describe and Read are on Premium. Open Plans to subscribe for five dollars a month.";
