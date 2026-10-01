import { getToken, pages, getSettings, getUser, tokenExpired, signOutToLogin } from "./config.js";
import { ApiError, isOnline, api } from "./api.js";
import { appState, STATES } from "./state.js";
import { voice } from "./voice.js";
import { camera } from "./camera.js";
import { interpretCommand, isAffirmative, isNegative, HELP_TEXT, smallTalkReply } from "./intent.js?v=38";
import { detectObjects, ensureOnDeviceYolo } from "./detection.js";
import { speakOut } from "./speak-out.js";
import { preloadYolo } from "./yolo-preload.js";
import { isYoloInstalled, onYoloProgress, holdDetectionAwake, releaseDetectionAwake, warmYoloIfInstalled } from "./yolo-on-device.js";
import { readScene, describeScene, askAboutScene } from "./vision.js?v=10";
import { armVisionSpeaker, speakVision } from "./vision-speak.js";
import { navigation, getCurrentPosition, locationPermissionState, requestLocationAccess } from "./navigation.js";
import { markHomeEntryOk, privacyPromptRequired } from "./entry.js";
import { calls, startOnHome, takeQueuedHomeCall } from "./calls.js?v=16";
import { activateEmergency } from "./emergency.js?v=2";
import { startMessageNotices } from "./notify.js";
import { setListeningUI, setAiStatus, setLive, setGps, setOnline, setDetectHud, drawDetections, clearDetections, drawRoute, setNavPanel, setMapVisible } from "./overlay.js";
import { walkingDirectionsOn } from "./shareLocation.js";
import { updateNavMap, clearNavMap, fitNavMap } from "./map.js";
import { loadUnread, markMessagesRead, sendChatMessage, sendChatLocation } from "./messages.js";
import { refreshBilling, canUseDescribe, PREMIUM_SPOKEN } from "./billing.js";
import { applyAppLogo } from "./branding.js";
import { markDeviceReady } from "./device-access.js";
import { syncDisclaimerAgreement } from "./disclaimer.js";

const zone = document.getElementById("interaction-zone");
const statusEl = document.getElementById("status-text");
const fallbackForm = document.getElementById("fallback-form");
const fallbackInput = document.getElementById("fallback-input");

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || "";
}

function showVoiceReply(_heard, reply) {
  setStatus(reply || "");
}

function speakThenShow(heard, spoken) {
  voice.stopListening();
  voice.unlock({ fromGesture: true });
  showVoiceReply(heard, spoken);
  speakOut(spoken, { interrupt: true, priority: 2, onStart: () => showVoiceReply(heard, spoken) });
}

appState.onChange((state) => {
  zone?.classList.toggle("is-listening", state === STATES.LISTENING);
  zone?.classList.toggle("is-processing", state === STATES.PROCESSING);
  zone?.classList.toggle("is-error", state === STATES.ERROR);
  zone?.classList.toggle("is-detecting", detectionMode);
  setListeningUI(state === STATES.LISTENING);
  if (state === STATES.PROCESSING) setAiStatus("AI is analyzing...");
  else if (state !== STATES.DETECTING) setAiStatus("");
});

function requireAuth() {
  try {
    if (sessionStorage.getItem("NYOTA_JUST_SIGNED_OUT") === "1") return false;
  } catch {
    /* session storage is optional */
  }
  if (tokenExpired()) {
    signOutToLogin();
    return false;
  }
  if (!getToken()) {
    location.href = pages().welcome;
    return false;
  }
  if (getUser()?.role === "assistant") {
    location.href = pages().contacts;
    return false;
  }
  return true;
}

async function handleCommand(text) {
  if (pendingDelete) {
    if (isAffirmative(text)) {
      const pending = pendingDelete;
      pendingDelete = null;
      try {
        await api(`/api/contacts/${pending.id}`, { method: "DELETE" });
        await voice.speak(`I deleted ${pending.name}.`);
      } catch (error) {
        await voice.speak(error.message || "I could not delete that contact.");
      }
      return;
    }
    if (isNegative(text)) {
      pendingDelete = null;
      await voice.speak("Okay. I will not delete anyone.");
      return;
    }
    await voice.speak(`Please say yes or no. Are you sure I can delete ${pendingDelete.name}?`);
    return;
  }
  if (pendingMessage && isNegative(text)) {
    pendingMessage = null;
    await voice.speak("Okay. I will not send that message.");
    return;
  }
  if (pendingMessage && text) {
    const pending = pendingMessage;
    pendingMessage = null;
    await sendChatAndSpeak({ type: "text", target: pending.target, body: text });
    return;
  }
  if (pendingLocationShare) {
    if (isAffirmative(text)) {
      const pending = pendingLocationShare;
      pendingLocationShare = null;
      await shareAndSpeak(pending);
      return;
    }
    if (isNegative(text)) {
      pendingLocationShare = null;
      await voice.speak("Okay. I will not send your location.");
      return;
    }
    await voice.speak("Please say yes or no.");
    return;
  }
  const chat = smallTalkReply(text);
  if (chat) {
    setAiStatus("");
    showVoiceReply(text, chat);
    if (!voice.consumeInstantChat(text)) await voice.speak(chat);
    return;
  }
  showVoiceReply(text, "Okay.");
  let parsed;
  try {
    parsed = await interpretCommand(text);
  } catch (error) {
    if (error?.code === "SESSION_ENDED") return;
    const message = error.message || "I could not understand that. Please try again.";
    showVoiceReply(text, message);
    await voice.speak(message);
    return;
  }
  if (parsed?.spoken) showVoiceReply(text, parsed.spoken);
  await executeCommand(parsed, text);
}

