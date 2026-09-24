"""Gemini vision only: describe, read, and answer questions about a photo."""

from __future__ import annotations

import base64
import io
import re

import requests
from PIL import Image

from app.utils.logging import log_error, log_event

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
VISION_TIMEOUT_SEC = 45
_DESCRIBE_IMAGE_SIDE = 960
_READ_IMAGE_SIDE = 1280
_FAST_VISION_MODEL = "gemini-2.5-flash"
_FALLBACK_VISION_MODELS = (
    "gemini-2.0-flash",
    "gemini-flash-latest",
    "gemini-1.5-flash",
    "gemini-3.1-flash-lite",
)


class GeminiServiceError(RuntimeError):
    def __init__(self, message: str = "Vision service temporarily unavailable."):
        super().__init__(message)


READ_PROMPT = """You are assisting a blind user. Read only the page, paper, document, book, menu, sign, or screen that is facing the camera and filling most of the view.
Ignore the room, furniture, hands, people, and anything around that page.
Read the text in a natural order, clearly, as if reading it aloud.
If there is no readable page or text in front of the camera, say you cannot see a page to read.
Do not invent text."""

DESCRIBE_PROMPT = """You are the eyes of a blind person. Describe what is actually in this camera photo.

Speak 2 to 4 short sentences, as if you are standing next to them.
First say the setting: indoors or outdoors, and the kind of place if it is clear (room, kitchen, street, shop, office).
Then describe the main things in view: people, furniture, screens, doors, windows, objects in the path, and what is happening.
Use plain spoken English. Do not list colors unless they help. Do not invent objects. If the photo is too dark or blurry, say that."""

QUESTION_PROMPT = """You are assisting a blind user. Answer the user's question about this image in one or two short spoken sentences.
If you are not sure, say you are not sure. Do not invent details.
User question: {question}"""


def _prepare_jpeg(image: Image.Image, max_side: int = _DESCRIBE_IMAGE_SIDE) -> bytes:
    rgb = image.convert("RGB")
    if max(rgb.size) > max_side:
        rgb.thumbnail((max_side, max_side))
    quality = 78
    buf = io.BytesIO()
    rgb.save(buf, format="JPEG", quality=quality)
    data = buf.getvalue()
    while len(data) > 1_200_000 and quality > 50:
        quality -= 8
        buf = io.BytesIO()
        rgb.save(buf, format="JPEG", quality=quality)
        data = buf.getvalue()
    return data


def _first_sentences(text: str, count: int = 4) -> str:
    cleaned = " ".join((text or "").split())
    if not cleaned:
        return ""
    parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", cleaned) if part.strip()]
    if len(parts) <= count:
        return cleaned
    return " ".join(parts[:count]).strip()


def _parts_text(payload: dict) -> str:
    bits = []
    for candidate in payload.get("candidates") or []:
        content = candidate.get("content") or {}
        for part in content.get("parts") or []:
            if part.get("thought"):
                continue
            text = (part.get("text") or "").strip()
            if text:
                bits.append(text)
    return "\n".join(bits).strip()


