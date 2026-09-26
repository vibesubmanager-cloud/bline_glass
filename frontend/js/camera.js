import { isStandaloneApp } from "./location.js";

const VIDEO = { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } };
const VIDEO_ONLY = [
  { audio: false, video: VIDEO },
  { audio: false, video: { facingMode: "environment" } },
  { audio: false, video: true },
];
const AUDIO_AND_VIDEO = [
  { audio: true, video: VIDEO },
  { audio: true, video: { facingMode: "environment" } },
  { audio: true, video: true },
  ...VIDEO_ONLY,
];

class CameraService {
  constructor() {
    this.stream = null;
    this.video = null;
    this._micGranted = false;
  }

  async start(videoEl, { includeAudio = false } = {}) {
    if (!window.isSecureContext) {
      throw Object.assign(
        new Error("iPhone blocks camera on http. Open this app in Safari using the https address."),
        { code: "INSECURE_CONTEXT" }
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error("I can't access the camera."), { code: "CAMERA_UNAVAILABLE" });
    }
    this.video = videoEl || document.getElementById("camera-preview");
    if (this.video) {
      this.video.setAttribute("playsinline", "true");
      this.video.setAttribute("webkit-playsinline", "true");
      this.video.muted = true;
      this.video.autoplay = true;
      this.video.playsInline = true;
    }
    const attempts = includeAudio ? AUDIO_AND_VIDEO : VIDEO_ONLY;
    let lastError;
    for (const options of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia(options);
        if (options.audio) this._micGranted = true;
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!this.stream) {
      const denied = /notallowed|permission|denied/i.test(String(lastError?.name || lastError?.message || ""));
      const home = isStandaloneApp();
      const message = denied && home
        ? "This Home Screen app has its own camera switch. Open iPhone Settings, scroll to vibeEye, turn Camera on, then open the app again. If it still stays black, delete the Home Screen icon, open Safari, then Add to Home Screen again."
        : "I can't access the camera.";
      throw Object.assign(new Error(message), { code: "CAMERA_UNAVAILABLE", cause: lastError });
    }
    this.stream.getAudioTracks().forEach((track) => {
      this._micGranted = true;
      track.stop();
      this.stream.removeTrack(track);
    });
    if (this.video) {
      this.video.setAttribute("playsinline", "true");
      this.video.setAttribute("webkit-playsinline", "true");
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.srcObject = this.stream;
      await this.video.play().catch(() => undefined);
    }
    return this.stream;
  }

  async ensureStarted(videoEl) {
    if (this.stream && this.stream.active) {
      this.video = videoEl || this.video || document.getElementById("camera-preview");
      if (this.video && this.video.srcObject !== this.stream) {
        this.video.srcObject = this.stream;
        await this.video.play().catch(() => undefined);
      }
      return this.stream;
    }
    return this.start(videoEl);
  }

  async primeMicrophone() {
    if (this._micGranted) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error("I can't access the microphone."), { code: "MIC_UNAVAILABLE" });
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    this._micGranted = true;
    return true;
  }

  async captureBlob(quality = 0.72, maxW = 960) {
    if (!this.video || this.video.readyState < 2) {
      throw Object.assign(new Error("The camera is not ready yet."), { code: "CAMERA_UNAVAILABLE" });
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, maxW / (this.video.videoWidth || maxW));
    canvas.width = Math.round((this.video.videoWidth || 960) * scale);
    canvas.height = Math.round((this.video.videoHeight || 720) * scale);
    this.lastCapture = { width: canvas.width, height: canvas.height };
    const ctx = canvas.getContext("2d");
    ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) reject(Object.assign(new Error("I couldn't capture an image."), { code: "CAMERA_UNAVAILABLE" }));
          else resolve(blob);
        },
        "image/jpeg",
        quality
      );
    });
  }

  async waitForLiveFrame(videoEl, ms = 4500) {
    await this.ensureStarted(videoEl || document.getElementById("camera-preview"));
    const video = this.video;
    if (!video) {
      throw Object.assign(new Error("The camera is not ready yet."), { code: "CAMERA_UNAVAILABLE" });
    }
    if (video.readyState >= 2 && video.videoWidth > 8) return;
    await new Promise((resolve, reject) => {
      let settled = false;
      const fail = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error("The camera is not ready yet."), { code: "CAMERA_UNAVAILABLE" }));
      }, ms);
      const check = () => {
        if (settled) return true;
        if (video.readyState >= 2 && video.videoWidth > 8) {
          settled = true;
          clearTimeout(fail);
          resolve();
          return true;
        }
        return false;
      };
      if (check()) return;
      video.addEventListener("loadeddata", check);
      video.addEventListener("playing", check);
      const tick = () => {
        if (settled) return;
        if (check()) return;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  async captureFile({ quality = 0.72, maxW = 960 } = {}) {
    await this.waitForLiveFrame(document.getElementById("camera-preview"));
    const blob = await this.captureBlob(quality, maxW);
    return new File([blob], "capture.jpg", { type: "image/jpeg" });
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }
}

export const camera = new CameraService();