async function executeCommand(parsed, text) {
  parsed = parsed || {};
  parsed.slots = parsed.slots || {};
  if (parsed.intent === "REPLY" || parsed.intent === "UNKNOWN") {
    const spoken = parsed.spoken || "I'm here. Tell me what you need.";
    showVoiceReply(text, spoken);
    await voice.speak(spoken);
    return;
  }
  if (parsed.intent === "REPEAT") {
    await voice.speak(appState.lastSpoken || "I have nothing to repeat yet.");
    return;
  }
  if (parsed.intent === "HELP") {
    await voice.speak(HELP_TEXT);
    return;
  }
  if (parsed.intent === "CALLING_SETTINGS") {
    location.href = `${pages().settings}#calling`;
    return;
  }
  if (parsed.intent === "CONFIGURE_CALLING") {
    location.href = `${pages().settings}#calling`;
    return;
  }
  if (parsed.intent === "TEST_CALLING") {
    location.href = `${pages().settings}#calling`;
    return;
  }
  if (parsed.intent === "SETTINGS") {
    location.href = pages().settings;
    return;
  }
  if (parsed.intent === "STOP") {
    if (calls.currentCall || calls._incoming) {
      if (calls._incoming) await calls.rejectIncoming();
      else {
        await calls.end(true);
        await voice.speak("Call ended.");
      }
      return;
    }
    if (pendingMessage || pendingDelete) {
      pendingMessage = null;
      pendingDelete = null;
      await voice.speak("Cancelled.");
      return;
    }
    if (navigation.active) {
      await navigation.stop(true);
      return;
    }
    if (detectionMode) {
      await stopDetection("Object detection stopped.");
      return;
    }
    await voice.speak("Nothing to stop.");
    return;
  }
  if (parsed.intent === "CLOSE_MAP") {
    if (!navigation.active) {
      await voice.speak("The map is not open.");
      return;
    }
    setMapVisible(false);
    await voice.speak("Map closed. Tap the screen and say show the map if you want it back.");
    return;
  }
  if (parsed.intent === "SHOW_MAP") {
    if (!walkingDirectionsOn()) {
      await voice.speak("Walking directions are off in settings. You can send your location to a family member instead.");
      return;
    }
    if (!navigation.active) {
      await voice.speak("You are not navigating right now. Say take me to a place.");
      return;
    }
    setMapVisible(true);
    setTimeout(() => fitNavMap(), 120);
    await voice.speak(navigation.briefStatus());
    return;
  }
  if (parsed.intent === "NAV_STATUS") {
    if (!navigation.active) {
      await voice.speak("You are not navigating right now.");
      return;
    }
    setMapVisible(true);
    setTimeout(() => fitNavMap(), 120);
    await voice.speak(navigation.briefStatus());
    return;
  }
  if (parsed.intent === "EMERGENCY") {
    const spoken = await activateEmergency();
    await voice.speak(spoken);
    return;
  }
  if (parsed.intent === "EMERGENCY_SEND_MESSAGE") {
    let body = parsed.slots.body;
    if (!body) body = await listenForNext("Okay. Say the emergency message.");
    if (!body || isNegative(body)) {
      await voice.speak("Okay. I will not send that.");
      return;
    }
    await sendChatAndSpeak({ type: "text", body: `EMERGENCY. ${body}`, emergency: true });
    return;
  }
  if (parsed.intent === "EMERGENCY_SEND_PHOTO") {
    await voice.speak("Okay. Taking a picture from the camera now.");
    try {
      const file = await camera.captureFile();
      await sendChatAndSpeak({ type: "image", file, body: "I need help now.", emergency: true });
    } catch (error) {
      await voice.speak(error.message || "I could not take that picture.");
    }
    return;
  }
  if (parsed.intent === "EMERGENCY_SEND_LOCATION") {
    try {
      const pos = await getCurrentPosition();
      await sendChatAndSpeak({
        type: "location",
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        body: "I need help now.",
        emergency: true,
      });
    } catch (error) {
      await voice.speak(error.message || "I could not send that map.");
    }
    return;
  }
  if (parsed.intent === "WHERE_AM_I") {
    const spoken = await navigation.whereAmI();
    await voice.speak(spoken);
    return;
  }
  if (parsed.intent === "HOW_FAR") {
    if (!navigation.active) {
      await voice.speak("You are not navigating right now.");
      return;
    }
    const pos = await getCurrentPosition();
    const remaining = navigation.remainingDistance({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
    });
    await voice.speak(
      remaining != null
        ? `About ${formatDistance(remaining)} remaining.`
        : "I do not have a reliable remaining distance yet."
    );
    return;
  }
  if (parsed.intent === "NEXT_TURN") {
    await voice.speak(navigation.nextInstruction());
    return;
  }
  if (parsed.intent === "CALL" || parsed.intent === "VOICE_CALL" || parsed.intent === "VIDEO_CALL") {
    if (calls._incoming) {
      await calls.acceptIncoming();
      return;
    }
    const target = parsed.slots.target || "group";
    const video = parsed.intent === "VIDEO_CALL";
    try {
      const spoken = await startOnHome(parsed.slots.broadcast ? "group" : target, { video });
      await voice.speak(spoken);
    } catch (error) {
      await voice.speak(error.message || (video ? "I could not start that video call." : "I could not start that call."));
    }
    return;
  }
  if (parsed.intent === "SEND_MESSAGE") {
    const target = parsed.slots.target || "";
    let body = parsed.slots.body;
    if (!body) {
      body = await listenForNext("Okay. Say the message.");
    }
    if (!body || isNegative(body)) {
      await voice.speak(body && isNegative(body) ? "Okay. I will not send that message." : "I did not catch a message.");
      return;
    }
    await sendChatAndSpeak({ type: "text", target, body });
    return;
  }
  if (parsed.intent === "SEND_PHOTO") {
    const target = parsed.slots.target || "";
    await voice.speak("Okay. Taking a picture.");
    try {
      const file = await camera.captureFile();
      await sendChatAndSpeak({ type: "image", target, file });
    } catch (error) {
      await voice.speak(error.message || "I could not take that picture.");
    }
    return;
  }
  if (parsed.intent === "DELETE_CONTACT") {
    let id = parsed.slots.contact_id;
    let name = parsed.slots.target;
    if (!id && name) {
      try {
        const data = await api("/api/contacts");
        const query = name.toLowerCase();
        const match = (data.contacts || []).find((item) => {
          const label = `${item.name || ""} ${item.relationship || ""}`.toLowerCase();
          return label.includes(query) || query.includes((item.name || "").toLowerCase());
        });
        if (match) {
          id = match.id;
          name = match.name;
        }
      } catch {
        /* ask anyway */
      }
    }
    if (!name && !id) {
      await voice.speak("Who should I delete?");
      return;
    }
    pendingDelete = { id, name: name || "that contact" };
    await voice.speak(`Are you sure I can delete ${pendingDelete.name}? Say yes or no.`);
    return;
  }
  if (parsed.intent === "READ_MESSAGES") {
    const data = await loadUnread();
    const items = data.messages || [];
    if (!items.length) {
      await voice.speak("You have no new messages.");
      return;
    }
    for (const item of items) {
      await voice.speak(item.spoken);
    }
    await markMessagesRead(items.map((item) => item.message.id));
    return;
  }
  if (parsed.intent === "SEND_LOCATION") {
    pendingLocationShare = null;
    await shareAndSpeak({ target: parsed.slots.target, destination: parsed.slots.destination });
    return;
  }
  if (parsed.intent === "NAVIGATE") {
    const destination = parsed.slots.destination;
    if (!destination) {
      await voice.speak("Where should I take you?");
      return;
    }
    if (!walkingDirectionsOn()) {
      pendingLocationShare = { destination };
      await voice.speak(
        `Walking directions are off. Can I send your location to a family member so they can help you get to ${destination}? Say yes, or say send this to my brother.`
      );
      return;
    }
    const spoken = await navigation.start(destination);
    await voice.speak(spoken);
    return;
  }

    if (parsed.intent === "DETECT_OBJECTS") {
      try {
        await ensureOnDeviceYolo();
      } catch {
        /* server fallback if the phone cannot store YOLO */
      }
      const signal = appState.beginRequest();
      try {
        const data = await detectObjects({ objectName: parsed.slots.object, signal });
        drawDetections(
          document.getElementById("detect-canvas"),
          document.getElementById("camera-preview"),
          data.detections || [],
          camera.lastCapture || data.sourceSize
        );
        const spoken = data.spoken || "I did not detect any objects I recognize in this view.";
        setStatus(spoken);
        await speakOut(spoken, { interrupt: true });
      } finally {
        if (appState.value === STATES.PROCESSING) {
          appState.set(detectionMode ? STATES.DETECTING : STATES.IDLE);
        }
      }
      return;
    }

  if (!isOnline()) {
    await speakOut("Describe, read, and calling need internet. Camera and object detection still work.");
    return;
  }

  if (parsed.intent === "READ" || parsed.intent === "DESCRIBE" || parsed.intent === "VISUAL_QUESTION") {
    if (!canUseDescribe()) {
      appState.set(detectionMode ? STATES.DETECTING : STATES.IDLE);
      setAiStatus("");
      setStatus(PREMIUM_SPOKEN);
      showVoiceReply(text, PREMIUM_SPOKEN);
      voice.restoreSpeaker();
      await speakOut(PREMIUM_SPOKEN, { interrupt: true, priority: 2 });
      location.href = pages().plans;
      return;
    }
  }

  const signal = appState.beginRequest();
  try {
    /* DO NOT CHANGE describe, read, or photo questions below. This path is working. Leave it alone. */
    if (parsed.intent === "READ" || parsed.intent === "DESCRIBE" || parsed.intent === "VISUAL_QUESTION") {
      voice.muteBackground(true);
      armVisionSpeaker();
      const looking = parsed.intent === "READ" ? "Reading the page..." : parsed.intent === "DESCRIBE" ? "Looking in front of you..." : "AI is looking...";
      const cue = parsed.intent === "READ" ? "Okay. Reading the page in front of the camera." : "Okay. Looking in front of you.";
      setAiStatus(looking);
      try {
        await speakVision(cue);
        const spoken =
          parsed.intent === "READ"
            ? await readScene(signal)
            : parsed.intent === "DESCRIBE"
              ? await describeScene(signal)
              : await askAboutScene(text, signal);
        setAiStatus("");
        appState.set(detectionMode ? STATES.DETECTING : STATES.IDLE);
        setStatus(spoken);
        showVoiceReply(text, spoken);
        await speakVision(spoken);
      } catch (error) {
        if (error?.code === "SESSION_ENDED") return;
        setAiStatus("");
        const message = error.message || "I could not see that. Please try again.";
        setStatus(message);
        showVoiceReply(text, message);
        await speakVision(message);
      } finally {
        const popup = document.getElementById("turn-on-popup");
        if (!popup || popup.classList.contains("hidden")) voice.muteBackground(false);
      }
      return;
    }
    await voice.speak(parsed.spoken || "I didn't catch that. Please say it again.");
  } finally {
    if (appState.value === STATES.PROCESSING) {
      appState.set(detectionMode ? STATES.DETECTING : STATES.IDLE);
    }
  }
}

