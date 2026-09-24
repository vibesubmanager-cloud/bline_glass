import { camera } from "./camera.js";
import { DEVICE_READY_KEY, GPS_OK_KEY } from "./config.js";
import { locationPermissionState, requestLocationAccess } from "./location.js";

export function isDeviceReady() {
  return localStorage.getItem(DEVICE_READY_KEY) === "1";
}

export function markDeviceReady() {
  localStorage.setItem(DEVICE_READY_KEY, "1");
  localStorage.setItem(GPS_OK_KEY, "1");
  sessionStorage.setItem(GPS_OK_KEY, "1");
}

export function gpsWasOk() {
  return localStorage.getItem(GPS_OK_KEY) === "1" || sessionStorage.getItem(GPS_OK_KEY) === "1";
}

export async function resumeDevices(videoEl) {
  const stream = await camera.ensureStarted(videoEl);
  try {
    await camera.primeMicrophone();
  } catch {
    /* microphone may still be granted from an earlier session */
  }
  const pos = await requestLocationAccess();
  markDeviceReady();
  return { stream, pos };
}

export async function grantDevices(videoEl) {
  await camera.start(videoEl, { includeAudio: true });
  try {
    await camera.primeMicrophone();
  } catch {
    /* camera start already asked for the microphone */
  }
  const pos = await requestLocationAccess();
  markDeviceReady();
  return pos;
}

export async function locationLooksDenied() {
  return (await locationPermissionState()) === "denied";
}
