"""Intent detection with slot extraction. Additional intents can be registered."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class ParsedIntent:
    intent: str
    confidence: float
    slots: dict = field(default_factory=dict)
    original_text: str = ""
    spoken_echo: str | None = None


IntentHandler = tuple[str, list[re.Pattern], float]


class IntentRegistry:
    """Priority-ordered intent matchers. First match with highest priority wins."""

    def __init__(self):
        self._intents: list[tuple[int, str, list[re.Pattern]]] = []

    def register(self, name: str, patterns: list[str], priority: int = 100) -> None:
        compiled = [re.compile(p, re.IGNORECASE) for p in patterns]
        self._intents.append((priority, name, compiled))
        self._intents.sort(key=lambda item: item[0])

    def parse(self, text: str) -> ParsedIntent:
        cleaned = (text or "").strip()
        if not cleaned:
            return ParsedIntent("UNKNOWN", 0.0, original_text=cleaned)

        keyed = match_keyword_command(cleaned)
        if keyed:
            keyed.slots = extract_additional_slots(keyed.intent, cleaned, keyed.slots)
            return keyed

        for _priority, name, patterns in self._intents:
            for pattern in patterns:
                match = pattern.search(cleaned)
                if match:
                    slots = {k: v.strip() for k, v in match.groupdict().items() if v}
                    slots = extract_additional_slots(name, cleaned, slots)
                    return ParsedIntent(
                        intent=name,
                        confidence=0.92,
                        slots=slots,
                        original_text=cleaned,
                    )
        return ParsedIntent("UNKNOWN", 0.2, original_text=cleaned)


def extract_additional_slots(intent: str, text: str, slots: dict) -> dict:
    if intent == "DETECT_OBJECTS" and "object" not in slots:
        presence = re.search(r"\bis there (?:a |an |the )?(?P<object>[\w\s]+?)(?:\s+in front|\s+here|\s+nearby)?\??$", text, re.I)
        if presence:
            slots["object"] = presence.group("object").strip()
    if intent.startswith("SEND_"):
        target = slots.get("target", "")
        if _TO_BROADCAST.search(text):
            target = ""
        elif not target:
            named = _TO_NAME.search(text)
            target = (named.group("target") if named else "").strip()
            first = target.split()[0].lower() if target else ""
            if first in _NAME_STOP:
                target = ""
        target = re.sub(r"[.?!]+$", "", (target or "").strip())
        target = re.sub(r"\s+(please|now|thanks|thank you)$", "", target, flags=re.I)
        target = re.sub(r"^(my|the|a|an)\s+", "", target, flags=re.I).strip()
        if re.fullmatch(r"(everybody|everyone|somebody|someone|anybody|anyone|all|them|all of them|all of my contacts)", target, re.I):
            slots.pop("target", None)
        elif target:
            slots["target"] = target
        elif "target" in slots:
            slots.pop("target", None)
    if intent == "SEND_MESSAGE" and not slots.get("body"):
        body = _message_body(text, slots.get("target"))
        if body:
            slots["body"] = body
    return slots


_PHOTO_RE = re.compile(r"\b(photos?|pictures?|pics?|images?|snapshots?)\b", re.I)
_MAP_RE = re.compile(r"\b(maps?|locations?|gps|whereabouts)\b", re.I)
_MESSAGE_RE = re.compile(r"\b(messages?|sms)\b", re.I)
_SEND_TEXT_RE = re.compile(r"\b(?:send|share)\s+(?:a |the |this )?text\b", re.I)
_READ_MSGS_RE = re.compile(r"\b(?:read|check|any)\s+(?:my\s+)?(?:new\s+)?messages\b", re.I)
_DESCRIBE_RE = re.compile(
    r"\b(?:"
    r"what(?:'s| is) in front(?: of (?:me|you))?"
    r"|in front of (?:me|you)(?: right now)?"
    r"|what do you see"
    r"|what you see"
    r"|describe what you see"
    r"|read what you see"
    r"|read what(?:'s| is) in front"
    r"|(?:can you |could you |please |i want you to )?(?:describe|explain)(?: this| that| the scene| the view| what you see| what is in front(?: of (?:me|you))?| what's in front(?: of (?:me|you))?)?"
    r"|look around"
    r"|look (?:in front|ahead|at (?:this|that|what(?:'s| is) in front))"
    r"|what(?:'s| is) around me"
    r"|what(?:'s| is) ahead(?: of me)?"
    r"|tell me what(?:'s| is) (?:there|in front|around me|ahead)"
    r"|tell me what you see"
    r"|can you see what(?:'s| is) in front"
    r"|i can(?:no)?t see(?: what(?:'s| is) in front(?: of (?:me|you)?)?)?"
    r"|i don(?:'t|t) (?:know|see) what(?:'s| is) in front"
    r")\b",
    re.I,
)
_READ_RE = re.compile(
    r"\b(?:read this|read that|read it|read (?:it |this )?for me|"
    r"what(?:'s| is) written|what does (?:this|that|it) say|"
    r"read the (?:page|paper|document|text|sign|menu|label|book|screen)|"
    r"read (?:this |the )?page)\b",
    re.I,
)
_HAS_SEND = re.compile(r"\b(send|share)\b", re.I)
_TO_BROADCAST = re.compile(
    r"\bto(?:\s+my)?\s+(contacts?|everyone|everybody|anyone|anybody|all(?:\s+(?:of\s+)?(?:my\s+)?contacts?)?|the group|them)\b",
    re.I,
)
_TO_NAME = re.compile(r"\bto(?:\s+my)?\s+(?P<target>[a-zA-Z]{2,}(?:\s+[a-zA-Z]{2,}){0,2})\b", re.I)
_NAME_STOP = {
    "i",
    "im",
    "we",
    "you",
    "please",
    "and",
    "that",
    "say",
    "saying",
    "tell",
    "send",
    "share",
    "take",
    "a",
    "an",
    "the",
    "this",
}


def _message_body(text: str, target: str | None) -> str:
    body = text or ""
    body = re.sub(
        r"^(?:please|can you|could you|i want (?:you )?to|i would like (?:you )?to)\s+",
        "",
        body,
        flags=re.I,
    )
    body = re.sub(r"\b(?:send|share)\s+(?:a |the |this )?(?:message|text|sms|note)\b", " ", body, flags=re.I)
    body = re.sub(r"\b(?:message|messages|text|sms)\b", " ", body, flags=re.I)
    body = re.sub(r"\bto(?:\s+my)?\s+(?:contacts?|everyone|everybody|anyone|all)\b", " ", body, flags=re.I)
    if target:
        body = re.sub(rf"\bto(?:\s+my)?\s+{re.escape(target)}\b", " ", body, flags=re.I)
    body = re.sub(r"\b(?:and )?(?:say|saying|that|tell them)\b", " ", body, flags=re.I)
    return " ".join(body.split()).strip(" .,!?")


def match_keyword_command(text: str) -> ParsedIntent | None:
    """Simple spoken keywords. Groq does not choose the action."""
    cleaned = (text or "").strip()
    if not cleaned:
        return None
    if _READ_MSGS_RE.search(cleaned):
        return ParsedIntent("READ_MESSAGES", 0.95, original_text=cleaned)
    sending = bool(_HAS_SEND.search(cleaned))
    if _DESCRIBE_RE.search(cleaned) and not (sending and _PHOTO_RE.search(cleaned)):
        return ParsedIntent("DESCRIBE", 0.95, original_text=cleaned)
    if _READ_RE.search(cleaned):
        return ParsedIntent("READ", 0.95, original_text=cleaned)
    if _PHOTO_RE.search(cleaned):
        return ParsedIntent("SEND_PHOTO", 0.95, original_text=cleaned)
    if _MAP_RE.search(cleaned):
        asking_where = re.search(
            r"\b(?:where am i|what(?:'s| is) my location|current location)\b",
            cleaned,
            re.I,
        )
        if asking_where and not sending and not re.search(r"\bmaps?\b", cleaned, re.I):
            return None
        return ParsedIntent("SEND_LOCATION", 0.95, original_text=cleaned)
    if _MESSAGE_RE.search(cleaned) or _SEND_TEXT_RE.search(cleaned):
        return ParsedIntent("SEND_MESSAGE", 0.95, original_text=cleaned)
    return None


def build_default_registry() -> IntentRegistry:
    registry = IntentRegistry()
    registry.register(
        "EMERGENCY",
        [r"\bemergency\b", r"\bsos\b", r"\bhelp me\b", r"\bi need help\b", r"\bcall (?:for )?help\b"],
        priority=10,
    )
    registry.register(
        "STOP",
        [
            r"\bstop navigation\b",
            r"\bcancel navigation\b",
            r"\bend navigation\b",
            r"\bstop the call\b",
            r"\bend (?:the )?call\b",
            r"\bhang up\b",
            r"\bcancel\b",
            r"\bstop\b",
        ],
        priority=20,
    )
    registry.register("REPEAT", [r"\brepeat\b", r"\bsay that again\b", r"\bwhat did you say\b"], priority=30)
    registry.register(
        "VIDEO_CALL",
        [
            r"\bvideo call (?:with )?(?:my )?(?P<target>.+)$",
            r"\bstart a video call(?: with (?:my )?(?P<target>.+))?$",
            r"\bmake a video call(?: (?:with |to )(?:my )?(?P<target>.+))?$",
        ],
        priority=35,
    )
    registry.register(
        "VOICE_CALL",
        [
            r"\bvoice call (?:with )?(?:my )?(?P<target>.+)$",
            r"\baudio call (?:with )?(?:my )?(?P<target>.+)$",
            r"\bphone call (?:with )?(?:my )?(?P<target>.+)$",
            r"\bstart a voice call(?: with (?:my )?(?P<target>.+))?$",
        ],
        priority=36,
    )
    registry.register(
        "CALL",
        [
            r"\bcall (?P<target>.+)$",
            r"\bphone (?P<target>.+)$",
            r"\bdial (?P<target>.+)$",
            r"\bstart a call\b",
        ],
        priority=40,
    )
    registry.register(
        "SEND_PHOTO",
        [
            r"\bi want (?:you )?to (?:take|send) (?:an? |this |the )?(?:picture|photo|image).{0,80}send",
            r"\btake an? (?:picture|photo|image).{0,80}send",
            r"\bpicture this(?: place)? and send (?:it )?(?:to (?:my )?(?P<target>.+))?$",
            r"\btake a (?:picture|photo)(?: of this(?: place)?)? and send (?:it )?(?:to (?:my )?(?P<target>.+))?$",
            r"\bsend (?:a |this |the )?(?:picture|photo|image)(?: to (?:my )?(?P<target>.+))?$",
        ],
        priority=41,
    )
    registry.register(
        "SEND_VOICE_NOTE",
        [
            r"\bi want (?:you )?to send (?:a |this |the )?(?:voice ?note|voicemail|voice mail)(?: to (?:my )?(?P<target>.+))?$",
            r"\bsend (?:a |this |the )?(?:voice ?note|voicemail|voice mail)(?: to (?:my )?(?P<target>.+))?$",
            r"\btake a (?:voice ?note|voicemail).{0,80}?send (?:it )?(?:to (?:my )?(?P<target>.+))?$",
            r"\b(?:record|take) a (?:voice ?note|voicemail)(?: for| to) (?:my )?(?P<target>.+)$",
            r"\b(?:record|take) a (?:voice ?note|voicemail)\b",
            r"\bvoice ?note\b",
        ],
        priority=42,
    )
    registry.register(
        "SEND_MESSAGE",
        [
            r"\bi want (?:you )?to send (?:a |this )?message to (?:my )?(?P<target>.+?) (?:and )?(?:say(?:ing)? |that )?(?P<body>.+)$",
            r"\bi want (?:you )?to send (?:a |this )?message to (?:my )?(?P<target>.+)$",
            r"\bi want (?:you )?to send (?:a |this )?message(?: (?P<body>.+))?$",
            r"\bsend (?:a |this )?message to (?:my )?(?P<target>.+?) (?:and )?(?:say(?:ing)? |that )?(?P<body>.+)$",
            r"\btake this message.{0,60}?(?:send(?:ing)? it )?(?:to (?:my )?(?P<target>.+))?$",
            r"\bsend (?:a |this )?message(?: to (?:my )?(?P<target>.+))?$",
            r"\b(?:text|message) (?:my )?(?P<target>.+)$",
        ],
        priority=43,
    )
    registry.register(
        "DELETE_CONTACT",
        [
            r"\bdelete (?:my )?(?:contact )?(?P<target>.+)$",
            r"\bremove (?:my )?(?:contact )?(?P<target>.+)$",
        ],
        priority=46,
    )
    registry.register(
        "READ_MESSAGES",
        [r"\bread (?:my )?messages(?: from (?:my )?(?P<target>.+))?$", r"\bany (?:new )?messages\b"],
        priority=44,
    )
    registry.register(
        "NAVIGATE",
        [
            r"\btake me to (?P<destination>.+)$",
            r"\bnavigate to (?P<destination>.+)$",
            r"\bgo to (?P<destination>.+)$",
            r"\bdirections to (?P<destination>.+)$",
            r"\bi want to go to (?P<destination>.+)$",
            r"\bfind the nearest (?P<destination>.+)$",
            r"\bnearest (?P<destination>.+)$",
        ],
        priority=50,
    )
    registry.register(
        "SEND_LOCATION",
        [
            r"\bi want (?:you )?to send (?:the |this |my )?(?:location|map)(?: to (?P<target>.+))?$",
            r"\bsend (?:the |this |my )?location to (?P<target>.+)$",
            r"\bsend (?:the |this |my )?map(?: to (?P<target>.+))?$",
            r"\bshare (?:the |this |my )?location with (?P<target>.+)$",
            r"\bcan you send (?:the |this |my )?location to (?P<target>.+)$",
            r"\bsend (?:the |this |my )?location\b",
            r"\bshare (?:the |this |my )?location\b",
        ],
        priority=45,
    )
    registry.register(
        "WHERE_AM_I",
        [r"\bwhere am i\b", r"\bwhat('s| is) my location\b", r"\bcurrent location\b"],
        priority=55,
    )
    registry.register("HOW_FAR", [r"\bhow far\b", r"\bhow much (?:further|farther|left)\b"], priority=56)
    registry.register(
        "NEXT_TURN",
        [r"\bnext turn\b", r"\bwhat('s| is) the next (?:turn|instruction)\b"],
        priority=57,
    )
    registry.register(
        "READ",
        [
            r"\bread (?:this|that|it|the text|the sign|the document|the menu|the label)\b",
            r"\bwhat does (?:this|that) say\b",
            r"\bread (?:the )?(?P<target>sign|menu|label|document|screen|text)\b",
        ],
        priority=60,
    )
    registry.register(
        "DETECT_OBJECTS",
        [
            r"\bwhat is this object\b",
            r"\bdetect(?: objects?)?\b",
            r"\bwhat objects\b",
            r"\bis there (?:a |an |the )?(?P<object>[\w\s]+?)(?: in front of me| here| nearby)?\??$",
        ],
        priority=70,
    )
    registry.register(
        "DESCRIBE",
        [
            r"\bwhat do you see\b",
            r"\bdescribe (?:this|that|the scene|what you see|what is in front of me)\b",
            r"\bcan you describe\b",
            r"\bi can(?:no)?t see\b",
            r"\bwhat('s| is) around me\b",
            r"\blook around\b",
            r"\bwhat is in front of me\b",
            r"\bwhat(?:'s| is) in front of me\b",
        ],
        priority=80,
    )
    registry.register(
        "HELP",
        [r"^help$", r"\bwhat can you do\b", r"\bhow do i\b", r"\bcommands\b"],
        priority=90,
    )
    registry.register(
        "TEST_CALLING",
        [
            r"\btest (?:my )?(?:video |voice )?call(?:ing)?\b",
            r"\btest (?:the )?calling\b",
        ],
        priority=92,
    )
    registry.register(
        "CONFIGURE_CALLING",
        [
            r"\bconfigure (?:my )?(?:calling|video calling)(?: account)?\b",
            r"\bset up (?:my )?calling\b",
            r"\bsetup (?:my )?calling\b",
        ],
        priority=93,
    )
    registry.register(
        "CALLING_SETTINGS",
        [
            r"\bopen calling settings\b",
            r"\bcalling settings\b",
            r"\bvoice and video call(?:ing)? setup\b",
            r"\bvideo and voice call(?:ing)? setup\b",
        ],
        priority=94,
    )
    registry.register("SETTINGS", [r"\bsettings\b", r"\bopen settings\b"], priority=95)
    return registry


intent_registry = build_default_registry()


def parse_intent(text: str) -> dict:
    parsed = intent_registry.parse(text)
    return {
        "intent": parsed.intent,
        "confidence": parsed.confidence,
        "slots": parsed.slots,
        "original_text": parsed.original_text,
    }


def _with_defaults(parsed: dict, text: str) -> dict:
    from app.services.share_location_service import is_broadcast_target

    slots = dict(parsed.get("slots") or {})
    intent = parsed.get("intent") or "UNKNOWN"
    if intent == "SEND_VOICE_NOTE":
        intent = "SEND_MESSAGE"
        parsed["intent"] = intent
    if is_broadcast_target(slots.get("target")):
        slots.pop("target", None)
        slots["broadcast"] = True
    if intent in {"SEND_PHOTO", "SEND_MESSAGE", "SEND_LOCATION"} and not slots.get("target"):
        slots["broadcast"] = True
    if intent in {"CALL", "VOICE_CALL", "VIDEO_CALL"} and not slots.get("target"):
        slots["broadcast"] = False
    parsed["slots"] = slots
    parsed["original_text"] = parsed.get("original_text") or text
    parsed.setdefault("spoken", "")
    parsed.setdefault("needs_confirm", intent == "DELETE_CONTACT")
    parsed.setdefault("source", "rules")
    spoken_by_intent = {
        "SEND_PHOTO": "Okay. Taking a picture.",
        "SEND_LOCATION": "Okay. Sending your location.",
        "SEND_MESSAGE": "Okay. Sending your message.",
        "DESCRIBE": "Okay. Looking in front of you.",
        "READ": "Okay. Reading the page in front of the camera.",
    }
    if not parsed.get("spoken"):
        parsed["spoken"] = spoken_by_intent.get(intent, "")
    if intent in {"UNKNOWN", "REPLY"} and not parsed["spoken"]:
        parsed["intent"] = "REPLY"
        parsed["spoken"] = (
            "Say send a message, send a photo, send a map, "
            "what is in front of me, or read this."
        )
    return parsed


def understand_command(text: str, contacts: list[dict] | None = None) -> dict:
    """Keyword commands only. Groq is not used to decide the action."""
    cleaned = (text or "").strip()
    parsed = _with_defaults(parse_intent(cleaned), cleaned)
    if parsed.get("intent") in {"UNKNOWN", "REPLY"}:
        from app.services.groq_service import small_talk_reply

        chat = small_talk_reply(cleaned)
        if chat:
            return _with_defaults(
                {
                    "intent": "REPLY",
                    "confidence": 0.99,
                    "slots": {},
                    "spoken": chat,
                    "source": "rules",
                },
                cleaned,
            )
    parsed["source"] = "rules"
    return parsed