function formatDistance(meters) {
  if (meters == null) return "an unknown distance";
  if (meters < 10) return "a few meters";
  if (meters < 1000) return `${Math.round(meters)} meters`;
  return `${(meters / 1000).toFixed(1)} kilometers`;
}

const HOLD_MS = 500;
const DOUBLE_TAP_MS = 320;
let detectionMode = false;
let detectionRaf = 0;
let detectionBusy = false;
let lastDetectionSpoken = "";
let lastDetectionSpeakAt = 0;
let holdTimer = null;
let holdTalking = false;
let tapListenTimer = null;
let lastShortTapAt = 0;
let pointerDownAt = 0;
let pointerIsDown = false;
let listenCue = false;
let tapListening = false;
let emergencyArmedUntil = 0;
let heldSpeech = "";
const homeActionRunning = new Set();
let pendingLocationShare = null;
let pendingMessage = null;
let pendingDelete = null;
const heardMessageIds = new Set();

async function listenForNext(prompt) {
  await voice.speak(prompt);
  return listenNow();
}

async function listenNow() {
  if (!voice.listeningSupported()) return "";
  tapListening = true;
  setListeningUI(true);
  setStatus("Listening...");
  showVoiceReply("", "Listening...");
  try {
    const text = await voice.listen();
    return (text || "").trim();
  } catch {
    return "";
  } finally {
    tapListening = false;
    setListeningUI(false);
    voice.unlock({ fromGesture: true });
    voice.restoreSpeaker();
  }
}

