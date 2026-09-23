"""Groq: fast conversation and phone actions. Gemini is not used here."""

from __future__ import annotations

import json
import re

import requests

from app.utils.logging import log_error, log_event

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
COMMAND_TIMEOUT_SEC = 4

COMMAND_INTENTS = (
    "EMERGENCY",
    "STOP",
    "REPEAT",
    "CALL",
    "SEND_PHOTO",
    "SEND_MESSAGE",
    "SEND_LOCATION",
    "DELETE_CONTACT",
    "READ_MESSAGES",
    "NAVIGATE",
    "NAV_STATUS",
    "SHOW_MAP",
    "CLOSE_MAP",
    "WHERE_AM_I",
    "HOW_FAR",
    "NEXT_TURN",
    "READ",
    "DETECT_OBJECTS",
    "DESCRIBE",
    "HELP",
    "SETTINGS",
    "CALLING_SETTINGS",
    "CONFIGURE_CALLING",
    "TEST_CALLING",
    "VISUAL_QUESTION",
    "REPLY",
    "UNKNOWN",
)

COMMAND_PROMPT = """You are a friendly voice on a blind person's phone. One JSON object only.
Speech: {speech}
People they can message: {contacts}

If they said hi/hello/how are you/thanks/small talk: {{"intent":"REPLY","spoken":"I'm doing good, and you?","target":"","broadcast":false,"body":"","destination":"","needs_confirm":false}}
If they want a picture sent to people/contacts/the group: {{"intent":"SEND_PHOTO","spoken":"Okay.","target":"","broadcast":true,"body":"","destination":"","needs_confirm":false}}
If they want a text sent: {{"intent":"SEND_MESSAGE","spoken":"Okay.","target":"","broadcast":true,"body":"<their words if already said>","destination":"","needs_confirm":false}}
If they want location sent: {{"intent":"SEND_LOCATION","spoken":"Okay.","target":"","broadcast":true,"body":"","destination":"","needs_confirm":false}}
If they want the camera described: {{"intent":"DESCRIBE","spoken":"Okay.","target":"","broadcast":false,"body":"","destination":"","needs_confirm":false}}
Named person only in target if they said that name. contacts/anyone/everyone => broadcast true and target "".
Never say you cannot find contacts. Hello is never SEND or CALL.
intent must be one of: {intents}
"""

_CHAT_NORMALIZE = re.compile(r"[^\w\s']+", re.I)
_SMALL_TALK = {
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
}


class GroqServiceError(RuntimeError):
    def __init__(self, message: str = "I could not understand that command. Please try again."):
        super().__init__(message)


def small_talk_reply(speech: str) -> str | None:
    text = " ".join(_CHAT_NORMALIZE.sub(" ", speech or "").lower().split())
    if not text:
        return None
    if text in _SMALL_TALK or text.startswith("how are you"):
        return "I'm doing good, and you?"
    if text in {"thanks", "thank you", "thanks a lot", "thank you so much"}:
        return "You're welcome."
    return None


def _parse_command_json(text: str) -> dict:
    cleaned = (text or "").strip()
    cleaned = re.sub(r"^```(?:json)?", "", cleaned, flags=re.I).strip()
    cleaned = re.sub(r"```$", "", cleaned).strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        raise GroqServiceError("Command AI returned an invalid result.")
    data = json.loads(cleaned[start : end + 1])
    if not isinstance(data, dict):
        raise GroqServiceError("Command AI returned an invalid result.")
    return data


