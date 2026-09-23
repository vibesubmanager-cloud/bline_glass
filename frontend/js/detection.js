import { camera } from "./camera.js";
import { speakOut } from "./speak-out.js";
import { detectVideo, installYolo, isYoloReady } from "./yolo-on-device.js";

export async function detectObjects({ objectName, quiet = false } = {}) {
  await camera.ensureStarted(document.getElementById("camera-preview"));
  if (await isYoloReady()) {
    const video = document.getElementById("camera-preview");
    const data = await detectVideo(video, { objectName });
    camera.lastCapture = data.sourceSize;
    return data;
  }
  if (quiet) {
    return { detections: [], spoken: "", loading: true, onDevice: true };
  }
  await installYolo();
  if (await isYoloReady()) {
    const video = document.getElementById("camera-preview");
    const data = await detectVideo(video, { objectName });
    camera.lastCapture = data.sourceSize;
    return data;
  }
  if (!quiet) await speakOut("Object detection is still loading on this phone.");
  return {
    detections: [],
    spoken: "Object detection is still loading on this phone.",
    loading: true,
    onDevice: true,
  };
}

export async function ensureOnDeviceYolo() {
  if (await isYoloReady()) return true;
  await installYolo();
  return isYoloReady();
}

export async function runDetection(options = {}) {
  const data = await detectObjects(options);
  return data.spoken || "I did not detect any objects I recognize in this view.";
}
