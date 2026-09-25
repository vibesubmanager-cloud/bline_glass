import { api } from "./api.js";
import { getSettings } from "./config.js";
import { navigation, getCurrentPosition } from "./navigation.js";
import { startOnHome } from "./calls.js?v=16";
import { voice } from "./voice.js?v=56";
import { camera } from "./camera.js";
import { sendChatMessage } from "./messages.js";

export async function activateEmergency() {
  voice.unlock({ fromGesture: true });
  voice.speak("Emergency.");
  let latitude;
  let longitude;
  let accuracy;
  let file;
  try {
    const pos = await getCurrentPosition();
    latitude = pos.coords.latitude;
    longitude = pos.coords.longitude;
    accuracy = pos.coords.accuracy;
  } catch {
    /* still alert admin */
  }
  try {
    await camera.waitForLiveFrame(document.getElementById("camera-preview"));
    file = await camera.captureFile();
  } catch {
    file = null;
  }
  const share = getSettings().share_location_in_emergency !== false;
  const data = await api("/api/emergency/activate", {
    method: "POST",
    body: { latitude, longitude, accuracy, share_location: share && latitude != null },
  });
  const jobs = [];
  if (file) {
    jobs.push(
      sendChatMessage({ type: "image", file, body: "I need help now.", emergency: true }).catch(() => null)
    );
  }
  if (latitude != null && longitude != null) {
    jobs.push(
      sendChatMessage({
        type: "location",
        latitude,
        longitude,
        body: "I need help now.",
        emergency: true,
      }).catch(() => null)
    );
  }
  await Promise.all(jobs);
  await startOnHome("emergency", { video: true, emergency: true });
  return "I sent a picture from the camera, your location, and that you need help. The video call is on this screen.";
}

export async function cancelEmergency(eventId) {
  if (navigation.active) await navigation.stop(false);
  const data = await api("/api/emergency/cancel", { method: "POST", body: { event_id: eventId } });
  return data.spoken;
}
