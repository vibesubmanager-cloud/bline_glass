"""Daily.co rooms and meeting tokens. The master API key never leaves the server."""

from __future__ import annotations

import time

import requests
from flask import current_app

from app.services.key_store import active_secrets, mark_error, mark_ok
from app.utils.logging import log_event

DAILY_API = "https://api.daily.co/v1"


class DailyServiceError(RuntimeError):
    def __init__(self, message: str, code: str = "CALL_FAILED"):
        super().__init__(message)
        self.code = code


def _secret() -> tuple:
    secrets = active_secrets("daily")
    if secrets:
        return secrets[0]
    env_value = (current_app.config.get("DAILY_API_KEY") or "").strip()
    if env_value:
        return None, env_value
    return None, ""


def daily_configured() -> bool:
    return bool(_secret()[1])


def _headers(api_key: str) -> dict:
    return {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}


def ping_daily(api_key: str) -> dict:
    try:
        response = requests.get(f"{DAILY_API}/", headers=_headers(api_key), timeout=12)
    except requests.RequestException:
        return {"ok": False, "reply": "I could not reach Daily. Try again in a moment."}
    if response.status_code >= 400:
        return {"ok": False, "reply": "That Daily key did not work."}
    return {"ok": True, "reply": "Daily key works."}


def create_room(call_id: str) -> dict:
    row, api_key = _secret()
    if not api_key:
        raise DailyServiceError(
            "Calling is not set up yet. Add the Daily API key in Admin.",
            "CALL_NOT_CONFIGURED",
        )
    room_name = f"ais-{call_id.replace('-', '')[:28]}"
    exp = int(time.time()) + 2 * 3600
    try:
        response = requests.post(
            f"{DAILY_API}/rooms",
            headers=_headers(api_key),
            json={
                "name": room_name,
                "privacy": "private",
                "properties": {
                    "exp": exp,
                    "eject_at_room_exp": True,
                    "max_participants": 4,
                    "enable_chat": False,
                    "enable_recording": False,
                    "start_audio_off": False,
                    "start_video_off": False,
                },
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        mark_error(row, "Daily room request failed")
        log_event("DAILY_ROOM_ERROR", error=type(exc).__name__)
        raise DailyServiceError("Unable to start the call. Please try again.") from exc
    if response.status_code in {401, 403}:
        mark_error(row, "Daily key rejected")
        log_event("DAILY_ROOM_HTTP", status=response.status_code)
        raise DailyServiceError(
            "Calling is not set up yet. Add the Daily API key in Admin.",
            "CALL_NOT_CONFIGURED",
        )
    if response.status_code >= 400:
        mark_error(row, "Daily room create failed")
        log_event("DAILY_ROOM_HTTP", status=response.status_code)
        raise DailyServiceError("Unable to start the call. Please try again.")
    data = response.json() if response.content else {}
    url = data.get("url") or ""
    name = data.get("name") or room_name
    if not url:
        raise DailyServiceError("Unable to start the call. Please try again.")
    mark_ok(row)
    log_event("DAILY_ROOM_CREATED", call_id=call_id)
    return {"name": name, "url": url}


def meeting_token(room_name: str, user, *, video: bool) -> str:
    row, api_key = _secret()
    if not api_key:
        raise DailyServiceError(
            "Calling is not set up yet. Add the Daily API key in Admin.",
            "CALL_NOT_CONFIGURED",
        )
    exp = int(time.time()) + 2 * 3600
    try:
        response = requests.post(
            f"{DAILY_API}/meeting-tokens",
            headers=_headers(api_key),
            json={
                "properties": {
                    "room_name": room_name,
                    "user_id": user.id,
                    "user_name": (user.name or "vibeEye")[:40],
                    "exp": exp,
                    "enable_screenshare": False,
                    "start_video_off": not video,
                    "start_audio_off": False,
                }
            },
            timeout=15,
        )
    except requests.RequestException as exc:
        mark_error(row, "Daily token request failed")
        log_event("DAILY_TOKEN_ERROR", error=type(exc).__name__)
        raise DailyServiceError("Unable to start the call. Please try again.") from exc
    if response.status_code in {401, 403}:
        mark_error(row, "Daily key rejected")
        log_event("DAILY_TOKEN_HTTP", status=response.status_code)
        raise DailyServiceError(
            "Calling is not set up yet. Add the Daily API key in Admin.",
            "CALL_NOT_CONFIGURED",
        )
    if response.status_code >= 400:
        mark_error(row, "Daily token create failed")
        log_event("DAILY_TOKEN_HTTP", status=response.status_code)
        raise DailyServiceError("Unable to start the call. Please try again.")
    token = (response.json() or {}).get("token") or ""
    if not token:
        raise DailyServiceError("Unable to start the call. Please try again.")
    mark_ok(row)
    return token


def delete_room(room_name: str) -> None:
    if not room_name:
        return
    _row, api_key = _secret()
    if not api_key:
        return
    try:
        requests.delete(f"{DAILY_API}/rooms/{room_name}", headers=_headers(api_key), timeout=10)
        log_event("DAILY_ROOM_DELETED")
    except requests.RequestException:
        log_event("DAILY_ROOM_DELETE_FAILED")