async function shareAndSpeak({ target, destination } = {}) {
  await voice.speak("Okay. Sending your location.");
  try {
    const data = await sendChatLocation({ target });
    const spoken = destination
      ? `${data.spoken} They can help you get to ${destination}.`
      : data.spoken || "Done. I have sent your location.";
    showVoiceReply("", spoken);
    setStatus(spoken);
    await voice.speak(spoken);
  } catch (error) {
    const spoken = error.message || "I could not send your location.";
    setStatus(spoken);
    await voice.speak(spoken);
  }
}

async function sendChatAndSpeak(payload) {
  try {
    const data = await sendChatMessage(payload);
    const spoken = data.spoken || "Done. I have sent it.";
    showVoiceReply("", spoken);
    setStatus(spoken);
    await voice.speak(spoken);
    return data;
  } catch (error) {
    const spoken = error.message || "I could not send that.";
    setStatus(spoken);
    await voice.speak(spoken);
    return null;
  }
}

async function announceUnread() {
  try {
    const data = await loadUnread();
    for (const item of data.messages || []) {
      const id = item.message?.id;
      if (!id || heardMessageIds.has(id)) continue;
      heardMessageIds.add(id);
      await voice.speak(item.spoken, { interrupt: false });
    }
  } catch {
    /* keep camera flow going */
  }
}

function zoneLabel() {
  if (holdTalking || tapListening) return "Listening...";
  if (detectionMode) return "Object detection on. Double tap to stop.";
  return "";
}

function idleStatus() {
  setStatus(zoneLabel());
  setAiStatus("");
}

function detectionSignature(detections) {
  const counts = {};
  (detections || [])
    .filter((item) => (item.confidence || 0) >= 0.4)
    .forEach((item) => {
      const label = String(item.label || "object").toLowerCase();
      counts[label] = (counts[label] || 0) + 1;
    });
  const keys = Object.keys(counts).sort();
  if (!keys.length) return "empty";
  return keys.map((key) => `${key}:${counts[key]}`).join("|");
}

function announceDetections(detections, spoken) {
  const signature = detectionSignature(detections);
  if (signature === lastDetectionSpoken) return;
  lastDetectionSpoken = signature;
  lastDetectionSpeakAt = Date.now();
  if (signature === "empty") {
    setStatus("");
    return;
  }
  const phrase = spoken || "You see something in front of you.";
  setStatus(phrase);
  voice.restoreSpeaker();
  speakOut(phrase, { interrupt: false, priority: 1 });
}

function scheduleDetectionLoop() {
  if (!detectionMode) return;
  detectionRaf = requestAnimationFrame(() => {
    detectionLoop();
  });
}

async function detectionLoop() {
  if (!detectionMode) return;
  if (document.visibilityState === "hidden") {
    scheduleDetectionLoop();
    return;
  }
  if (detectionBusy) {
    scheduleDetectionLoop();
    return;
  }
  detectionBusy = true;
  try {
    const data = await detectObjects({ quiet: true });
    if (!detectionMode) return;
    setDetectHud("live");
    drawDetections(
      document.getElementById("detect-canvas"),
      document.getElementById("camera-preview"),
      data.detections || [],
      camera.lastCapture || data.sourceSize
    );
    announceDetections(data.detections || [], data.spoken);
  } catch (error) {
    if (!detectionMode) return;
    /* Skip a slow frame. Do not reload the detector — that is what made LOAD appear on every tap. */
  } finally {
    detectionBusy = false;
    if (detectionMode) scheduleDetectionLoop();
  }
}

async function startDetection() {
  detectionMode = true;
  lastDetectionSpoken = "";
  lastDetectionSpeakAt = 0;
  zone?.classList.add("is-detecting");
  appState.set(STATES.DETECTING);
  idleStatus();
  if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
  setDetectHud(isYoloInstalled() ? "live" : "loading");
  holdDetectionAwake();
  voice.unlock({ fromGesture: true });
  voice.keepAlive(true);
  try {
    await camera.ensureStarted(document.getElementById("camera-preview"));
  } catch (error) {
    detectionMode = false;
    zone?.classList.remove("is-detecting");
    paintDetectButton();
    releaseDetectionAwake();
    await handleFailure(error);
    return;
  }
  if (!isYoloInstalled()) {
    try {
      await ensureOnDeviceYolo();
    } catch (error) {
      setStatus(error.message || "Object detection is still loading.");
    }
  }
  if (!detectionMode) return;
  setDetectHud("live");
  paintDetectButton();
  scheduleDetectionLoop();
}

async function stopDetection(message = "Object detection stopped.") {
  detectionMode = false;
  lastDetectionSpoken = "";
  cancelAnimationFrame(detectionRaf);
  detectionRaf = 0;
  detectionBusy = false;
  zone?.classList.remove("is-detecting");
  clearDetections(document.getElementById("detect-canvas"));
  releaseDetectionAwake();
  voice.keepAlive(true);
  if (appState.value === STATES.DETECTING) appState.set(STATES.IDLE);
  idleStatus();
  setDetectHud("ready");
  if (message) speakOut(message);
  paintDetectButton();
}

function paintDetectButton() {
  const button = document.querySelector('.home-action[data-action="detect"]');
  if (button) button.textContent = detectionMode ? "Detection on" : "Detection";
}

async function toggleDetection() {
  if (holdTalking || tapListening) return;
  if (detectionMode) await stopDetection("");
  else await startDetection();
}

function popupIsOpen() {
  const popup = document.getElementById("turn-on-popup");
  return Boolean(popup && !popup.classList.contains("hidden"));
}

