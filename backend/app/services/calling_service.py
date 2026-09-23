"""Call signaling helpers. Live media is WebRTC; HTTP mailbox is ICE fallback only."""

from __future__ import annotations

import json
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from flask import current_app

from app.extensions import db
from app.models.call import CallSession, CallSignal
from app.models.contact import Contact
from app.models.user import User
from app.utils.logging import log_event

_mailboxes: dict[str, deque] = defaultdict(lambda: deque(maxlen=50))
_call_video: dict[str, dict[str, str]] = defaultdict(dict)
_call_audio: dict[str, dict[str, deque]] = defaultdict(lambda: defaultdict(lambda: deque(maxlen=24)))
_media_lock = threading.Lock()
_ice_cache: dict = {"at": 0.0, "servers": None}


def put_call_media(call_id: str, user_id: str, kind: str, data: str) -> None:
    with _media_lock:
        if kind == "video":
            _call_video[call_id][user_id] = data
            return
        if kind == "audio" and data:
            _call_audio[call_id][user_id].append(data)


def take_call_media(call_id: str, user_id: str) -> dict:
    video = None
    audio: list[str] = []
    with _media_lock:
        for other_id, frame in _call_video.get(call_id, {}).items():
            if other_id != user_id and frame:
                video = frame
        for other_id, chunks in _call_audio.get(call_id, {}).items():
            if other_id != user_id:
                while chunks:
                    audio.append(chunks.popleft())
    return {"video": video, "audio": audio}


def clear_call_media(call_id: str) -> None:
    with _media_lock:
        _call_video.pop(call_id, None)
        _call_audio.pop(call_id, None)


def require_call_party(call_id: str, user_id: str) -> CallSession:
    session = db.session.get(CallSession, call_id)
    if not session or user_id not in {session.caller_id, session.callee_id}:
        raise CallingServiceError("Call not found.", "CALL_NOT_FOUND")
    return session


def persist_signal(target_user_id: str, message: dict) -> None:
    """HTTP poll backup. Socket.IO is optional and must not be the only path."""
    try:
        row = CallSignal(target_user_id=target_user_id, payload=json.dumps(message))
        db.session.add(row)
        db.session.commit()
        return
    except Exception:
        db.session.rollback()
        log_event("CALL_SIGNAL_STORE_FAILED", target_user_id=target_user_id)
        _mailboxes[target_user_id].append(message)


def post_signal(target_user_id: str, message: dict, emit: bool = True) -> None:
    persist_signal(target_user_id, message)
    if not emit:
        return
    try:
        from app.extensions import socketio

        socketio.emit("call-signal", message, room=f"user:{target_user_id}")
    except Exception:
        pass


def drain_signals(user_id: str) -> list[dict]:
    items: list[dict] = []
    try:
        rows = (
            CallSignal.query.filter_by(target_user_id=user_id)
            .order_by(CallSignal.created_at.asc())
            .all()
        )
        for row in rows:
            try:
                items.append(json.loads(row.payload))
            except Exception:
                continue
            db.session.delete(row)
        if rows:
            db.session.commit()
    except Exception:
        db.session.rollback()
    box = _mailboxes.get(user_id)
    if box:
        items.extend(list(box))
        box.clear()
    return items


class CallingServiceError(RuntimeError):
    def __init__(self, message: str, code: str = "CALL_FAILED"):
        super().__init__(message)
        self.code = code


def _flatten_ice(servers: list[dict]) -> list[dict]:
    """Safari is unreliable when urls is an array."""
    flat: list[dict] = []
    seen: set[str] = set()
    for server in servers:
        urls = server.get("urls") or server.get("url") or []
        if isinstance(urls, str):
            urls = [urls]
        for url in urls:
            if not url or url in seen:
                continue
            seen.add(url)
            item: dict = {"urls": url}
            if server.get("username"):
                item["username"] = server["username"]
                item["credential"] = server.get("credential") or server.get("password") or ""
            flat.append(item)
    return flat