class GeminiService:
    def __init__(self, api_key: str, model_name: str):
        self.api_key = api_key
        self.model_name = model_name

    def available(self) -> bool:
        from app.services.key_store import active_secrets

        return bool(self.api_key or active_secrets("gemini"))

    def _models_to_try(self) -> list[str]:
        ordered = [_FAST_VISION_MODEL, self.model_name, *_FALLBACK_VISION_MODELS]
        unique: list[str] = []
        seen: set[str] = set()
        for name in ordered:
            if name and name not in seen:
                seen.add(name)
                unique.append(name)
        return unique

    def _post(self, model_name: str, prompt: str, jpeg: bytes, max_tokens: int, api_key: str):
        body = {
            "contents": [
                {
                    "parts": [
                        {"text": prompt},
                        {
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": base64.b64encode(jpeg).decode("ascii"),
                            }
                        },
                    ]
                }
            ],
            "generationConfig": {
                "temperature": 0.4,
                "maxOutputTokens": max_tokens,
            },
        }
        return requests.post(
            GEMINI_URL.format(model=model_name),
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json=body,
            timeout=VISION_TIMEOUT_SEC,
        )

    def _generate(
        self,
        prompt: str,
        image: Image.Image,
        max_tokens: int = 1024,
        *,
        only_key: str | None = None,
        key_row=None,
        max_side: int = _DESCRIBE_IMAGE_SIDE,
    ) -> str:
        from app.services.key_store import active_secrets, mark_error, mark_ok

        if only_key:
            keys = [(key_row, only_key)]
        else:
            keys = active_secrets("gemini")
            if not keys and self.api_key:
                keys = [(None, self.api_key)]
        if not keys:
            raise GeminiServiceError("Gemini API key is not configured.")
        jpeg = _prepare_jpeg(image, max_side=max_side)
        last_error: Exception | None = None
        key_failed = False
        for row, api_key in keys:
            for model_name in self._models_to_try():
                log_event("GEMINI_REQUEST", model=model_name, max_tokens=max_tokens)
                try:
                    response = self._post(model_name, prompt, jpeg, max_tokens, api_key)
                except requests.Timeout as exc:
                    log_event("GEMINI_TIMEOUT", seconds=VISION_TIMEOUT_SEC, model=model_name)
                    last_error = exc
                    mark_error(row, "Timed out")
                    key_failed = True
                    break
                except requests.RequestException as exc:
                    log_error("GEMINI_ERROR", exc)
                    last_error = exc
                    mark_error(row, type(exc).__name__)
                    key_failed = True
                    break
                if response.status_code in {401, 403, 429}:
                    log_event("GEMINI_HTTP_ERROR", status=response.status_code, model=model_name)
                    mark_error(row, f"HTTP {response.status_code}")
                    last_error = GeminiServiceError("I'm having trouble processing the image. Please try again.")
                    key_failed = True
                    break
                if response.status_code >= 400:
                    log_event("GEMINI_HTTP_ERROR", status=response.status_code, model=model_name)
                    last_error = GeminiServiceError("I'm having trouble processing the image. Please try again.")
                    continue
                try:
                    payload = response.json()
                except ValueError as exc:
                    log_event("GEMINI_BAD_JSON", model=model_name)
                    last_error = exc
                    continue
                text = _parts_text(payload)
                if not text:
                    log_event("GEMINI_EMPTY", model=model_name)
                    last_error = GeminiServiceError("I could not see the photo clearly. Please try again.")
                    continue
                mark_ok(row)
                log_event("GEMINI_SUCCESS", model=model_name, chars=len(text))
                return text
            if key_failed:
                key_failed = False
                continue
        if isinstance(last_error, requests.Timeout):
            raise GeminiServiceError("Vision is taking too long. Please try again.") from last_error
        if isinstance(last_error, GeminiServiceError):
            raise last_error
        raise GeminiServiceError("I'm having trouble processing the image. Please try again.") from last_error

    def read_text(self, image: Image.Image) -> dict:
        text = self._generate(READ_PROMPT, image, max_tokens=2048, max_side=_READ_IMAGE_SIDE)
        uncertain = any(
            phrase in text.lower()
            for phrase in ["cannot read", "can't read", "unclear", "not readable", "no text"]
        )
        return {"text": text, "uncertain": uncertain}

    def describe(self, image: Image.Image, *, only_key: str | None = None, key_row=None) -> dict:
        text = _first_sentences(
            self._generate(DESCRIBE_PROMPT, image, max_tokens=640, only_key=only_key, key_row=key_row),
            4,
        )
        return {"description": text}

    def ping_describe(self, image: Image.Image, *, only_key: str | None = None, key_row=None) -> dict:
        import time

        started = time.perf_counter()
        from app.services.key_store import active_secrets

        if not only_key and not self.api_key and not active_secrets("gemini"):
            return {"ok": False, "reply": "Gemini API key is missing.", "ms": 0}
        try:
            text = self.describe(image, only_key=only_key, key_row=key_row).get("description") or ""
        except GeminiServiceError as exc:
            ms = int((time.perf_counter() - started) * 1000)
            return {"ok": False, "reply": str(exc), "ms": ms}
        ms = int((time.perf_counter() - started) * 1000)
        if not text:
            return {"ok": False, "reply": "Gemini returned an empty description.", "ms": ms}
        log_event("GEMINI_PING_SUCCESS", ms=ms)
        return {"ok": True, "reply": text, "ms": ms}

    def answer(self, image: Image.Image, question: str, *, only_key: str | None = None, key_row=None) -> dict:
        prompt = QUESTION_PROMPT.format(question=question.strip())
        text = self._generate(prompt, image, only_key=only_key, key_row=key_row, max_tokens=640)
        return {"answer": text}


_service: GeminiService | None = None


def get_gemini_service() -> GeminiService:
    global _service
    from flask import current_app

    if _service is None:
        _service = GeminiService(
            api_key=current_app.config.get("GEMINI_API_KEY", ""),
            model_name=current_app.config.get("GEMINI_MODEL", "gemini-3.6-flash"),
        )
    return _service
