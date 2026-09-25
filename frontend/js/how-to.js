const statusEl = document.getElementById("how-status");
const demo = document.getElementById("demo-visual");
const demoHit = document.getElementById("demo-hit");
const demoNote = document.getElementById("demo-note");
const synth = window.speechSynthesis;

let lessonQueue = [];
let lessonIndex = 0;
let speakingAll = false;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text || "";
}

function unlockSpeak() {
  try {
    synth?.resume?.();
  } catch {
    /* ignore */
  }
}

function stopSpeak() {
  speakingAll = false;
  lessonQueue = [];
  try {
    synth?.cancel?.();
  } catch {
    /* ignore */
  }
  setStatus("Stopped talking.");
}

function speak(text, { enqueue = false } = {}) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned || !synth) return Promise.resolve();
  unlockSpeak();
  if (!enqueue) {
    try {
      synth.cancel();
    } catch {
      /* ignore */
    }
  }
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(cleaned);
    utter.rate = 0.95;
    utter.lang = "en-US";
    utter.volume = 1;
    utter.onend = () => resolve();
    utter.onerror = () => resolve();
    synth.speak(utter);
  });
}

const LESSONS = {
  start: "Welcome to how to use vibeEye. You do not need to sign in to hear this. vibeEye is a talking camera for blind people. The whole camera screen is a button. Hold the screen, speak, then let go. Double tap to start or stop object detection. Family is one group. Emergency is the second button. The rest of this page explains every part, slowly.",
  startapp: "How to start. Open this website in Safari on iPhone, or Chrome on Android. Choose Blind person. Create an account or sign in. Then add vibeEye to your home screen. The first time, allow camera, microphone, and location. After that they start by themselves when you open the app, until you sign out.",
  camera: "The camera is your home. There is no small microphone button to find. Hold anywhere on the picture. When it hears you, it says Listening. Let go when you finish talking. Double tap starts object detection. Double tap again stops it. At the bottom, six buttons: camera, emergency, contacts, profile, plans, and settings. Tap emergency to open emergency chat. Walking is not a button. Say take me to a place.",
  emergency: "Tap the emergency button to open emergency chat. You can text, send a voice note, send a photo, or send a map. Call and video call are at the top. They use the in-app video call, not a phone number. If a blind person says emergency, or SOS, the app starts an in-app video call and sends a message, a photo, and a map to emergency chat at once. Anyone who is free can pick up. If you want only one thing, say emergency send a message, or emergency send a photo, or emergency send a map. This does not replace police or ambulance numbers on the phone.",
  detect: "Object detection names things in front of the camera, like a person, chair, or bottle. First, a helper can open Settings and download object detection to this phone, on Wi-Fi, one time. After that, double tap the camera. The app speaks what it sees. Double tap again to stop. You can also hold and say detect, or say stop.",
  describe: "To hear the place in front of you, hold the screen and say: what is in front of me. Or say: describe what is in front of me. Point the camera forward. Wait for Okay, looking. Then it speaks a few sentences. If the app says Premium, open Plans. Volume up. Use the loud speaker or Bluetooth, not the tiny ear speaker.",
  read: "To read a page, menu, or sign, fill the camera with that page. Hold still. Hold the screen and say: read this. Wait for Okay, reading. Then it reads the words. If there is no text, it will say so.",
  call: "Calling stays inside vibeEye. Family is one group. When you call, everyone rings. Anyone who is free can pick up. A helper should open Settings once and tap Configure calling. Then hold and say: call. Or: video call. Green answers. The call can keep ringing other people if one person declines.",
  people: "Contacts is two people on the bottom bar. The main card is Family group. Say send a message, send a photo, or send a map. Each of those is one action, and it goes to everybody. Say read my messages to hear new texts. You, family, and admin can see notifications.",
  map: "Walking directions are off until a helper turns them on in Settings. If they are off, the app can send your location to the group instead. If they are on, say: take me to the market. Say where am I, how far, next turn, or show the map. Say stop to end the route. The second dock button is Emergency, not a map.",
  settings: "Settings is the gear. Tap New update after a new version. Test speaker if you cannot hear. Download object detection once. Save speech speed and language. Your system ID and QR code are here, for family to link. Sign out only when you want to leave the account. Admin has an Emergency page to join the call and see the message, photo, and map.",
  commands: "Quick commands. Help. Detect. Stop. What is in front of me. Read this. Call. Video call. Send a message. Send a photo. Send a map. Read my messages. Take me to a place. Where am I. Emergency. Emergency send a photo. Settings.",
};