async function runHomeAction(action) {
  if (popupIsOpen() || !requireAuth()) return;
  voice.unlock({ fromGesture: true });
  if (holdTalking) {
    holdTalking = false;
    voice.finishHoldListen();
    setListeningUI(false);
  }
  if (action === "emergency") {
    const now = Date.now();
    if (now > emergencyArmedUntil) {
      emergencyArmedUntil = now + 4000;
      setStatus("Press Emergency again.");
      voice.speak("Press Emergency again.");
      return;
    }
    emergencyArmedUntil = 0;
    try {
      const spoken = await activateEmergency();
      if (spoken) voice.speak(spoken);
    } catch (error) {
      voice.speak(error.message || "I could not start the emergency.");
    }
    return;
  }
  /* Detection stays. One press starts it now. The next press stops it. Do not remove this. */
  if (action === "detect") {
    if (detectionMode) {
      stopDetection("");
      setStatus("Detection stopped.");
      voice.speak("Detection stopped.");
    } else {
      setStatus("Detection.");
      voice.speak("Detection.");
      startDetection();
      paintDetectButton();
    }
    return;
  }
  if (homeActionRunning.has(action)) return;
  homeActionRunning.add(action);
  if (navigator.vibrate) navigator.vibrate(20);
  try {
    if (action === "describe") {
      setStatus("Describe.");
      await executeCommand({ intent: "DESCRIBE", slots: {} }, "describe what is in front of me");
      return;
    }
    if (action === "read") {
      setStatus("Read.");
      await executeCommand({ intent: "READ", slots: {} }, "read this");
      return;
    }
    if (action === "where") {
      setStatus("Current location.");
      const spoken = await navigation.whereAmI();
      setStatus(spoken);
      voice.speak(spoken);
      return;
    }
    if (action === "message") {
      setStatus("Say the message for your family.");
      const body = await listenNow();
      if (!body || isNegative(body)) {
        voice.speak(body && isNegative(body) ? "Okay. I will not send that message." : "I did not catch a message.");
        return;
      }
      await sendChatAndSpeak({ type: "text", body });
      return;
    }
    if (action === "photo") {
      setStatus("Send a photo.");
      const file = await camera.captureFile();
      await sendChatAndSpeak({ type: "image", file });
      return;
    }
    if (action === "location") {
      setStatus("Sending your location.");
      const data = await sendChatLocation({});
      const spoken = data.spoken || "Done. I have sent your location.";
      setStatus(spoken);
      voice.speak(spoken);
      return;
    }
    if (action === "video") {
      setStatus("Video call.");
      const spoken = await startOnHome("group", { video: true });
      if (spoken) voice.speak(spoken);
      return;
    }
    if (action === "pause") {
      if (heldSpeech) {
        const line = heldSpeech;
        heldSpeech = "";
        const pauseBtn = document.querySelector('.home-action[data-action="pause"]');
        if (pauseBtn) pauseBtn.textContent = "Pause";
        setStatus("Playing.");
        await voice.speak(line);
        return;
      }
      if (voice.isSpeaking()) {
        const shown = (statusEl?.textContent || "").trim();
        heldSpeech = shown && shown !== "Paused." ? shown : appState.lastSpoken || "";
        voice.stopSpeaking();
        const pauseBtn = document.querySelector('.home-action[data-action="pause"]');
        if (pauseBtn) pauseBtn.textContent = "Play";
        setStatus("Paused.");
        await voice.speak("Paused.");
        return;
      }
      await voice.speak("Nothing is speaking.");
    }
  } catch (error) {
    if (error?.code === "SESSION_ENDED") return;
    voice.speak(error.message || "That did not work. Please try again.");
  } finally {
    homeActionRunning.delete(action);
  }
}

function bindHomeActions() {
  const box = document.getElementById("home-actions");
  if (!box || box.dataset.bound === "1") return;
  box.dataset.bound = "1";
  box.querySelectorAll(".home-action").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      runHomeAction(button.dataset.action);
    });
  });
}

async function beginHoldTalk() {
  if (holdTalking || tapListening || listenCue) return;
  clearTimeout(tapListenTimer);
  listenCue = true;
  setListeningUI(true);
  setStatus("Listening mode. You can speak.");
  showVoiceReply("", "Listening mode. You can speak.");
  if (navigator.vibrate) navigator.vibrate(40);
  try {
    await voice.speak("Listening mode. You can speak.");
  } catch {
    /* still open the microphone */
  }
  listenCue = false;
  if (!pointerIsDown) {
    setListeningUI(false);
    await startTapListen();
    return;
  }
  holdTalking = true;
  try {
    if (!voice.listeningSupported()) {
      holdTalking = false;
      setListeningUI(false);
      fallbackForm?.classList.remove("hidden");
      fallbackInput?.focus();
      return;
    }
    await voice.startHoldListen();
  } catch (error) {
    holdTalking = false;
    setListeningUI(false);
    await handleFailure(error);
  }
}

async function startTapListen() {
  if (holdTalking || tapListening) return;
  tapListening = true;
  voice.stopSpeaking();
  setListeningUI(true);
  setStatus("Listening...");
  showVoiceReply("", "Listening...");
  if (navigator.vibrate) navigator.vibrate(30);
  try {
    if (!voice.listeningSupported()) {
      tapListening = false;
      setListeningUI(false);
      fallbackForm?.classList.remove("hidden");
      fallbackInput?.focus();
      return;
    }
    const text = await voice.listen();
    tapListening = false;
    setListeningUI(false);
    voice.unlock({ fromGesture: true });
    voice.restoreSpeaker();
    if (text) {
      setStatus(text);
      showVoiceReply(text, "…");
      await handleCommand(text);
    } else {
      showVoiceReply("", "I did not hear that. Tap and say it again.");
      idleStatus();
    }
  } catch (error) {
    tapListening = false;
    setListeningUI(false);
    await handleFailure(error);
  }
}

