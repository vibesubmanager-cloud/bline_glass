import { api } from "./api.js";
import { voice } from "./voice.js?v=55";
import { appState, STATES } from "./state.js";
import { getToken } from "./config.js";
import { camera } from "./camera.js";

function loadDaily() {
  if (window.DailyIframe) return Promise.resolve(window.DailyIframe);
  const load = (src) =>
    new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.onload = () => {
        if (window.DailyIframe) resolve(window.DailyIframe);
        else reject(new Error("Unable to start the call. Please try again."));
      };
      script.onerror = () => reject(new Error("Unable to start the call. Please try again."));
      document.head.appendChild(script);
    });
  return load("https://unpkg.com/@daily-co/daily-js@0.80.0/dist/daily-iframe.js").catch(() =>
    load("https://cdn.jsdelivr.net/npm/@daily-co/daily-js@0.80.0/dist/daily-iframe.js")
  );
}

class CallController {
  constructor() {
    this.currentCall = null;
    this.pollTimer = null;
    this.muted = false;
    this.videoMode = false;
    this._incoming = null;
    this._ending = false;
    this._lastOfferId = "";
    this.socket = null;
    this._seenSignals = new Set();
    this.cameraEnabled = true;
    this._callObject = null;
    this._joined = false;
    this._spokeConnected = false;
  }

  startPolling() {
    this._connectSocket();
    loadDaily().catch(() => undefined);
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll().catch(() => undefined), 400);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async _connectSocket() {
    if (this.socket || !getToken()) return;
    if (!window.io) {
      await new Promise((resolve) => {
        const script = document.createElement("script");
        script.src = "https://cdn.socket.io/4.7.5/socket.io.min.js";
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => resolve();
        document.head.appendChild(script);
      });
    }
    if (!window.io) return;
    try {
      const { getApiBase } = await import("./config.js");
      this.socket = window.io(getApiBase(), {
        auth: { token: getToken() },
        transports: ["polling", "websocket"],
        withCredentials: false,
      });
      this.socket.on("call-signal", (signal) => {
        this.onSignal(signal).catch(() => undefined);
      });
    } catch {
      this.socket = null;
    }
  }

  _signalKey(signal) {
    return [signal?.signal_type, signal?.call_id, signal?.from_user_id || ""].join(":");
  }

  async poll() {
    if (!getToken()) return;
    const data = await api("/api/calls/poll");
    for (const signal of data.signals || []) {
      await this.onSignal(signal);
    }
  }

  _isVideoSignal(signal) {
    return String(signal?.media || signal?.call_type || "").toLowerCase() === "video";
  }

  _peerId() {
    const call = this.currentCall || {};
    return call.peer_id || call.callee_id || call.caller_id || this._incoming?.from_user_id || "";
  }

  async _sendSignal(body) {
    const token = getToken();
    if (this.socket?.connected) {
      this.socket.emit("call-signal", { ...body, token });
    }
    await api("/api/calls/signal", { method: "POST", body }).catch(() => undefined);
  }

  async onSignal(signal) {
    const key = this._signalKey(signal);
    if (this._seenSignals.has(key)) return;
    this._seenSignals.add(key);
    const type = signal.signal_type;
    if (type === "ring" || type === "offer") {
      if (this._lastOfferId === signal.call_id && this._incoming) return;
      this._lastOfferId = signal.call_id || "";
      this.videoMode = this._isVideoSignal(signal);
      this._incoming = signal;
      const kind = this.videoMode ? "video call" : "voice call";
      this.updateBanner(`Incoming ${kind} from ${signal.from_name || "a contact"}`);
      voice.speak(
        `Incoming ${kind} from ${signal.from_name || "a Vibe Eye user"}. Say call to answer, or stop to decline.`
      );
      return;
    }
    if (type === "end") {
      const wasLive = Boolean(this.currentCall || this._incoming || this._joined);
      await this.end(false);
      if (wasLive) await voice.speak("The call has ended.");
      return;
    }
    if (type === "reject") {
      await this.end(false);
      await voice.speak("The other person declined the call.");
    }
  }

  _primePlayback() {
    const remoteVideo = document.getElementById("remote-video");
    const remoteAudio = document.getElementById("remote-audio");
    const localVideo = document.getElementById("local-video");
    if (remoteVideo) {
      remoteVideo.setAttribute("playsinline", "true");
      remoteVideo.setAttribute("webkit-playsinline", "true");
      remoteVideo.muted = true;
      remoteVideo.play()?.catch(() => undefined);
    }
    if (localVideo) {
      localVideo.setAttribute("playsinline", "true");
      localVideo.setAttribute("webkit-playsinline", "true");
      localVideo.muted = true;
    }
    if (remoteAudio) {
      remoteAudio.muted = false;
      remoteAudio.volume = 1;
      remoteAudio.play()?.catch(() => undefined);
    }
  }