async function speakLesson(id) {
  const text = LESSONS[id];
  if (!text) return;
  const heading = document.querySelector(`#${id} h2`)?.textContent || "Lesson";
  setStatus(`Speaking: ${heading}`);
  demoMode(id);
  await speak(`${heading}. ${text}`);
  if (!speakingAll) setStatus("Finished this part. Tap Hear this, or Hear the whole guide.");
}

async function speakAll() {
  speakingAll = true;
  lessonQueue = ["start", "startapp", "camera", "detect", "describe", "read", "call", "people", "map", "emergency", "settings", "commands"];
  lessonIndex = 0;
  setStatus("Speaking the whole guide. Tap Stop talking to stop.");
  for (; lessonIndex < lessonQueue.length; lessonIndex += 1) {
    if (!speakingAll) return;
    const id = lessonQueue[lessonIndex];
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    await speakLesson(id);
  }
  speakingAll = false;
  setStatus("That is the full guide. You can practice on the picture above.");
}

function demoMode(id) {
  if (!demo) return;
  demo.classList.remove("is-listening", "is-detecting", "demo-tap");
  if (id === "detect") demo.classList.add("is-detecting", "demo-tap");
  else if (id === "camera" || id === "start") demo.classList.add("is-listening");
}

let holdTimer = 0;
let lastTap = 0;

function onDemoDown(event) {
  event.preventDefault();
  unlockSpeak();
  const now = Date.now();
  if (now - lastTap < 320) {
    lastTap = 0;
    clearTimeout(holdTimer);
    demo?.classList.remove("is-listening");
    demo?.classList.add("is-detecting", "demo-tap");
    if (demoNote) demoNote.textContent = "Good. Double tap starts or stops object detection.";
    speak("Good. That double tap starts or stops object detection.");
    return;
  }
  lastTap = now;
  holdTimer = window.setTimeout(() => {
    demo?.classList.add("is-listening");
    demo?.classList.remove("is-detecting", "demo-tap");
    if (demoNote) demoNote.textContent = "Listening. Say a command, then let go.";
  }, 420);
}

function onDemoUp() {
  clearTimeout(holdTimer);
  if (demo?.classList.contains("is-listening")) {
    demo.classList.remove("is-listening");
    if (demoNote) demoNote.textContent = "Good. That is how you give a command. Hold, speak, let go.";
    speak("Good. That is how you give a command. Hold, speak, then let go.");
  }
}

demoHit?.addEventListener("pointerdown", onDemoDown);
demoHit?.addEventListener("pointerup", onDemoUp);
demoHit?.addEventListener("pointercancel", onDemoUp);
demoHit?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onDemoDown(event);
  }
});
demoHit?.addEventListener("keyup", (event) => {
  if (event.key === "Enter" || event.key === " ") onDemoUp();
});

document.getElementById("hear-all")?.addEventListener("click", () => {
  unlockSpeak();
  speakAll();
});
document.getElementById("stop-talk")?.addEventListener("click", stopSpeak);

document.querySelectorAll("[data-speak]").forEach((button) => {
  button.addEventListener("click", () => {
    speakingAll = false;
    speakLesson(button.getAttribute("data-speak"));
  });
});

document.querySelectorAll("[data-say]").forEach((button) => {
  button.addEventListener("click", () => {
    speakingAll = false;
    const phrase = button.getAttribute("data-say");
    setStatus(`Say this: ${phrase}`);
    speak(`Say this. ${phrase}`);
  });
});

setStatus("Tap Hear the whole guide, or practice on the picture. No sign in needed.");