function onZonePointerDown(event) {
  if (event.button != null && event.button !== 0) return;
  event.preventDefault();
  if (!requireAuth()) return;
  voice.unlock({ fromGesture: true });
  try {
    zone.setPointerCapture(event.pointerId);
  } catch {
    /* not all browsers */
  }
  pointerIsDown = true;
  pointerDownAt = Date.now();
  if (pointerDownAt - lastShortTapAt < DOUBLE_TAP_MS) {
    lastShortTapAt = 0;
    clearTimeout(holdTimer);
    clearTimeout(tapListenTimer);
    holdTimer = null;
    const turningOn = !detectionMode;
    speakOut(turningOn ? "Object detection started. I will say what I see." : "Object detection stopped.");
    toggleDetection();
    return;
  }
  holdTimer = setTimeout(() => {
    holdTimer = null;
    lastShortTapAt = 0;
    clearTimeout(tapListenTimer);
    beginHoldTalk();
  }, HOLD_MS);
}

function onZonePointerUp(event) {
  event.preventDefault();
  pointerIsDown = false;
  voice.unlock({ fromGesture: true });
  if (listenCue) return;
  const held = Date.now() - pointerDownAt;
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (held < HOLD_MS) {
      lastShortTapAt = Date.now();
    }
    return;
  }
  if (holdTalking) endHoldTalk();
}

async function endHoldTalk() {
  if (!holdTalking) return;
  holdTalking = false;
  setListeningUI(false);
  const text = voice.finishHoldListen();
  voice.unlock({ fromGesture: true });
  if (text) {
    voice.speak("Okay.", { interrupt: true, priority: 0 });
    setStatus(text);
    try {
      await handleCommand(text);
    } catch (error) {
      await handleFailure(error);
    }
  } else {
    showVoiceReply("", "I did not hear that. Hold and say it again.");
    idleStatus();
  }
  if (detectionMode) holdDetectionAwake();
}

async function handleFailure(error) {
  appState.set(STATES.ERROR);
  const code = error.code || (error instanceof ApiError ? error.code : "UNKNOWN");
  const message =
    error instanceof ApiError
      ? error.message
        : code === "GPS_DENIED" || code === "GPS_UNAVAILABLE"
        ? error.message
        : code === "INSECURE_CONTEXT"
        ? "iPhone blocks camera and microphone on http. Open the https Safari link on this page."
        : code === "CAMERA_IN_USE" || code === "MIC_IN_USE"
        ? error.message
        : code === "CAMERA_UNAVAILABLE"
        ? "I can't access the camera."
        : code === "MIC_UNAVAILABLE"
          ? "I can't access the microphone."
          : code === "SPEECH_UNAVAILABLE"
            ? "Speech recognition is not available in this browser. Type your command instead."
            : error.message || "I couldn't complete that request. Please try again.";
  await voice.speak(message, {
    interrupt: true,
    onStart: () => {
      setStatus(message);
      showVoiceReply("", message);
    },
  });
  setStatus(message);
  showVoiceReply("", message);
  appState.set(detectionMode ? STATES.DETECTING : STATES.IDLE);
  if (code === "PREMIUM_REQUIRED") {
    location.href = pages().plans;
  }
}

function applyAppearance() {
  const settings = getSettings();
  document.body.classList.toggle("high-contrast", Boolean(settings.high_contrast));
}

function markGps(on, position) {
  setGps(on);
  if (on && position?.coords) {
    localStorage.setItem("AISIGHT_GPS_OK", "1");
    sessionStorage.setItem("AISIGHT_GPS_OK", "1");
  }
}

async function startCameraNow() {
  const preview = document.getElementById("camera-preview");
  if (!preview) return false;
  try {
    await camera.ensureStarted(preview);
    setLive(true);
    return true;
  } catch {
    setLive(false);
    return false;
  }
}

const turnOnReady = { camera: false, voice: false, gps: false };
const turnOnBusy = { camera: false, voice: false, gps: false };
let gpsTurnOn = null;

function setTurnOnStatus(text) {
  const status = document.getElementById("turn-on-status");
  if (status) status.textContent = text;
}

function paintTurnOn() {
  const cameraBtn = document.getElementById("enable-camera");
  const voiceBtn = document.getElementById("enable-voice");
  const gpsBtn = document.getElementById("enable-gps");
  const continueBtn = document.getElementById("turn-on-continue");
  if (!cameraBtn || !voiceBtn || !gpsBtn || !continueBtn) return;
  cameraBtn.textContent = turnOnReady.camera ? "Camera on" : "Enable camera";
  voiceBtn.textContent = turnOnReady.voice ? "Voice on" : "Enable voice";
  gpsBtn.textContent = turnOnReady.gps ? "GPS on" : "Enable GPS";
  cameraBtn.setAttribute("aria-pressed", String(turnOnReady.camera));
  voiceBtn.setAttribute("aria-pressed", String(turnOnReady.voice));
  gpsBtn.setAttribute("aria-pressed", String(turnOnReady.gps));
  const allOn = turnOnReady.camera && turnOnReady.voice && turnOnReady.gps;
  continueBtn.disabled = !allOn;
  if (allOn) setTurnOnStatus("Camera, voice, and GPS are on. Select Continue.");
}

async function permissionGranted(name) {
  try {
    if (!navigator.permissions?.query) return false;
    const result = await navigator.permissions.query({ name });
    return result.state === "granted";
  } catch {
    return false;
  }
}

async function refreshTurnOnState() {
  const cameraGranted = Boolean(camera.stream?.active) || (await permissionGranted("camera"));
  const voiceGranted = Boolean(camera._micGranted) || (await permissionGranted("microphone"));
  const gpsGranted =
    sessionStorage.getItem("AISIGHT_GPS_OK") === "1" || (await permissionGranted("geolocation"));
  turnOnReady.camera = cameraGranted;
  turnOnReady.voice = voiceGranted;
  turnOnReady.gps = gpsGranted;
  const preview = document.getElementById("camera-preview");
  if (cameraGranted && preview) {
    try {
      await camera.ensureStarted(preview);
      setLive(true);
      turnOnReady.camera = true;
    } catch {
      turnOnReady.camera = Boolean(camera.stream?.active);
    }
  }
  if (voiceGranted) {
    try {
      await camera.primeMicrophone();
      turnOnReady.voice = true;
    } catch {
      turnOnReady.voice = Boolean(camera._micGranted);
    }
  }
  paintTurnOn();
}