  _attachTrack(track, local) {
    if (!track) return;
    const stream = new MediaStream([track]);
    if (local && track.kind === "video") {
      const localVideo = document.getElementById("local-video");
      if (!localVideo || !this.videoMode) return;
      localVideo.srcObject = stream;
      localVideo.classList.remove("hidden");
      localVideo.play()?.catch(() => undefined);
      return;
    }
    if (local) return;
    if (track.kind === "video") {
      const remoteVideo = document.getElementById("remote-video");
      if (!remoteVideo) return;
      remoteVideo.srcObject = stream;
      remoteVideo.muted = true;
      remoteVideo.play()?.catch(() => undefined);
    }
    if (track.kind === "audio") {
      const remoteAudio = document.getElementById("remote-audio");
      if (!remoteAudio) return;
      remoteAudio.srcObject = stream;
      remoteAudio.muted = false;
      remoteAudio.volume = 1;
      remoteAudio.play()?.catch(() => undefined);
    }
  }

  _bindDaily(callObject) {
    callObject.on("track-started", (event) => {
      const local = Boolean(event.participant?.local);
      this._attachTrack(event.track, local);
      if (!local && !this._spokeConnected) {
        this._spokeConnected = true;
        this.updateBanner(this.videoMode ? "Video call connected" : "Voice call connected");
        voice.speak(this.videoMode ? "Video call connected." : "Call connected.");
      }
    });
    callObject.on("participant-left", (event) => {
      if (!this._joined || this._ending) return;
      if (event.participant?.local) return;
      this.end(true).then(() => voice.speak("The call has ended."));
    });
    callObject.on("error", () => {
      if (!this._joined) return;
      this.updateBanner("Reconnecting…");
    });
    callObject.on("left-meeting", () => {
      if (!this._ending && this._joined) this.end(false);
    });
  }