def _twilio_ice_servers() -> list[dict]:
    sid = (current_app.config.get("TWILIO_ACCOUNT_SID") or "").strip()
    token = (current_app.config.get("TWILIO_AUTH_TOKEN") or "").strip()
    if not sid or not token:
        return []
    now = time.time()
    cached = _ice_cache.get("servers")
    if cached and now - float(_ice_cache.get("at") or 0) < 300:
        return cached
    try:
        from twilio.rest import Client

        ice = Client(sid, token).tokens.create().ice_servers or []
        servers = _flatten_ice(list(ice))
        _ice_cache["servers"] = servers
        _ice_cache["at"] = now
        log_event("CALL_ICE_TWILIO", stun=sum(1 for s in servers if str(s.get("urls", "")).startswith("stun")), turn=sum(1 for s in servers if "turn:" in str(s.get("urls", "")).lower()))
        return servers
    except Exception as exc:
        log_event("CALL_ICE_TWILIO_FAILED", error=type(exc).__name__)
        return []


def ice_servers() -> list[dict]:
    """STUN always. TURN only from TURN_* or Twilio Network Traversal — never fake public relays."""
    servers: list[dict] = [
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
        {"urls": "stun:stun.cloudflare.com:3478"},
    ]
    turn_url = (current_app.config.get("TURN_URL") or "").strip()
    turn_user = current_app.config.get("TURN_USERNAME") or ""
    turn_pass = current_app.config.get("TURN_PASSWORD") or ""
    if turn_url:
        servers.append({"urls": turn_url, "username": turn_user, "credential": turn_pass})
        return _flatten_ice(servers)
    twilio = _twilio_ice_servers()
    if twilio:
        return _flatten_ice(servers + twilio)
    return _flatten_ice(servers)


def resolve_contact_for_call(owner_id: str, target: str) -> Contact:
    from app.services.share_location_service import find_matching_contact, is_broadcast_target, list_user_contacts

    if not (target or "").strip() or is_broadcast_target(target):
        raise CallingServiceError("Who should I call?", "CONTACT_NOT_FOUND")
    owner = db.session.get(User, owner_id)
    contacts = list_user_contacts(owner) if owner else []
    contact = find_matching_contact(contacts, target)
    if not contact:
        raise CallingServiceError("Who should I call?", "CONTACT_NOT_FOUND")
    return contact


def start_call(caller: User, contact: Contact, media: str = "audio") -> dict:
    video = (media or "audio").strip().lower() == "video"
    callee = None
    if contact.linked_user_id:
        callee = db.session.get(User, contact.linked_user_id)
    elif contact.phone:
        callee = User.query.filter_by(phone=contact.phone).first()

    if video and (not callee or callee.id == caller.id):
        raise CallingServiceError(
            f"{contact.name} cannot video call yet. They need an AI Sight account, like a family assistant.",
            "VIDEO_UNAVAILABLE",
        )

    if (not callee or callee.id == caller.id) and not contact.phone:
        raise CallingServiceError(
            "That contact has no phone number and is not a Vibe Eye user.",
            "CALL_FAILED",
        )

    if callee and callee.id != caller.id:
        call_type = "video" if video else "webrtc"
    else:
        call_type = "tel"
    session = CallSession(
        caller_id=caller.id,
        callee_id=callee.id if callee else None,
        contact_id=contact.id,
        call_type=call_type,
        status="ringing" if call_type in {"webrtc", "video"} else "dialing",
    )
    db.session.add(session)
    db.session.commit()
    log_event("CALL_STARTED", call_id=session.id, call_type=call_type)
    return {
        "call": session.public_dict(),
        "contact": contact.public_dict(),
        "ice_servers": ice_servers(),
        "tel_url": f"tel:{contact.phone}" if contact.phone and call_type == "tel" else None,
    }


def set_call_status(call_id: str, user_id: str, status: str) -> CallSession:
    session = db.session.get(CallSession, call_id)
    if not session or user_id not in {session.caller_id, session.callee_id}:
        raise CallingServiceError("Call not found.", "CALL_NOT_FOUND")
    session.status = status
    if status in {"ended", "rejected", "missed", "failed"}:
        session.ended_at = datetime.now(timezone.utc)
    db.session.commit()
    log_event("CALL_STATUS", call_id=call_id, status=status)
    if status in {"ended", "rejected", "missed", "failed"}:
        clear_call_media(call_id)
    return session