function hideTurnOnPopup() {
  const popup = document.getElementById("turn-on-popup");
  if (!popup) return;
  popup.classList.add("hidden");
  popup.setAttribute("aria-hidden", "true");
  document.querySelector(".stage")?.removeAttribute("inert");
  delete document.documentElement.dataset.nyotaTurnOn;
  voice.muteBackground(false);
}

async function showTurnOnPopup(again = false) {
  const popup = document.getElementById("turn-on-popup");
  if (!popup || getUser()?.role === "assistant") return;
  const call = document.getElementById("call-overlay");
  if (call && !call.classList.contains("hidden")) return;
  const alreadyOpen = !popup.classList.contains("hidden");
  document.documentElement.dataset.nyotaTurnOn = "1";
  popup.classList.remove("hidden");
  popup.setAttribute("aria-hidden", "false");
  document.querySelector(".stage")?.setAttribute("inert", "");
  voice.muteBackground(true);
  await refreshTurnOnState();
  if (alreadyOpen && !again) return;
  const continueBtn = document.getElementById("turn-on-continue");
  const spoken = continueBtn?.disabled
    ? "Turn on the camera, voice, and GPS. Tap each button. When all three are on, select Continue. If the camera or voice will not come on, select Refresh page."
    : "Camera, voice, and GPS are on. Select Continue.";
  if (continueBtn?.disabled) setTurnOnStatus("Turn on the camera, voice, and GPS.");
  voice.unlock();
  voice.speak(spoken, { foreground: true, interrupt: true });
  (continueBtn?.disabled ? document.getElementById("enable-camera") : continueBtn)?.focus();
}

async function enableCameraFromPopup() {
  const preview = document.getElementById("camera-preview");
  if (!camera.liveVideo()) setTurnOnStatus("Turning the camera on.");
  await camera.ensureStarted(preview);
  setLive(true);
  turnOnReady.camera = true;
  paintTurnOn();
  await voice.speak("Camera on.", { interrupt: true, foreground: true });
}

async function enableVoiceFromPopup() {
  voice.unlock({ fromGesture: true });
  if (!camera._micGranted) setTurnOnStatus("Turning voice on.");
  await camera.primeMicrophone();
  turnOnReady.voice = true;
  paintTurnOn();
  await voice.speak("Voice on.", { interrupt: true, foreground: true });
}

async function enableGpsFromPopup() {
  setTurnOnStatus("Turning GPS on.");
  if (!gpsTurnOn) {
    gpsTurnOn = requestLocationAccess().finally(() => {
      gpsTurnOn = null;
    });
  }
  const pos = await gpsTurnOn;
  markGps(true, pos);
  turnOnReady.gps = true;
  paintTurnOn();
  await voice.speak("GPS on.", { interrupt: true, foreground: true });
}

async function runTurnOn(kind, action) {
  if (turnOnBusy[kind]) return;
  turnOnBusy[kind] = true;
  voice.unlock({ fromGesture: true });
  try {
    await action();
  } catch (error) {
    const message = error?.message || "That is still off. Try the button again.";
    setTurnOnStatus(message);
    await voice.speak(message, { interrupt: true, foreground: true });
  } finally {
    turnOnBusy[kind] = false;
  }
}

function bindTurnOnPopup() {
  const popup = document.getElementById("turn-on-popup");
  if (!popup || popup.dataset.bound === "1") return;
  popup.dataset.bound = "1";
  document.getElementById("enable-camera")?.addEventListener("click", () => runTurnOn("camera", enableCameraFromPopup));
  document.getElementById("enable-voice")?.addEventListener("click", () => runTurnOn("voice", enableVoiceFromPopup));
  document.getElementById("enable-gps")?.addEventListener("click", () => runTurnOn("gps", enableGpsFromPopup));
  document.getElementById("turn-on-refresh")?.addEventListener("click", () => {
    voice.unlock({ fromGesture: true });
    location.reload();
  });
  document.getElementById("turn-on-continue")?.addEventListener("click", async () => {
    voice.unlock({ fromGesture: true });
    if (!(turnOnReady.camera && turnOnReady.voice && turnOnReady.gps)) {
      setTurnOnStatus("Turn on the camera, voice, and GPS. Then select Continue.");
      await voice.speak("Turn on the camera, voice, and GPS. Then select Continue.", { interrupt: true, foreground: true });
      return;
    }
    markDeviceReady();
    markHomeEntryOk();
    hideTurnOnPopup();
    const ready = await startDevicesQuietly();
    await afterDevicesReady(ready);
    if (ready) speakHomeHint();
  });
}

async function startDevicesQuietly() {
  const preview = document.getElementById("camera-preview");
  try {
    await camera.ensureStarted(preview);
    setLive(true);
  } catch {
    sessionStorage.removeItem("NYOTA_HOME_ENTRY_OK");
    showTurnOnPopup();
    return false;
  }
  try {
    const pos = await requestLocationAccess();
    markGps(true, pos);
  } catch (error) {
    if (error?.code === "GPS_DENIED") {
      sessionStorage.removeItem("NYOTA_HOME_ENTRY_OK");
      showTurnOnPopup();
      return false;
    }
  }
  markDeviceReady();
  return true;
}

async function afterDevicesReady(ready) {
  if (!ready) return;
  const pending = takeQueuedHomeCall();
  if (!pending) return;
  try {
    await calls.start(pending.target || "group", {
      video: Boolean(pending.video),
      emergency: Boolean(pending.emergency),
    });
  } catch (error) {
    await voice.speak(error.message || "I could not start that in-app call.");
  }
}

function openDestSheet() {
  document.getElementById("dest-sheet")?.classList.remove("hidden");
  document.getElementById("dest-input")?.focus();
}

function closeDestSheet() {
  document.getElementById("dest-sheet")?.classList.add("hidden");
}

let homeHintSpoken = false;

