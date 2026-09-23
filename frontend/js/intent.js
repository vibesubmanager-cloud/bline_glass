import { api } from "./api.js";

const SMALL_TALK = new Set([
  "hi",
  "hello",
  "hey",
  "yo",
  "hiya",
  "hello there",
  "hey there",
  "hi there",
  "good morning",
  "good afternoon",
  "good evening",
  "how are you",
  "how are you doing",
  "how r you",
  "how re you",
  "how's it going",
  "hows it going",
  "whats up",
  "what's up",
  "hello how are you",
  "hello how are you doing",
  "hi how are you",
  "hi how are you doing",
  "hey how are you",
  "hey how are you doing",
  "thanks",
  "thank you",
  "thanks a lot",
  "thank you so much",
]);

const COMMAND_WORD = /\b(message|messages|sms|photo|photos|picture|pictures|pic|pics|image|images|snapshot|map|maps|location|locations|gps|read|describe|explain|emergency|sos|stop|cancel|call|detect)\b/i;
const IN_FRONT = /\bin front of (?:me|you)\b|\bwhat(?:'s| is) in front\b|\bwhat do you see\b|\bwhat you see\b|\bi can(?:no)?t see\b/i;

function normalizeTalk(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function hasCommandKeyword(text) {
  const cleaned = String(text || "");
  return COMMAND_WORD.test(cleaned) || IN_FRONT.test(cleaned);
}

export function smallTalkReply(text) {
  if (hasCommandKeyword(text)) return "";
  const cleaned = normalizeTalk(text);
  if (!cleaned) return "";
  if (SMALL_TALK.has(cleaned) || cleaned.startsWith("how are you")) {
    return cleaned.startsWith("thank") ? "You're welcome." : "I'm doing good, and you?";
  }
  return "";
}

export async function interpretCommand(text) {
  return api("/api/intent/parse", { method: "POST", body: { text }, timeout: 8000 });
}

export function isAffirmative(text) {
  return /^(yes|yeah|yep|ok|okay|sure|please|go ahead|send it|do it)\b/i.test((text || "").trim());
}

export function isNegative(text) {
  return /^(no|nope|don't|do not|cancel|stop)\b/i.test((text || "").trim());
}

export const HELP_TEXT =
  "Hold the screen to speak. Double tap for object detection. Say send a message, send a photo, or send a map. Say what is in front of me, describe what is in front of me, or read this. Say open calling settings to set up voice and video calling once.";
