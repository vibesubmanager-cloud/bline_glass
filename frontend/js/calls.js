import { api } from "./api.js";
import { voice } from "./voice.js?v=56";
import { appState, STATES } from "./state.js";
import { getToken, getUser, getSettings, setSession } from "./config.js";
import { camera } from "./camera.js";

const IFRAME_ALLOW = "camera; microphone; display-capture; autoplay; clipboard-write; fullscreen";

function callingIdentity() {
  const user = getUser() || {};
  const settings = getSettings() || {};
  return {
    displayName: String(user.name || "vibeEye").trim() || "vibeEye",
    email: String(user.email || "").trim(),
    configured: Boolean(settings.calling_configured),
  };
}

function loadJitsi() {
  if (window.JitsiMeetExternalAPI) return Promise.resolve(window.JitsiMeetExternalAPI);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-jitsi-api]");
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.JitsiMeetExternalAPI) resolve(window.JitsiMeetExternalAPI);
        else reject(new Error("Unable to connect the call. Please try again."));
      });
      existing.addEventListener("error", () => reject(new Error("Unable to connect the call. Please try again.")));
      return;
    }
    const script = document.createElement("script");
    script.src = "https://meet.jit.si/external_api.js";
    script.async = true;
    script.dataset.jitsiApi = "1";
    const fail = setTimeout(() => reject(new Error("Unable to connect the call. Please try again.")), 15000);
    script.onload = () => {
      clearTimeout(fail);
      if (window.JitsiMeetExternalAPI) resolve(window.JitsiMeetExternalAPI);
      else reject(new Error("Unable to connect the call. Please try again."));
    };
    script.onerror = () => {
      clearTimeout(fail);
      reject(new Error("Unable to connect the call. Please try again."));
    };
    document.head.appendChild(script);
  });
}

