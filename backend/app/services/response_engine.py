"""Convert technical AI / routing results into short spoken language.

Never invent objects, distances, or text that the upstream service did not return.
"""

from __future__ import annotations

from collections import defaultdict


POSITION_PHRASES = {
    "center": "in front of you",
    "left": "on your left",
    "right": "on your right",
    "top center": "ahead of you",
    "bottom center": "near the bottom of the view",
    "top left": "ahead and to your left",
    "top right": "ahead and to your right",
    "bottom left": "to your lower left",
    "bottom right": "to your lower right",
}


def _position_phrase(position: str | None) -> str:
    if not position:
        return "approximately in front of you"
    return POSITION_PHRASES.get(position, f"toward the {position}")


def _indefinite(label: str) -> str:
    label = label.replace("_", " ").strip()
    article = "an" if label[:1].lower() in "aeiou" else "a"
    return f"{article} {label}"


_COUNT_WORDS = {
    2: "two",
    3: "three",
    4: "four",
    5: "five",
    6: "six",
    7: "seven",
    8: "eight",
    9: "nine",
    10: "ten",
}

_IRREGULAR_PLURALS = {
    "person": "people",
    "man": "men",
    "woman": "women",
    "child": "children",
}


def _count_phrase(label: str, count: int) -> str:
    name = label.replace("_", " ").strip()
    if count == 1:
        return _indefinite(name)
    number = _COUNT_WORDS.get(count, str(count))
    plural = _IRREGULAR_PLURALS.get(name, f"{name}s")
    return f"{number} {plural}"


def _join_english(parts: list[str]) -> str:
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    if len(parts) == 2:
        return f"{parts[0]} and {parts[1]}"
    return f"{', '.join(parts[:-1])}, and {parts[-1]}"


def speak_detections(detections: list[dict], query_object: str | None = None) -> str:
    items = [item for item in (detections or []) if (item.get("confidence") or 0) >= 0.4]
    if query_object:
        target = query_object.strip().lower()
        matches = [item for item in items if target in str(item.get("label", "")).lower()]
        if not matches:
            return f"I do not see {target}."
        label = matches[0].get("label") or target
        return f"You see {_count_phrase(label, len(matches))}."

    if not items:
        return "I do not see any objects I recognize."

    grouped: dict[str, int] = defaultdict(int)
    for item in items:
        grouped[str(item.get("label") or "object")] += 1
    ranked = sorted(grouped.items(), key=lambda pair: (-pair[1], pair[0]))[:6]
    parts = [_count_phrase(label, count) for label, count in ranked]
    return f"You see {_join_english(parts)}."


def speak_read_result(text: str | None, uncertain: bool = False) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return "I could not read any clear text in this image."
    if uncertain:
        return f"The text is unclear, but it might say: {cleaned}"
    return cleaned


def speak_navigation_start(destination: str, first_instruction: str | None, distance_m: float | None) -> str:
    parts = [f"Navigation started to {destination}."]
    if distance_m:
        parts.append(f"About {format_distance(distance_m)} away.")
    if first_instruction:
        parts.append(first_instruction)
    return " ".join(parts)


def format_distance(meters: float | None) -> str:
    if meters is None:
        return "an unknown distance"
    if meters < 10:
        return "a few meters"
    if meters < 1000:
        return f"{int(round(meters))} meters"
    km = meters / 1000
    if km < 10:
        return f"{km:.1f} kilometers"
    return f"{int(round(km))} kilometers"


def speak_error(code: str) -> str:
    messages = {
        "CAMERA_UNAVAILABLE": "I can't access the camera.",
        "MIC_UNAVAILABLE": "I can't access the microphone.",
        "SPEECH_UNAVAILABLE": "Speech recognition is not available in this browser.",
        "VISION_SERVICE_ERROR": "I'm having trouble processing the image. Please try again.",
        "DETECTION_SERVICE_ERROR": "I couldn't detect objects right now. Please try again.",
        "GPS_UNAVAILABLE": "I can't get your current location. Please check location permission.",
        "GPS_DENIED": "Location permission was denied. Navigation needs your location.",
        "GPS_INACCURATE": "GPS accuracy is poor, so directions may be less precise.",
        "MAPS_SERVICE_ERROR": "I couldn't calculate a route. Please try again.",
        "DESTINATION_NOT_FOUND": "I couldn't find that destination. Please say it again.",
        "CALL_FAILED": "I couldn't complete the call.",
        "CONTACT_NOT_FOUND": "Your group is not available right now.",
        "EMERGENCY_FAILED": "I couldn't complete the emergency request. Please try again.",
        "NETWORK_ERROR": "The internet connection looks unavailable.",
        "AUTH_REQUIRED": "Please sign in first.",
        "UNKNOWN": "I couldn't complete that request. Please try again.",
    }
    return messages.get(code, "I couldn't complete that request. Please try again.")