  async _captureLocal(video) {
    if (video) {
      try {
        camera.stop();
      } catch {
        /* home camera may not be running */
      }
      const preview = document.getElementById("camera-preview");
      if (preview) preview.srcObject = null;
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: video ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } } : false,
      });
    } catch {
      if (video) {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        } catch {
          /* fall through */
        }
      }
      throw new Error(
        video
          ? "Camera permission is required for a video call."
          : "Microphone permission is required for a voice call."
      );
    }
  }

  async _joinDaily(daily, video, preStream) {
    if (!daily?.url || !daily?.token) {
      throw new Error("Calling is not set up yet. Add the Daily API key in Admin.");
    }
    this._primePlayback();
    preStream?.getTracks?.().forEach((track) => track.stop());
    const Daily = await loadDaily();
    if (this._callObject) {
      try {
        await this._callObject.leave();
        this._callObject.destroy();
      } catch {
        /* ignore */
      }
      this._callObject = null;
    }
    this._callObject = Daily.createCallObject({
      subscribeToTracksAutomatically: true,
      audioSource: true,
      videoSource: Boolean(video),
    });
    this._bindDaily(this._callObject);
    try {
      await this._callObject.join({
        url: daily.url,
        token: daily.token,
        startVideoOff: !video,
        startAudioOff: false,
      });
    } catch (error) {
      const raw = [error?.errorMsg, error?.error?.msg, error?.error, error?.message]
        .filter(Boolean)
        .join(" ");
      if (/permission|notallowed|denied/i.test(raw)) {
        throw new Error(
          video
            ? "Camera permission is required for a video call."
            : "Microphone permission is required for a voice call."
        );
      }
      if (/token|api key|unauthorized|not configured/i.test(raw)) {
        throw new Error("Calling is not set up yet. Add the Daily API key in Admin.");
      }
      throw new Error("Unable to start the call. Please try again.");
    }
    this._joined = true;
    this._spokeConnected = false;
  }

  async _leaveDaily() {
    const callObject = this._callObject;
    this._callObject = null;
    this._joined = false;
    if (!callObject) return;
    try {
      callObject.stopLocalVideo?.();
      callObject.stopLocalAudio?.();
    } catch {
      /* ignore */
    }
    try {
      await callObject.leave();
    } catch {
      /* ignore */
    }
    try {
      callObject.destroy();
    } catch {
      /* ignore */
    }
  }

  async start(target, { video = false } = {}) {
    this.startPolling();
    this._primePlayback();
    const localStream = await this._captureLocal(video);
    voice.speak(video ? "Connecting video call." : "Connecting voice call.");
    await this._connectSocket();
    let data;
    try {
      data = await api("/api/calls/start", {
        method: "POST",
        body: { target, media: video ? "video" : "audio" },
      });
    } catch (error) {
      localStream.getTracks().forEach((track) => track.stop());
      throw error;
    }
    this.currentCall = { ...data.call, peer_id: data.call?.callee_id };
    this.videoMode = data.call?.call_type === "video" || video;
    if (data.tel_url) {
      localStream.getTracks().forEach((track) => track.stop());
      location.href = data.tel_url;
      return data.spoken;
    }
    if (!data.call.callee_id) {
      localStream.getTracks().forEach((track) => track.stop());
      return data.spoken;
    }
    appState.set(STATES.CALLING);
    this.updateBanner(this.videoMode ? `Video calling ${data.contact.name}` : `Voice calling ${data.contact.name}`);
    try {
      await this._joinDaily(data.daily, this.videoMode, localStream);
      await this._sendSignal({
        target_user_id: data.call.callee_id,
        call_id: data.call.id,
        signal_type: "ring",
        media: this.videoMode ? "video" : "audio",
      });
    } catch (error) {
      localStream.getTracks().forEach((track) => track.stop());
      await this.end(false);
      if (data.call?.id) {
        api("/api/calls/end", { method: "POST", body: { call_id: data.call.id } }).catch(() => undefined);
      }
      throw error;
    }
    return data.spoken;
  }

  async acceptIncoming() {
    const incoming = this._incoming;
    if (!incoming) {
      await voice.speak("There is no incoming call.");
      return;
    }
    this.videoMode = this._isVideoSignal(incoming);
    this._primePlayback();
    let localStream;
    try {
      localStream = await this._captureLocal(this.videoMode);
    } catch (error) {
      await voice.speak(error.message);
      return;
    }
    appState.set(STATES.CALLING);
    this.updateBanner("Connecting…");
    try {
      const data = await api("/api/calls/accept", { method: "POST", body: { call_id: incoming.call_id } });
      this.currentCall = { id: incoming.call_id, caller_id: incoming.from_user_id, peer_id: incoming.from_user_id };
      this._incoming = null;
      await this._joinDaily(data.daily, this.videoMode, localStream);
    } catch (error) {
      localStream.getTracks().forEach((track) => track.stop());
      await this.end(true);
      await voice.speak(error.message || "Unable to start the call. Please try again.");
    }
  }

  async rejectIncoming() {
    const incoming = this._incoming;
    if (!incoming) return;
    await api("/api/calls/reject", { method: "POST", body: { call_id: incoming.call_id } }).catch(() => undefined);
    await this._sendSignal({
      target_user_id: incoming.from_user_id,
      call_id: incoming.call_id,
      signal_type: "reject",
    });
    this._incoming = null;
    this.videoMode = false;
    this.updateBanner("");
    await voice.speak("Call declined.");
  }

  toggleMute() {
    this.muted = !this.muted;
    try {
      this._callObject?.setLocalAudio(!this.muted);
    } catch {
      /* ignore */
    }
    return this.muted;
  }

  toggleCamera() {
    this.cameraEnabled = this.cameraEnabled !== false ? false : true;
    const enabled = this.cameraEnabled !== false;
    try {
      this._callObject?.setLocalVideo(enabled);
    } catch {
      /* ignore */
    }
    return enabled;
  }

  async end(notify = true) {
    if (this._ending) return;
    this._ending = true;
    const peerId = this._peerId();
    const callId = this.currentCall?.id;
    await this._leaveDaily();
    if (notify && this._joined && peerId && callId) {
      api("/api/calls/end", { method: "POST", body: { call_id: callId } }).catch(() => undefined);
      this._sendSignal({ target_user_id: peerId, call_id: callId, signal_type: "end" });
    } else if (callId && !this._joined) {
      api("/api/calls/end", { method: "POST", body: { call_id: callId } }).catch(() => undefined);
    }
    this.currentCall = null;
    this._incoming = null;
    this.videoMode = false;
    this._lastOfferId = "";
    this._spokeConnected = false;
    this.cameraEnabled = true;
    this.muted = false;
    const remote = document.getElementById("remote-audio");
    const remoteVideo = document.getElementById("remote-video");
    const localVideo = document.getElementById("local-video");
    if (remote) remote.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    if (localVideo) {
      localVideo.srcObject = null;
      localVideo.classList.add("hidden");
    }
    this.updateBanner("");
    const preview = document.getElementById("camera-preview");
    if (preview) {
      camera.ensureStarted(preview).catch(() => undefined);
    }
    if (appState.value === STATES.CALLING) appState.set(STATES.IDLE);
    this._ending = false;
  }

  updateBanner(text) {
    const banner = document.getElementById("call-banner");
    if (banner) {
      banner.textContent = text;
      banner.classList.toggle("active", Boolean(text));
    }
    const overlay = document.getElementById("call-overlay");
    if (overlay) {
      overlay.classList.toggle("hidden", !text);
      overlay.classList.toggle("is-video", Boolean(text) && this.videoMode);
      overlay.classList.toggle("is-voice", Boolean(text) && !this.videoMode);
      const status = document.getElementById("call-status-text");
      if (status) status.textContent = text;
    }
    const incoming = Boolean(this._incoming);
    document.getElementById("call-answer")?.classList.toggle("hidden", !incoming);
    document.getElementById("call-decline")?.classList.toggle("hidden", !incoming);
    document.getElementById("call-camera")?.classList.toggle("hidden", Boolean(text) && !this.videoMode);
  }
}

export const calls = new CallController();