function armIframe(parentNode) {
  const iframe = parentNode?.querySelector("iframe");
  if (!iframe) return;
  iframe.setAttribute("allow", IFRAME_ALLOW);
  iframe.setAttribute("allowfullscreen", "true");
  iframe.setAttribute("referrerpolicy", "origin");
  iframe.style.border = "0";
  iframe.style.width = "100%";
  iframe.style.height = "100%";
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
    this._jitsi = null;
    this._joined = false;
    this._spokeConnected = false;
    this._joinToken = 0;
  }

  startPolling() {
    this._connectSocket();
    loadJitsi().catch(() => undefined);
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
      const emergency = Boolean(signal.emergency);
      this.updateBanner(
        emergency
          ? `Emergency ${kind} from ${signal.from_name || "someone who needs help"}`
          : `Incoming ${kind} from ${signal.from_name || "a contact"}`
      );
      voice.speak(
        emergency
          ? `Emergency ${kind} from ${signal.from_name || "someone who needs help"}. Say call to answer.`
          : `Incoming ${kind} from ${signal.from_name || "a vibeEye user"}. Say call to answer, or stop to decline.`
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

  _jitsiHost() {
    let node = document.getElementById("jitsi-container");
    const overlay = document.getElementById("call-overlay");
    if (!node && overlay) {
      node = document.createElement("div");
      node.id = "jitsi-container";
      node.className = "jitsi-container";
      overlay.insertBefore(node, overlay.querySelector(".call-controls"));
    }
    if (node) node.innerHTML = "";
    return node;
  }

  _jitsiOptions(room, parentNode, video) {
    const { displayName, email } = callingIdentity();
    const userInfo = { displayName };
    if (email) userInfo.email = email;
    return {
      roomName: room,
      parentNode,
      width: "100%",
      height: "100%",
      userInfo,
      configOverwrite: {
        prejoinPageEnabled: false,
        prejoinConfig: {
          enabled: false,
          hideDisplayName: true,
          hideExtraJoinButtons: ["no-audio", "by-phone"],
        },
        startWithAudioMuted: false,
        startWithVideoMuted: !video,
        startAudioOnly: !video,
        disableDeepLinking: true,
        deeplinking: {
          disabled: true,
          hideLogo: true,
          desktop: { disabled: true },
          android: { disabled: true },
          ios: { disabled: true },
        },
        disableInviteFunctions: true,
        enableWelcomePage: false,
        enableClosePage: false,
        requireDisplayName: false,
        readOnlyName: true,
        disableProfile: true,
        hideEmailInSettings: true,
        disableThirdPartyRequests: true,
        analytics: { disabled: true },
        gravatar: { disabled: true },
        authentication: { enabled: false },
        enableUserRolesBasedOnToken: false,
        enableFeaturesBasedOnToken: false,
        defaultLocalDisplayName: displayName,
        notifications: [],
        toolbarButtons: ["microphone", "camera"],
        hideConferenceSubject: true,
        hideConferenceTimer: true,
        disableSelfViewSettings: true,
        lobby: { autoKnock: false, enableChat: false },
      },
      interfaceConfigOverwrite: {
        TOOLBAR_BUTTONS: ["microphone", "camera"],
        SHOW_JITSI_WATERMARK: false,
        SHOW_BRAND_WATERMARK: false,
        SHOW_WATERMARK_FOR_GUESTS: false,
        DISABLE_JOIN_LEAVE_NOTIFICATIONS: true,
        MOBILE_APP_PROMO: false,
        SHOW_CHROME_EXTENSION_BANNER: false,
        DISABLE_FOCUS_INDICATOR: true,
        DEFAULT_BACKGROUND: "#05070c",
        DISPLAY_WELCOME_PAGE_CONTENT: false,
        DISPLAY_WELCOME_FOOTER: false,
        AUTHENTICATION_ENABLE: false,
      },
      onload: () => armIframe(parentNode),
    };
  }

  _bindJitsiLifecycle(api, joinToken) {
    api.addListener("participantJoined", () => {
      if (this._joinToken !== joinToken || this._ending) return;
      this._joined = true;
      this._announceConnected();
    });
    api.addListener("videoConferenceLeft", () => {
      if (this._joinToken !== joinToken || this._ending) return;
      this.end(true);
    });
    api.addListener("participantLeft", () => {
      if (this._joinToken !== joinToken || this._ending || !this._joined) return;
      let count = 1;
      try {
        count = api.getNumberOfParticipants();
      } catch {
        count = 1;
      }
      if (count <= 1) this.end(true);
    });
    api.addListener("readyToClose", () => {
      if (this._joinToken !== joinToken || this._ending) return;
      this.end(true);
    });
  }

  async _joinJitsi(jitsi, video) {
    const room = jitsi?.room;
    const domain = jitsi?.domain || "meet.jit.si";
    if (!room) {
      throw new Error("Unable to connect the call. Please try again.");
    }
    if (video) {
      try {
        camera.stop();
      } catch {
        /* home camera may not be running */
      }
      const preview = document.getElementById("camera-preview");
      if (preview) preview.srcObject = null;
    }
    const Jitsi = await loadJitsi();
    if (this._ending) return;
    await this._leaveJitsi();
    const parentNode = this._jitsiHost();
    if (!parentNode) {
      throw new Error("Unable to connect the call. Please try again.");
    }
    const joinToken = ++this._joinToken;
    this._jitsi = new Jitsi(domain, this._jitsiOptions(room, parentNode, video));
    const api = this._jitsi;
    const { displayName, email } = callingIdentity();
    try {
      api.executeCommand("displayName", displayName);
    } catch {
      /* ignore */
    }
    if (email) {
      try {
        api.executeCommand("email", email);
      } catch {
        /* ignore */
      }
    }
    armIframe(parentNode);
    const watcher = new MutationObserver(() => armIframe(parentNode));
    watcher.observe(parentNode, { childList: true, subtree: true });
    this._bindJitsiLifecycle(api, joinToken);
    try {
      await new Promise((resolve, reject) => {
        const fail = setTimeout(() => {
          reject(new Error("Unable to connect the call. Please try again."));
        }, 35000);
        const ok = () => {
          if (this._joinToken !== joinToken || this._ending) {
            clearTimeout(fail);
            resolve();
            return;
          }
          clearTimeout(fail);
          this._joined = true;
          try {
            const others = typeof api.getNumberOfParticipants === "function" ? api.getNumberOfParticipants() : 1;
            if (others > 1) this._announceConnected();
          } catch {
            /* ignore */
          }
          resolve();
        };
        api.addListener("videoConferenceJoined", ok);
        api.addListener("conferenceFailed", () => {
          clearTimeout(fail);
          reject(new Error("Unable to connect the call. Please try again."));
        });
        api.addListener("errorOccurred", (event) => {
          const raw = String(event?.error?.message || event?.error || event?.name || "");
          if (/permission|notallowed|denied/i.test(raw)) {
            clearTimeout(fail);
            reject(
              new Error(
                video
                  ? "Camera permission is required for a video call."
                  : "Microphone permission is required for this call."
              )
            );
          }
        });
      });
    } finally {
      watcher.disconnect();
    }
  }

  _announceConnected() {
    if (this._spokeConnected || this._ending) return;
    this._spokeConnected = true;
    this.updateBanner(this.videoMode ? "Video call connected" : "Voice call connected");
    voice.speak(this.videoMode ? "Video call connected." : "Call connected.");
  }

  async _leaveJitsi() {
    this._joinToken += 1;
    const api = this._jitsi;
    this._jitsi = null;
    const wasJoined = this._joined;
    this._joined = false;
    if (!api) return wasJoined;
    try {
      api.executeCommand("hangup");
    } catch {
      /* ignore */
    }
    try {
      api.dispose();
    } catch {
      /* ignore */
    }
    const node = document.getElementById("jitsi-container");
    if (node) node.innerHTML = "";
    return wasJoined;
  }

  async start(target, { video = false, emergency = false } = {}) {
    this.startPolling();
    if (video) {
      try {
        camera.stop();
      } catch {
        /* ignore */
      }
    }
    voice.speak(video ? "Connecting video call." : "Connecting voice call.");
    await this._connectSocket();
    const data = await api("/api/calls/start", {
      method: "POST",
      body: {
        target,
        media: video ? "video" : "audio",
        emergency: Boolean(emergency),
        group: Boolean(emergency) || target === "group" || target === "emergency",
      },
    });
    this.currentCall = { ...data.call, peer_id: data.call?.callee_id };
    this.videoMode = video || ["video", "gvideo", "evideo"].includes(data.call?.call_type);
    if (data.tel_url) {
      location.href = data.tel_url;
      return data.spoken;
    }
    const ringIds = (data.ring_user_ids || []).filter(Boolean);
    if (!ringIds.length && data.call?.callee_id) ringIds.push(data.call.callee_id);
    if (!data.call?.id || !ringIds.length) {
      return data.spoken;
    }
    appState.set(STATES.CALLING);
    this.updateBanner(this.videoMode ? `Video calling ${data.contact.name}` : `Voice calling ${data.contact.name}`);
    for (const id of ringIds) {
      await this._sendSignal({
        target_user_id: id,
        call_id: data.call.id,
        signal_type: "ring",
        media: this.videoMode ? "video" : "audio",
        emergency: Boolean(data.emergency),
      });
    }
    try {
      await this._joinJitsi(data.jitsi, this.videoMode);
      this.updateBanner(this.videoMode ? `Video calling ${data.contact.name}` : `Voice calling ${data.contact.name}`);
    } catch (error) {
      await this.end(true);
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
    if (this.videoMode) {
      try {
        camera.stop();
      } catch {
        /* ignore */
      }
    }
    appState.set(STATES.CALLING);
    this.updateBanner("Connecting…");
    try {
      const data = await api("/api/calls/accept", { method: "POST", body: { call_id: incoming.call_id } });
      this.currentCall = { id: incoming.call_id, caller_id: incoming.from_user_id, peer_id: incoming.from_user_id };
      this._incoming = null;
      this.updateBanner(this.videoMode ? "Connecting video…" : "Connecting…");
      await this._joinJitsi(data.jitsi, this.videoMode);
    } catch (error) {
      await this.end(true);
      await voice.speak(error.message || "Unable to connect the call. Please try again.");
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
      this._jitsi?.executeCommand("toggleAudio");
    } catch {
      /* ignore */
    }
    return this.muted;
  }

  toggleCamera() {
    this.cameraEnabled = this.cameraEnabled !== false ? false : true;
    try {
      this._jitsi?.executeCommand("toggleVideo");
    } catch {
      /* ignore */
    }
    return this.cameraEnabled !== false;
  }

  async end(notify = true) {
    if (this._ending) return;
    this._ending = true;
    const peerId = this._peerId();
    const callId = this.currentCall?.id;
    const wasLive = Boolean(this.currentCall || this._incoming || this._joined);
    await this._leaveJitsi();
    if (notify && wasLive) {
      voice.speak("Call ended.");
    }
    if (notify && peerId && callId) {
      api("/api/calls/end", { method: "POST", body: { call_id: callId } }).catch(() => undefined);
      this._sendSignal({ target_user_id: peerId, call_id: callId, signal_type: "end" });
    } else if (callId) {
      api("/api/calls/end", { method: "POST", body: { call_id: callId } }).catch(() => undefined);
    }
    this.currentCall = null;
    this._incoming = null;
    this.videoMode = false;
    this._lastOfferId = "";
    this._spokeConnected = false;
    this.cameraEnabled = true;
    this.muted = false;
    this.updateBanner("");
    const preview = document.getElementById("camera-preview");
    if (preview) {
      camera.ensureStarted(preview).catch(() => undefined);
    }
    if (appState.value === STATES.CALLING) appState.set(STATES.IDLE);
    this._ending = false;
  }

  callingStatus() {
    return callingIdentity();
  }

  async configureCalling() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone permission is required for this call.");
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        throw new Error("Microphone permission is required for this call.");
      }
    }
    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      /* ignore */
    }
    const data = await api("/api/auth/settings", { method: "PUT", body: { calling_configured: true } });
    setSession(getToken(), getUser(), data.settings);
    return callingIdentity();
  }

  async removeCallingConfiguration() {
    const data = await api("/api/auth/settings", { method: "PUT", body: { calling_configured: false } });
    setSession(getToken(), getUser(), data.settings);
    return callingIdentity();
  }

  async testCalling({ video = false } = {}) {
    if (this.currentCall || this._incoming) {
      throw new Error("A call is already in progress.");
    }
    this.startPolling();
    appState.set(STATES.CALLING);
    this.videoMode = Boolean(video);
    this.updateBanner(video ? "Testing video calling…" : "Testing calling…");
    const room = `aidobot-call-test-${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : String(Date.now())}`;
    try {
      await this._joinJitsi({ room, domain: "meet.jit.si" }, this.videoMode);
      await this._leaveJitsi();
      if (!getSettings().calling_configured) await this.configureCalling();
      this.updateBanner("");
      if (appState.value === STATES.CALLING) appState.set(STATES.IDLE);
    } catch (error) {
      await this._leaveJitsi();
      this.updateBanner("");
      if (appState.value === STATES.CALLING) appState.set(STATES.IDLE);
      throw error;
    }
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
      overlay.classList.toggle("has-jitsi", Boolean(text) && Boolean(this._jitsi || this._joined));
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