function speakHomeHint() {
  const popup = document.getElementById("turn-on-popup");
  if (popup && !popup.classList.contains("hidden")) return;
  if (homeHintSpoken) return;
  homeHintSpoken = true;
  voice.speak("Hold the screen to speak. The large buttons work with one press. Press Emergency twice.");
}

async function boot() {
  if (!requireAuth()) return;
  if (privacyPromptRequired()) {
    location.replace(pages().privacy);
    return;
  }
  const askTurnOn = getUser()?.role !== "assistant";
  bindTurnOnPopup();
  bindHomeActions();
  syncDisclaimerAgreement();
  if (!askTurnOn) startCameraNow();
  onYoloProgress((info) => {
    if (detectionMode) return;
    if (info.state === "downloading" || info.state === "loading") {
      if (!isYoloInstalled()) setDetectHud("loading");
      return;
    }
    if (info.state === "ready") setDetectHud("ready");
    if (info.state === "missing") setDetectHud("ready");
  });
  preloadYolo();
  warmYoloIfInstalled();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && detectionMode) holdDetectionAwake();
    if (document.visibilityState !== "visible") return;
    if (sessionStorage.getItem("NYOTA_LEFT_APP") !== "1") return;
    const call = document.getElementById("call-overlay");
    if (call && !call.classList.contains("hidden")) return;
    showTurnOnPopup(true);
  });
  setDetectHud("ready");
  applyAppearance();
  applyAppLogo();
  idleStatus();
  setOnline(navigator.onLine);
  voice.unlock();
  if (askTurnOn) showTurnOnPopup();
  else startDevicesQuietly().then(afterDevicesReady);
  let networkJobsStarted = false;
  const startNetworkJobs = () => {
    if (networkJobsStarted) return;
    networkJobsStarted = true;
    calls.startPolling();
    refreshBilling();
    announceUnread();
    setInterval(announceUnread, 5000);
    startMessageNotices({ speak: false, href: pages().emergency });
  };
  if (navigator.onLine) startNetworkJobs();
  window.addEventListener("online", () => {
    setOnline(true);
    startNetworkJobs();
  });
  if (!voice.listeningSupported()) fallbackForm?.classList.remove("hidden");
  navigation.onChange = (info) => {
    const remaining = info.user ? navigation.remainingDistance(info.user) : null;
    const distanceText = remaining != null ? `${formatDistance(remaining)} remaining` : "";
    setNavPanel(Boolean(info.active), {
      instruction: info.instruction,
      meta: [info.destination?.name, distanceText].filter(Boolean).join(" · "),
    });
    if (info.active) {
      const drewMap = updateNavMap({
        polyline: info.route?.polyline,
        user: info.user,
        destination: info.destination,
      });
      if (!drewMap) {
        drawRoute(document.getElementById("route-canvas"), info.route?.polyline, info.user, info.destination);
      }
    } else {
      clearNavMap();
    }
  };
  document.getElementById("call-answer")?.addEventListener("click", () => calls.acceptIncoming());
  document.getElementById("call-decline")?.addEventListener("click", () => calls.rejectIncoming());
  document.getElementById("call-end")?.addEventListener("click", async () => {
    await calls.end(true);
    if (sessionStorage.getItem("NYOTA_LEFT_APP") === "1") showTurnOnPopup();
  });
  document.getElementById("call-mute")?.addEventListener("click", () => {
    const muted = calls.toggleMute();
        voice.speak(muted ? "Microphone muted." : "Microphone unmuted.");
  });
  document.getElementById("call-camera")?.addEventListener("click", () => {
    const enabled = calls.toggleCamera();
        voice.speak(enabled ? "Camera turned on." : "Camera turned off.");
  });
  document.getElementById("nav-close")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setMapVisible(false);
    voice.speak("Map closed. Tap the screen and say show the map if you want it back.");
  });
  document.getElementById("nav-close")?.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  document.getElementById("dest-close")?.addEventListener("click", closeDestSheet);
  document.getElementById("dest-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const destination = document.getElementById("dest-input")?.value.trim();
    if (!destination) return;
    closeDestSheet();
    try {
      if (!walkingDirectionsOn()) {
        pendingLocationShare = { destination };
        await voice.speak(
          `Walking directions are off. Can I send your location to a family member so they can help you get to ${destination}? Say yes, or say send this to my brother.`
        );
        return;
      }
      const spoken = await navigation.start(destination);
      await voice.speak(spoken);
    } catch (error) {
      await handleFailure(error);
    }
  });
  const pendingDest = sessionStorage.getItem("AI_SIGHT_NAV_DEST");
  if (pendingDest) {
    sessionStorage.removeItem("AI_SIGHT_NAV_DEST");
    if (!walkingDirectionsOn()) {
      pendingLocationShare = { destination: pendingDest };
      voice.speak(
        `Walking directions are off. Can I send your location to a family member so they can help you get to ${pendingDest}? Say yes, or say send this to my brother.`
      );
    } else {
      requestLocationAccess()
        .then(async () => {
          const spoken = await navigation.start(pendingDest);
          await voice.speak(spoken);
        })
        .catch(handleFailure);
    }
  } else if (!askTurnOn) {
    speakHomeHint();
  }
}

zone?.addEventListener("pointerdown", onZonePointerDown);
zone?.addEventListener("pointerup", onZonePointerUp);
zone?.addEventListener("pointercancel", onZonePointerUp);
zone?.addEventListener("contextmenu", (event) => event.preventDefault());
zone?.addEventListener("keydown", (event) => {
  if (event.repeat) return;
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onZonePointerDown({ button: 0, pointerId: 0, preventDefault() {} });
  }
});
zone?.addEventListener("keyup", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onZonePointerUp({ preventDefault() {} });
  }
});

fallbackForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = fallbackInput.value.trim();
  fallbackInput.value = "";
  if (!text) return;
  try {
    await handleCommand(text);
  } catch (error) {
    await handleFailure(error);
  }
});

window.addEventListener("offline", () => {
  setOnline(false);
  voice.speak("You are offline. Camera and object detection still work.");
});
window.addEventListener("online", () => setOnline(true));

boot();
