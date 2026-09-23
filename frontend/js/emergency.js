import { api } from "./api.js";
import { getSettings } from "./config.js";
import { navigation, getCurrentPosition } from "./navigation.js";
import { calls } from "./calls.js?v=3";
import { voice } from "./voice.js?v=55";

export async function activateEmergency() {
  await voice.speak("Emergency. Getting your location.");
  let latitude;
  let longitude;
  let accuracy;
  try {
    const pos = await getCurrentPosition();
    latitude = pos.coords.latitude;
    longitude = pos.coords.longitude;
    accuracy = pos.coords.accuracy;
  } catch {
    await voice.speak("I can't get your current location. I will still contact your emergency contact.");
  }
  const share = getSettings().share_location_in_emergency !== false;
  const data = await api("/api/emergency/activate", {
    method: "POST",
    body: { latitude, longitude, accuracy, share_location: share && latitude != null },
  });
  const primary = data.primary_contact;
  if (primary?.name) {
    try {
      await calls.start(primary.name);
    } catch {
      if (primary.phone) location.href = `tel:${primary.phone}`;
    }
  }
  return data.spoken;
}

export async function cancelEmergency(eventId) {
  if (navigation.active) await navigation.stop(false);
  const data = await api("/api/emergency/cancel", { method: "POST", body: { event_id: eventId } });
  return data.spoken;
}
