import { camera } from "./camera.js";
import { speakOut } from "./speak-out.js";
import { detectVideo, installYolo, isYoloReady, recoverDetector } from "./yolo-on-device.js";

export async function detectObjects({ objectName } = {}) {
  await camera.ensureStarted(document.getElementById("camera-preview"));
  await installYolo();
  const video = document.getElementById("camera-preview");
  const data = await detectVideo(video, { objectName });
  camera.lastCapture = data.sourceSize;
  return data;
}

export async function ensureOnDeviceYolo() {
  try {
    await installYolo();
    return true;
  } catch {
    return isYoloReady();
  }
}

export async function resetOnDeviceYolo() {
  await recoverDetector();
  return ensureOnDeviceYolo();
}

export async function runDetection(options = {}) {
  const data = await detectObjects(options);
  return data.spoken || "I did not detect any objects I recognize in this view.";
}
