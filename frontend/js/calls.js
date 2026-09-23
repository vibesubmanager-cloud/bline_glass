import { api } from "./api.js";
import { voice } from "./voice.js?v=55";
import { appState, STATES } from "./state.js";
import { getApiBase, getToken } from "./config.js";
import { camera } from "./camera.js";

function signalPayload(value) {
  if (!value) return value;
  if (typeof value.candidate === "string") {
    return {
      candidate: value.candidate,
      sdpMid: value.sdpMid ?? null,
      sdpMLineIndex: value.sdpMLineIndex ?? null,
      usernameFragment: value.usernameFragment || undefined,
    };
  }
  if (typeof value.toJSON === "function") return value.toJSON();
  if (value.type && value.sdp) return { type: value.type, sdp: value.sdp };
  return value;
}

function loadSocketIo() {
  if (window.io) return Promise.resolve(window.io);
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.src = "https://cdn.socket.io/4.7.5/socket.io.min.js";
    script.async = true;
    script.onload = () => resolve(window.io || null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

function iceSummary(servers) {
  const list = servers || [];
  const stun = list.filter((item) => String(item.urls || "").startsWith("stun:")).length;
  const turn = list.filter((item) => /turn:/i.test(String(item.urls || ""))).length;
  return `ICE servers stun=${stun} turn=${turn}`;
}

class CallController {
  constructor() {
    this.pc = null;
    this.localStream = null;
    this.currentCall = null;
    this.pollTimer = null;
    this.muted = false;
    this.pendingOffer = null;
    this.videoMode = false;
    this._incoming = null;
    this._earlyIce = [];
    this._remoteReady = false;
    this._ending = false;
    this._lastOfferId = "";
    this.remoteStream = null;
    this._iceRestarts = 0;
    this._iceServers = null;
    this.socket = null;
    this._seenSignals = new Set();
    this._bridgeOn = false;
    this._bridgeTimer = 0;
    this._bridgeAudio = null;
    this._playCtx = null;
    this._playTime = 0;
    this._grabCanvas = null;
    this._logs = [];
    this._webrtcMedia = false;
    this._fallbackTimer = 0;
    this._ringTimer = 0;
    this.cameraEnabled = true;
  }

  _log(stage, extra) {
    const line = extra ? `${stage} ${extra}` : stage;
    this._logs.push(line);
    if (this._logs.length > 40) this._logs.shift();
    console.log("[CALL]", line);
    const el = document.getElementById("call-debug");
    if (el) {
      el.textContent = this._logs.slice(-14).join("\n");
      el.classList.remove("hidden");
    }
  }

  _logPc(label) {
    const pc = this.pc;
    if (!pc) {
      this._log(label, "no peer connection");
      return;
    }
    this._log(
      label,
      `ice=${pc.iceConnectionState} conn=${pc.connectionState} sig=${pc.signalingState} gather=${pc.iceGatheringState} senders=${pc.getSenders().length} receivers=${pc.getReceivers().length}`
    );
  }

  startPolling() {
    this._connectSocket();
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll().catch(() => undefined), 400);
  }

  stopPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  async _connectSocket() {
    if (this.socket) return;
    const io = await loadSocketIo();
    if (!io || !getToken()) return;
    try {
      this.socket = io(getApiBase(), {
        auth: { token: getToken() },
        transports: ["polling", "websocket"],
        withCredentials: false,
      });
      this.socket.on("call-signal", (signal) => {
        this.onSignal(signal, this._iceServers).catch(() => undefined);
      });
    } catch {
      this.socket = null;
    }
  }

  _signalKey(signal) {
    const payload = signal?.payload || {};
    return [
      signal?.signal_type,
      signal?.call_id,
      payload.type || "",
      payload.candidate || "",
      (payload.sdp || "").length,
    ].join(":");
  }

  async poll() {
    if (!getToken()) return;
    const data = await api("/api/calls/poll");
    if (data.ice_servers) this._iceServers = data.ice_servers;
    for (const signal of data.signals || []) {
      await this.onSignal(signal, data.ice_servers);
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
    this._log(`${String(body.signal_type || "signal").toUpperCase()} SENT`);
    const token = getToken();
    if (this.socket?.connected) {
      this.socket.emit("call-signal", { ...body, token });
    }
    await api("/api/calls/signal", { method: "POST", body }).catch((error) => {
      this._log("SIGNAL HTTP ERROR", error.message || "failed");
    });
  }

  async _waitIceGathered() {
    const pc = this.pc;
    if (!pc || pc.iceGatheringState === "complete") return;
    await new Promise((resolve) => {
      const finish = () => {
        pc.removeEventListener("icegatheringstatechange", onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === "complete") finish();
      };
      pc.addEventListener("icegatheringstatechange", onChange);
      setTimeout(finish, 2500);
    });
  }

  async _flushIce() {
    if (!this.pc || !this.pc.remoteDescription) return;
    const queued = this._earlyIce.splice(0, this._earlyIce.length);
    for (const candidate of queued) {
      if (!candidate?.candidate) continue;
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        this._log("ICE CANDIDATE ADDED", "queued");
      } catch (error) {
        this._log("ICE CANDIDATE ADD ERROR", error.message || "failed");
      }
    }
  }

  async onSignal(signal, iceServers) {
    if (iceServers) this._iceServers = iceServers;
    const key = this._signalKey(signal);
    if (this._seenSignals.has(key)) return;
    this._seenSignals.add(key);
    const type = signal.signal_type;
    if (type === "offer") {
      if (this._lastOfferId === signal.call_id && this._incoming) return;
      this._lastOfferId = signal.call_id || "";
      this.pendingOffer = { signal, iceServers: iceServers || this._iceServers };
      this.videoMode = this._isVideoSignal(signal);
      this._incoming = signal;
      this._log("OFFER RECEIVED");
      const kind = this.videoMode ? "video call" : "voice call";
      this.updateBanner(`Incoming ${kind} from ${signal.from_name || "a contact"}`);
      voice.speak(
        `Incoming ${kind} from ${signal.from_name || "a Vibe Eye user"}. Say call to answer, or stop to decline.`
      );
      return;
    }
    if (type === "ice" && signal.payload) {
      const payload = signal.payload;
      this._log("ICE CANDIDATE RECEIVED", payload.candidate ? payload.candidate.split(" ")[7] || "" : "empty");
      if (!payload.candidate) return;
      if (!this.pc || !this.pc.remoteDescription) {
        this._earlyIce.push(payload);
        this._log("ICE CANDIDATE QUEUED");
        return;
      }
      try {
        await this.pc.addIceCandidate(new RTCIceCandidate(payload));
        this._log("ICE CANDIDATE ADDED");
      } catch (error) {
        this._log("ICE CANDIDATE ADD ERROR", error.message || "failed");
      }
      return;
    }
    if (!this.pc) return;
    if (type === "answer" && signal.payload) {
      this._log("ANSWER RECEIVED");
      await this.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
      this._log("SET REMOTE DESCRIPTION", "answer");
      this._remoteReady = true;
      await this._flushIce();
      this._logPc("AFTER ANSWER");
      this.updateBanner("Connecting…");
    }
    if (type === "end") {
      await this.end(false);
      await voice.speak("Call ended.");
    }
    if (type === "reject") {
      await this.end(false);
      await voice.speak("The other person declined the call.");
    }
  }

  async _getLocalMedia(video) {
    if (video) {
      try {
        camera.stop();
      } catch {
        /* home camera may not be running */
      }
      const preview = document.getElementById("camera-preview");
      if (preview) preview.srcObject = null;
    }
    if (!video) {
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch {
      return navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    }
  }

  _primePlayback() {
    const remoteVideo = document.getElementById("remote-video");
    const remoteAudio = document.getElementById("remote-audio");
    if (remoteVideo) {
      remoteVideo.setAttribute("playsinline", "true");
      remoteVideo.setAttribute("webkit-playsinline", "true");
      remoteVideo.muted = true;
      remoteVideo.play()?.catch(() => undefined);
    }
    if (remoteAudio) {
      remoteAudio.setAttribute("playsinline", "true");
      remoteAudio.muted = false;
      remoteAudio.volume = 1;
      remoteAudio.play()?.catch(() => undefined);
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !this._playCtx) this._playCtx = new Ctx();
      this._playCtx?.resume?.();
    } catch {
      /* ignore */
    }
  }

  _bridgeSurface() {
    const video = document.getElementById("remote-video");
    let canvas = document.getElementById("remote-bridge");
    if (!canvas && video?.parentNode) {
      canvas = document.createElement("canvas");
      canvas.id = "remote-bridge";
      canvas.width = 480;
      canvas.height = 640;
      video.parentNode.insertBefore(canvas, video);
    }
    if (canvas) canvas.classList.toggle("hidden", !this.videoMode);
    return canvas;
  }

  _startBridge(callId) {
    if (this._webrtcMedia || this._bridgeOn || !callId || !this.localStream) return;
    this._log("HTTP MEDIA FALLBACK START");
    this._bridgeOn = true;
    this._playTime = 0;
    this._bridgeSurface();
    try {
      this._playCtx = this._playCtx || new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      this._playCtx.resume?.();
    } catch {
      this._playCtx = null;
    }
    const sendVideo = () => {
      if (!this._bridgeOn || !this.videoMode || this.cameraEnabled === false) return;
      const track = this.localStream?.getVideoTracks()?.[0];
      if (!track || track.readyState !== "live") return;
      if (!this._grabCanvas) this._grabCanvas = document.createElement("canvas");
      const canvas = this._grabCanvas;
      canvas.width = 240;
      canvas.height = 320;
      const ctx = canvas.getContext("2d");
      const local = document.getElementById("local-video");
      if (!local || !local.videoWidth) return;
      try {
        ctx.drawImage(local, 0, 0, 240, 320);
      } catch {
        return;
      }
      const data = canvas.toDataURL("image/jpeg", 0.45).split(",")[1];
      if (data) {
        api("/api/calls/media", { method: "POST", body: { call_id: callId, kind: "video", data }, timeout: 4000 }).catch(
          () => undefined
        );
      }
    };
    const sendAudio = () => {
      if (!this._bridgeOn || this.muted) return;
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(this.localStream);
      const proc = ctx.createScriptProcessor(2048, 1, 1);
      proc.onaudioprocess = (event) => {
        if (!this._bridgeOn || this.muted) return;
        const now = Date.now();
        if (now - (this._lastAudioSend || 0) < 160) return;
        this._lastAudioSend = now;
        const input = event.inputBuffer.getChannelData(0);
        const ratio = ctx.sampleRate / 16000;
        const count = Math.floor(input.length / ratio);
        const pcm = new Int16Array(count);
        for (let i = 0; i < count; i += 1) {
          const sample = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] || 0));
          pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let raw = "";
        for (let i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
        api("/api/calls/media", {
          method: "POST",
          body: { call_id: callId, kind: "audio", data: btoa(raw) },
          timeout: 4000,
        }).catch(() => undefined);
      };
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(proc);
      proc.connect(silent);
      silent.connect(ctx.destination);
      ctx.resume?.();
      this._bridgeAudio = { ctx, proc, source };
    };
    sendAudio();
    this._bridgeTimer = setInterval(async () => {
      if (!this._bridgeOn || this._webrtcMedia) return;
      sendVideo();
      try {
        const media = await api(`/api/calls/media?call_id=${encodeURIComponent(callId)}`, { timeout: 4000 });
        if (media?.video) {
          const img = new Image();
          img.onload = () => {
            const surface = this._bridgeSurface();
            if (!surface) return;
            const ctx = surface.getContext("2d");
            ctx.drawImage(img, 0, 0, surface.width, surface.height);
          };
          img.src = `data:image/jpeg;base64,${media.video}`;
        }
        if (this._playCtx && media?.audio?.length) {
          this._playCtx.resume?.();
          for (const chunk of media.audio) {
            const binary = atob(chunk);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            const pcm = new Int16Array(bytes.buffer);
            const buffer = this._playCtx.createBuffer(1, pcm.length, 16000);
            const out = buffer.getChannelData(0);
            for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 32768;
            const src = this._playCtx.createBufferSource();
            src.buffer = buffer;
            src.connect(this._playCtx.destination);
            const startAt = Math.max(this._playCtx.currentTime, this._playTime || this._playCtx.currentTime);
            src.start(startAt);
            this._playTime = startAt + buffer.duration;
          }
        }
      } catch {
        /* keep call UI */
      }
    }, 180);
  }

  _stopBridge() {
    this._bridgeOn = false;
    clearInterval(this._bridgeTimer);
    this._bridgeTimer = 0;
    try {
      this._bridgeAudio?.proc.disconnect();
      this._bridgeAudio?.source.disconnect();
      this._bridgeAudio?.ctx.close();
    } catch {
      /* ignore */
    }
    this._bridgeAudio = null;
    document.getElementById("remote-bridge")?.classList.add("hidden");
  }

  _scheduleFallback(callId) {
    clearTimeout(this._fallbackTimer);
    this._fallbackTimer = setTimeout(() => {
      if (this._ending || this._webrtcMedia) return;
      this._logPc("ICE TIMEOUT");
      this.updateBanner("Still connecting. Using backup audio and video.");
      this._startBridge(callId);
    }, 8000);
  }

  _attachLocalPreview() {
    const localVideo = document.getElementById("local-video");
    if (!localVideo) return;
    if (this.videoMode && this.localStream) {
      localVideo.srcObject = this.localStream;
      localVideo.muted = true;
      localVideo.setAttribute("playsinline", "true");
      localVideo.setAttribute("webkit-playsinline", "true");
      const play = localVideo.play();
      if (play && typeof play.catch === "function") play.catch((error) => this._log("LOCAL VIDEO PLAY ERROR", error.message));
      localVideo.classList.remove("hidden");
    } else {
      localVideo.srcObject = null;
      localVideo.classList.add("hidden");
    }
  }

  _attachRemote(stream) {
    if (!stream) return;
    const remoteAudio = document.getElementById("remote-audio");
    const remoteVideo = document.getElementById("remote-video");
    const audioTracks = stream.getAudioTracks();
    const videoTracks = stream.getVideoTracks();
    this._log(
      "REMOTE STREAM ATTACH",
      `audio=${audioTracks.length}:${audioTracks[0]?.readyState || "none"} video=${videoTracks.length}:${videoTracks[0]?.readyState || "none"}`
    );
    if (this.videoMode && remoteVideo) {
      remoteVideo.srcObject = stream;
      remoteVideo.playsInline = true;
      remoteVideo.setAttribute("playsinline", "true");
      remoteVideo.setAttribute("webkit-playsinline", "true");
      remoteVideo.muted = true;
      this._log("REMOTE VIDEO STREAM CREATED");
      const playVideo = remoteVideo.play();
      if (playVideo && typeof playVideo.then === "function") {
        playVideo
          .then(() => this._log("REMOTE VIDEO PLAY START"))
          .catch((error) => this._log("REMOTE VIDEO PLAY ERROR", error.message || String(error)));
      }
    }
    if (remoteAudio) {
      remoteAudio.srcObject = audioTracks.length ? new MediaStream(audioTracks) : stream;
      remoteAudio.muted = false;
      remoteAudio.volume = 1;
      this._log("REMOTE AUDIO STREAM CREATED");
      const playAudio = remoteAudio.play();
      if (playAudio && typeof playAudio.then === "function") {
        playAudio
          .then(() => this._log("REMOTE AUDIO PLAY START"))
          .catch((error) => this._log("REMOTE AUDIO PLAY ERROR", error.message || String(error)));
      }
    }
  }

  _addRemoteTrack(track, inboundStream) {
    this._log("REMOTE TRACK RECEIVED", `kind=${track.kind} id=${track.id} state=${track.readyState} stream=${inboundStream?.id || "none"}`);
    if (!this.remoteStream) this.remoteStream = new MediaStream();
    const already = this.remoteStream.getTracks().some((item) => item.id === track.id);
    if (!already) this.remoteStream.addTrack(track);
    if (inboundStream) {
      inboundStream.getTracks().forEach((item) => {
        if (!this.remoteStream.getTracks().some((existing) => existing.id === item.id)) {
          this.remoteStream.addTrack(item);
        }
      });
    }
    if (track.kind === "audio" || track.kind === "video") this._webrtcMedia = true;
    if (this._webrtcMedia) {
      this._stopBridge();
      clearTimeout(this._fallbackTimer);
    }
    this._attachRemote(this.remoteStream);
  }

  async createPeer(iceServers, targetUserId, callId, video = false) {
    this.videoMode = Boolean(video);
    this._remoteReady = false;
    this._webrtcMedia = false;
    this._primePlayback();
    const servers = iceServers || this._iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
    this._log("PEER CONNECTION CREATED", iceSummary(servers));
    this.pc = new RTCPeerConnection({
      iceServers: servers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    this.localStream = await this._getLocalMedia(video);
    this._log("GET USER MEDIA SUCCESS");
    this.localStream.getAudioTracks().forEach((track) => this._log("LOCAL AUDIO TRACK CREATED", track.readyState));
    this.localStream.getVideoTracks().forEach((track) => this._log("LOCAL VIDEO TRACK CREATED", track.readyState));
    this.localStream.getTracks().forEach((track) => {
      this.pc.addTrack(track, this.localStream);
    });
    this._attachLocalPreview();
    this.remoteStream = new MediaStream();
    this._iceRestarts = 0;
    this.pc.ontrack = (event) => {
      this._addRemoteTrack(event.track, event.streams?.[0]);
      this._logPc("ONTRACK");
    };
    this.pc.onicecandidate = (event) => {
      if (!targetUserId) return;
      if (!event.candidate) {
        this._log("ICE GATHERING COMPLETE");
        return;
      }
      this._log("ICE CANDIDATE CREATED", event.candidate.type || "");
      this._sendSignal({
        target_user_id: targetUserId,
        call_id: callId,
        signal_type: "ice",
        payload: signalPayload(event.candidate),
        media: this.videoMode ? "video" : "audio",
      });
    };
    this.pc.onconnectionstatechange = () => {
      this._logPc("CONNECTION STATE");
      const state = this.pc?.connectionState;
      if (state === "connected") {
        this._iceRestarts = 0;
        this._webrtcMedia = true;
        this._stopBridge();
        this._attachRemote(this.remoteStream);
        this.updateBanner(this.videoMode ? "Video call connected" : "Voice call connected");
      }
      if (state === "failed") this._recoverIce();
    };
    this.pc.oniceconnectionstatechange = () => {
      this._logPc("ICE CONNECTION STATE");
      const ice = this.pc?.iceConnectionState;
      if (ice === "connected" || ice === "completed") {
        this._webrtcMedia = true;
        this._stopBridge();
        this._attachRemote(this.remoteStream);
        this.updateBanner(this.videoMode ? "Video call connected" : "Voice call connected");
      }
      if (ice === "failed") this._recoverIce();
    };
    this.pc.onsignalingstatechange = () => this._logPc("SIGNALING STATE");
  }

  _recoverIce() {
    if (!this.pc || this._ending) return;
    if (this._iceRestarts >= 2) {
      this._logPc("ICE FAILED");
      this.updateBanner("Still trying to connect. Keep the call open.");
      if (this.currentCall?.id) this._startBridge(this.currentCall.id);
      return;
    }
    this._iceRestarts += 1;
    this.updateBanner("Reconnecting the call…");
    try {
      this.pc.restartIce();
      this._log("ICE RESTART");
    } catch {
      /* older browsers */
    }
  }

  async start(target, { video = false } = {}) {
    this._logs = [];
    this._log("CALL START", video ? "video" : "voice");
    this.startPolling();
    await this._connectSocket();
    this._primePlayback();
    await voice.speak(video ? "Connecting video call." : "Connecting voice call.");
    const data = await api("/api/calls/start", {
      method: "POST",
      body: { target, media: video ? "video" : "audio" },
    });
    this.currentCall = { ...data.call, peer_id: data.call?.callee_id };
    this.videoMode = data.call?.call_type === "video" || video;
    this._iceServers = data.ice_servers || this._iceServers;
    this._log(iceSummary(this._iceServers));
    if (data.tel_url) {
      location.href = data.tel_url;
      return data.spoken;
    }
    if (!data.call.callee_id) {
      return data.spoken;
    }
    appState.set(STATES.CALLING);
    await this.createPeer(this._iceServers, data.call.callee_id, data.call.id, this.videoMode);
    this._log("CREATE OFFER");
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this._log("SET LOCAL DESCRIPTION", "offer");
    await this._waitIceGathered();
    await this._sendSignal({
      target_user_id: data.call.callee_id,
      call_id: data.call.id,
      signal_type: "offer",
      payload: signalPayload(this.pc.localDescription),
      media: this.videoMode ? "video" : "audio",
    });
    this._log("OFFER SENT");
    this._scheduleFallback(data.call.id);
    clearTimeout(this._ringTimer);
    this._ringTimer = setTimeout(() => {
      if (this._ending || this._webrtcMedia || this.pc?.iceConnectionState === "connected") return;
      this.updateBanner("Still ringing. Keep the app open on both phones.");
    }, 20000);
    this.updateBanner(this.videoMode ? `Video calling ${data.contact.name}` : `Voice calling ${data.contact.name}`);
    return data.spoken;
  }

  async acceptIncoming() {
    const incoming = this._incoming || this.pendingOffer?.signal;
    if (!incoming) {
      await voice.speak("There is no incoming call.");
      return;
    }
    this._logs = [];
    this._log("CALL START", "accept");
    this.videoMode = this._isVideoSignal(incoming);
    this._primePlayback();
    appState.set(STATES.CALLING);
    await api("/api/calls/accept", { method: "POST", body: { call_id: incoming.call_id } });
    await this.createPeer(
      this.pendingOffer?.iceServers || this._iceServers,
      incoming.from_user_id,
      incoming.call_id,
      this.videoMode
    );
    this._log("SET REMOTE DESCRIPTION", "offer");
    await this.pc.setRemoteDescription(new RTCSessionDescription(incoming.payload));
    this._remoteReady = true;
    await this._flushIce();
    this._log("CREATE ANSWER");
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this._log("SET LOCAL DESCRIPTION", "answer");
    await this._waitIceGathered();
    await this._sendSignal({
      target_user_id: incoming.from_user_id,
      call_id: incoming.call_id,
      signal_type: "answer",
      payload: signalPayload(this.pc.localDescription),
      media: this.videoMode ? "video" : "audio",
    });
    this._log("ANSWER SENT");
    this.currentCall = { id: incoming.call_id, caller_id: incoming.from_user_id, peer_id: incoming.from_user_id };
    this._incoming = null;
    this.pendingOffer = null;
    this._scheduleFallback(incoming.call_id);
    this.updateBanner("Connecting…");
    this._attachRemote(this.remoteStream);
  }

  async rejectIncoming() {
    const incoming = this._incoming || this.pendingOffer?.signal;
    if (!incoming) return;
    await api("/api/calls/reject", { method: "POST", body: { call_id: incoming.call_id } }).catch(() => undefined);
    await this._sendSignal({
      target_user_id: incoming.from_user_id,
      call_id: incoming.call_id,
      signal_type: "reject",
    });
    this._incoming = null;
    this.pendingOffer = null;
    this._earlyIce = [];
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
    this.cameraEnabled = this.cameraEnabled !== false ? false : true;
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
    if (this._ending) return;
    this._ending = true;
    this._stopBridge();
    clearTimeout(this._fallbackTimer);
    clearTimeout(this._ringTimer);
    const peerId = this._peerId();
    const callId = this.currentCall?.id;
    if (notify && peerId) {
      api("/api/calls/end", { method: "POST", body: { call_id: callId } }).catch(() => undefined);
      this._sendSignal({ target_user_id: peerId, call_id: callId, signal_type: "end" });
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    try {
      this.pc?.close();
    } catch {
      /* already closed */
    }
    this.pc = null;
    this.localStream = null;
    this.currentCall = null;
    this._incoming = null;
    this.pendingOffer = null;
    this._earlyIce = [];
    this._remoteReady = false;
    this.videoMode = false;
    this._lastOfferId = "";
    this.remoteStream = null;
    this._iceRestarts = 0;
    this._webrtcMedia = false;
    this.cameraEnabled = true;
    const remote = document.getElementById("remote-audio");
    const remoteVideo = document.getElementById("remote-video");
    const localVideo = document.getElementById("local-video");
    if (remote) remote.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    if (localVideo) {
      localVideo.srcObject = null;
      localVideo.classList.add("hidden");
    }
    document.getElementById("call-debug")?.classList.add("hidden");
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
