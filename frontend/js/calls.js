import { api } from "./api.js";
import { voice } from "./voice.js?v=52";
import { appState, STATES } from "./state.js";
import { getToken } from "./config.js";

class CallController {
  constructor() {
    this.pc = null;
    this.localStream = null;
    this.currentCall = null;
    this.pollTimer = null;
    this.muted = false;
    this.pendingOffer = null;
    this.videoMode = false;
  }

  startPolling() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll().catch(() => undefined), 1000);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async poll() {
    if (!getToken()) return;
    const data = await api("/api/calls/poll");
    for (const signal of data.signals || []) {
      await this.onSignal(signal, data.ice_servers);
    }
  }

  _isVideoSignal(signal) {
    return String(signal?.media || signal?.call_type || "").toLowerCase() === "video";
  }

  async onSignal(signal, iceServers) {
    if (signal.signal_type === "offer") {
      this.pendingOffer = { signal, iceServers };
      this.videoMode = this._isVideoSignal(signal);
      this._incoming = signal;
      const kind = this.videoMode ? "video call" : "voice call";
      await voice.speak(
        `Incoming ${kind} from ${signal.from_name || "a Vibe Eye user"}. Say call to answer, or stop to decline.`
      );
      this.updateBanner(`Incoming ${kind} from ${signal.from_name || "a contact"}`);
      return;
    }
    if (!this.pc) return;
    if (signal.signal_type === "answer" && signal.payload) {
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
    }
    if (signal.signal_type === "ice" && signal.payload) {
      await this.pc.addIceCandidate(signal.payload);
    }
    if (signal.signal_type === "end") {
      await this.end(false);
      await voice.speak("Call ended.");
    }
    if (signal.signal_type === "reject") {
      await this.end(false);
      await voice.speak("The other person declined the call.");
    }
  }

  async _getLocalMedia(video) {
    if (!video) {
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    const videoConstraint = {
      facingMode: { ideal: "user" },
      width: { ideal: 640 },
      height: { ideal: 480 },
    };
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: videoConstraint });
    } catch {
      return navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    }
  }

  _attachLocalPreview() {
    const localVideo = document.getElementById("local-video");
    if (!localVideo) return;
    if (this.videoMode && this.localStream) {
      localVideo.srcObject = this.localStream;
      localVideo.muted = true;
      const play = localVideo.play();
      if (play && typeof play.catch === "function") play.catch(() => {});
      localVideo.classList.remove("hidden");
    } else {
      localVideo.srcObject = null;
      localVideo.classList.add("hidden");
    }
  }

  async createPeer(iceServers, targetUserId, callId, video = false) {
    this.videoMode = Boolean(video);
    this.pc = new RTCPeerConnection({ iceServers: iceServers || [{ urls: "stun:stun.l.google.com:19302" }] });
    this.localStream = await this._getLocalMedia(video);
    this.localStream.getTracks().forEach((track) => this.pc.addTrack(track, this.localStream));
    this._attachLocalPreview();
    const remote = document.getElementById("remote-audio");
    const remoteVideo = document.getElementById("remote-video");
    this.pc.ontrack = (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      if (remote) {
        remote.srcObject = stream;
        const playAudio = remote.play();
        if (playAudio && typeof playAudio.catch === "function") playAudio.catch(() => {});
      }
      if (remoteVideo && event.track.kind === "video") {
        remoteVideo.srcObject = stream;
        remoteVideo.muted = true;
        const playVideo = remoteVideo.play();
        if (playVideo && typeof playVideo.catch === "function") playVideo.catch(() => {});
      }
    };
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        api("/api/calls/signal", {
          method: "POST",
          body: {
            target_user_id: targetUserId,
            call_id: callId,
            signal_type: "ice",
            payload: event.candidate,
            media: this.videoMode ? "video" : "audio",
          },
        }).catch(() => undefined);
      }
    };
    this.pc.onconnectionstatechange = () => {
      if (["failed", "disconnected"].includes(this.pc?.connectionState)) {
        voice.speak("The call connection failed.");
      }
    };
  }

  async start(target, { video = false } = {}) {
    await voice.speak(video ? "Connecting video call." : "Connecting voice call.");
    const data = await api("/api/calls/start", {
      method: "POST",
      body: { target, media: video ? "video" : "audio" },
    });
    this.currentCall = data.call;
    this.videoMode = data.call?.call_type === "video" || video;
    if (data.tel_url) {
      location.href = data.tel_url;
      return data.spoken;
    }
    if (!data.call.callee_id) {
      return data.spoken;
    }
    appState.set(STATES.CALLING);
    await this.createPeer(data.ice_servers, data.call.callee_id, data.call.id, this.videoMode);
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await api("/api/calls/signal", {
      method: "POST",
      body: {
        target_user_id: data.call.callee_id,
        call_id: data.call.id,
        signal_type: "offer",
        payload: offer,
        media: this.videoMode ? "video" : "audio",
      },
    });
    this.startPolling();
    this.updateBanner(this.videoMode ? `Video calling ${data.contact.name}` : `Voice calling ${data.contact.name}`);
    return data.spoken;
  }

  async acceptIncoming() {
    const incoming = this._incoming || this.pendingOffer?.signal;
    if (!incoming) {
      await voice.speak("There is no incoming call.");
      return;
    }
    this.videoMode = this._isVideoSignal(incoming);
    appState.set(STATES.CALLING);
    await api("/api/calls/accept", { method: "POST", body: { call_id: incoming.call_id } });
    await this.createPeer(this.pendingOffer?.iceServers, incoming.from_user_id, incoming.call_id, this.videoMode);
    await this.pc.setRemoteDescription(new RTCSessionDescription(incoming.payload));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await api("/api/calls/signal", {
      method: "POST",
      body: {
        target_user_id: incoming.from_user_id,
        call_id: incoming.call_id,
        signal_type: "answer",
        payload: answer,
        media: this.videoMode ? "video" : "audio",
      },
    });
    this.currentCall = { id: incoming.call_id, callee_id: incoming.from_user_id };
    this._incoming = null;
    this.updateBanner(this.videoMode ? "Video call connected" : "Voice call connected");
    await voice.speak(this.videoMode ? "Video call connected." : "Voice call connected.");
  }

  async rejectIncoming() {
    const incoming = this._incoming;
    if (!incoming) return;
    await api("/api/calls/reject", { method: "POST", body: { call_id: incoming.call_id } });
    await api("/api/calls/signal", {
      method: "POST",
      body: { target_user_id: incoming.from_user_id, call_id: incoming.call_id, signal_type: "reject" },
    });
    this._incoming = null;
    this.videoMode = false;
    this.updateBanner("");
    await voice.speak("Call declined.");
  }

  toggleMute() {
    this.muted = !this.muted;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !this.muted;
    });
    return this.muted;
  }

  toggleCamera() {
    this.cameraEnabled = this.cameraEnabled === false;
    const enabled = this.cameraEnabled !== false;
    this.localStream?.getVideoTracks().forEach((track) => {
      track.enabled = enabled;
    });
    this.pc?.getSenders().forEach((sender) => {
      if (sender.track?.kind === "video") sender.track.enabled = enabled;
    });
    return enabled;
  }

  async end(notify = true) {
    if (notify && this.currentCall?.callee_id) {
      api("/api/calls/end", { method: "POST", body: { call_id: this.currentCall.id } }).catch(() => undefined);
      api("/api/calls/signal", {
        method: "POST",
        body: { target_user_id: this.currentCall.callee_id, call_id: this.currentCall.id, signal_type: "end" },
      }).catch(() => undefined);
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.pc?.close();
    this.pc = null;
    this.localStream = null;
    this.currentCall = null;
    this._incoming = null;
    this.videoMode = false;
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
    if (appState.value === STATES.CALLING) appState.set(STATES.IDLE);
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