class GroqService:
    def __init__(self, api_key: str, model_name: str):
        self.api_key = api_key
        self.model_name = model_name

    def available(self) -> bool:
        from app.services.key_store import active_secrets

        return bool(self.api_key or active_secrets("groq"))

    def _secrets(self):
        from app.services.key_store import active_secrets

        keys = active_secrets("groq")
        if not keys and self.api_key:
            keys = [(None, self.api_key)]
        return keys

    def _post(self, api_key: str, body: dict, timeout: int):
        return requests.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=body,
            timeout=timeout,
        )

    def ping_chat(self, speech: str, *, only_key: str | None = None, key_row=None) -> dict:
        """Hit Groq for a real one-line chat reply and return elapsed ms."""
        import time

        from app.services.key_store import mark_error, mark_ok

        started = time.perf_counter()
        keys = [(key_row, only_key)] if only_key else self._secrets()
        if not keys:
            return {"ok": False, "reply": "Groq API key is missing.", "ms": 0}
        question = (speech or "").strip() or "How are you doing?"
        body = {
            "model": self.model_name,
            "temperature": 0.4,
            "max_tokens": 80,
            "reasoning_effort": "none",
            "messages": [
                {
                    "role": "system",
                    "content": "Reply in one short friendly spoken sentence. No JSON.",
                },
                {"role": "user", "content": question},
            ],
        }
        last_reply = "Groq did not answer."
        for row, api_key in keys:
            try:
                response = self._post(api_key, body, 6)
            except requests.RequestException as exc:
                log_error("GROQ_PING_ERROR", exc)
                mark_error(row, type(exc).__name__)
                last_reply = f"Groq did not answer: {exc}"
                continue
            if response.status_code >= 400 and "reasoning_effort" in (response.text or "") and "reasoning_effort" in body:
                body.pop("reasoning_effort", None)
                try:
                    response = self._post(api_key, body, 6)
                except requests.RequestException as exc:
                    log_error("GROQ_PING_ERROR", exc)
                    mark_error(row, type(exc).__name__)
                    last_reply = f"Groq did not answer: {exc}"
                    continue
            if response.status_code in {401, 403, 429}:
                mark_error(row, f"HTTP {response.status_code}")
                last_reply = f"Groq HTTP {response.status_code}"
                continue
            if response.status_code >= 400:
                log_error("GROQ_PING_HTTP", Exception(response.text[:300]), status=response.status_code)
                last_reply = f"Groq HTTP {response.status_code}"
                continue
            text = (
                (((response.json().get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
            ).strip()
            ms = int((time.perf_counter() - started) * 1000)
            if not text:
                last_reply = "Groq returned an empty reply."
                continue
            mark_ok(row)
            log_event("GROQ_PING_SUCCESS", ms=ms)
            return {"ok": True, "reply": text, "ms": ms}
        ms = int((time.perf_counter() - started) * 1000)
        return {"ok": False, "reply": last_reply, "ms": ms}

    def _complete(self, prompt: str) -> str:
        from app.services.key_store import mark_error, mark_ok

        log_event("GROQ_COMMAND_REQUEST", model=self.model_name)
        keys = self._secrets()
        if not keys:
            raise GroqServiceError("Groq API key is not configured.")
        body = {
            "model": self.model_name,
            "temperature": 0.2,
            "max_tokens": 180,
            "reasoning_effort": "none",
            "response_format": {"type": "json_object"},
            "messages": [
                {
                    "role": "system",
                    "content": "Return one JSON object. Be fast. No extra text.",
                },
                {"role": "user", "content": prompt},
            ],
        }
        last_error: Exception | None = None
        for row, api_key in keys:
            try:
                response = self._post(api_key, body, COMMAND_TIMEOUT_SEC)
            except requests.Timeout as exc:
                log_error("GROQ_COMMAND_TIMEOUT", exc)
                mark_error(row, "Timed out")
                last_error = exc
                continue
            except requests.RequestException as exc:
                log_error("GROQ_COMMAND_ERROR", exc)
                mark_error(row, type(exc).__name__)
                last_error = exc
                continue
            if response.status_code in {401, 403, 429}:
                log_error("GROQ_COMMAND_HTTP", Exception(response.text[:300]), status=response.status_code)
                mark_error(row, f"HTTP {response.status_code}")
                last_error = GroqServiceError("I could not understand that command. Please try again.")
                continue
            if response.status_code >= 400:
                log_error("GROQ_COMMAND_HTTP", Exception(response.text[:300]), status=response.status_code)
                last_error = GroqServiceError("I could not understand that command. Please try again.")
                continue
            payload = response.json()
            text = (
                (((payload.get("choices") or [{}])[0].get("message") or {}).get("content")) or ""
            ).strip()
            if not text:
                last_error = GroqServiceError("Command AI returned an empty result.")
                continue
            mark_ok(row)
            log_event("GROQ_COMMAND_SUCCESS")
            return text
        if isinstance(last_error, GroqServiceError):
            raise last_error
        raise GroqServiceError("I could not understand that command. Please try again.") from last_error

    def plan_command(self, speech: str, contacts: list[dict] | None = None) -> dict:
        chat = small_talk_reply(speech)
        if chat:
            return {
                "intent": "REPLY",
                "confidence": 0.99,
                "slots": {"target": "", "body": "", "destination": "", "broadcast": False},
                "spoken": chat,
                "needs_confirm": False,
                "original_text": (speech or "").strip(),
            }
        names = []
        for item in contacts or []:
            label = item.get("name") or "Contact"
            relation = item.get("relationship") or ""
            names.append(f"{label}" + (f" ({relation})" if relation else ""))
        contact_block = ", ".join(names) if names else "the group"
        prompt = COMMAND_PROMPT.format(
            intents=", ".join(COMMAND_INTENTS),
            contacts=contact_block,
            speech=(speech or "").strip(),
        )
        data = _parse_command_json(self._complete(prompt))
        intent = str(data.get("intent") or "UNKNOWN").strip().upper()
        if intent not in COMMAND_INTENTS:
            intent = "REPLY" if str(data.get("spoken") or "").strip() else "UNKNOWN"
        from app.services.share_location_service import is_broadcast_target

        target = str(data.get("target") or "").strip()
        broadcast = bool(data.get("broadcast")) or not target or is_broadcast_target(target)
        if intent == "CALL" and broadcast:
            target = ""
            broadcast = False
        if intent == "DELETE_CONTACT":
            broadcast = False
        elif broadcast:
            target = ""
        spoken = str(data.get("spoken") or "").strip()
        if intent == "REPLY" and not spoken:
            spoken = "I'm doing good, and you?"
        return {
            "intent": intent,
            "confidence": 0.96,
            "slots": {
                "target": "" if broadcast and intent != "DELETE_CONTACT" else target,
                "body": str(data.get("body") or "").strip(),
                "destination": str(data.get("destination") or "").strip(),
                "broadcast": broadcast,
            },
            "spoken": spoken,
            "needs_confirm": bool(data.get("needs_confirm")) or intent == "DELETE_CONTACT",
            "original_text": (speech or "").strip(),
        }


def get_groq_service() -> GroqService:
    from flask import current_app

    return GroqService(
        api_key=current_app.config.get("GROQ_API_KEY", ""),
        model_name=current_app.config.get("GROQ_MODEL", "qwen/qwen3.8-27b"),
    )
