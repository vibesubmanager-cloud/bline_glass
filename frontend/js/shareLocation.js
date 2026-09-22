import { api } from "./api.js";
import { getSettings } from "./config.js";
import { getCurrentPosition } from "./location.js";

export async function sendLocationToContact({ target, destination } = {}) {
  const pos = await getCurrentPosition();
  const data = await api("/api/contacts/share-location", {
    method: "POST",
    body: {
      target: target || "",
      destination: destination || "",
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
    },
  });
  return data;
}

export function walkingDirectionsOn() {
  return getSettings().walking_directions === true;
}
