"""Application-level call sessions. Daily transports the live audio and video."""

from __future__ import annotations

import json
from collections import defaultdict, deque
from datetime import datetime, timezone

from app.extensions import db
from app.models.call import CallSession, CallSignal
from app.models.contact import Contact
from app.models.user import User
from app.services.daily_service import DailyServiceError, create_room, delete_room, meeting_token
from app.utils.logging import log_event

_mailboxes: dict[str, deque] = defaultdict(lambda: deque(maxlen=50))


def persist_signal(target_user_id: str, message: dict) -> None:
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


def require_call_party(call_id: str, user_id: str) -> CallSession:
    session = db.session.get(CallSession, call_id)
    if not session or user_id not in {session.caller_id, session.callee_id}:
        raise CallingServiceError("Call not found.", "CALL_NOT_FOUND")
    return session


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


def _daily_payload(session: CallSession, user) -> dict:
    video = session.call_type == "video"
    token = meeting_token(session.daily_room_name, user, video=video)
    return {"url": session.daily_room_url, "token": token, "video": video}


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

    daily = None
    if call_type in {"webrtc", "video"}:
        try:
            room = create_room(session.id)
            session.daily_room_name = room["name"]
            session.daily_room_url = room["url"]
            db.session.commit()
            daily = _daily_payload(session, caller)
        except DailyServiceError as exc:
            session.status = "failed"
            session.ended_at = datetime.now(timezone.utc)
            db.session.commit()
            raise CallingServiceError(str(exc), exc.code) from exc

    log_event("CALL_STARTED", call_id=session.id, call_type=call_type)
    return {
        "call": session.public_dict(),
        "contact": contact.public_dict(),
        "daily": daily,
        "tel_url": f"tel:{contact.phone}" if contact.phone and call_type == "tel" else None,
    }


def accept_call(call_id: str, user: User) -> dict:
    session = set_call_status(call_id, user.id, "active")
    if not session.daily_room_name or not session.daily_room_url:
        raise CallingServiceError("Unable to start the call. Please try again.")
    return {"call": session.public_dict(), "daily": _daily_payload(session, user)}


def set_call_status(call_id: str, user_id: str, status: str) -> CallSession:
    session = db.session.get(CallSession, call_id)
    if not session or user_id not in {session.caller_id, session.callee_id}:
        raise CallingServiceError("Call not found.", "CALL_NOT_FOUND")
    session.status = status
    if status in {"ended", "rejected", "missed", "failed"}:
        session.ended_at = datetime.now(timezone.utc)
        room_name = session.daily_room_name
        session.daily_room_name = session.daily_room_name
        db.session.commit()
        delete_room(room_name)
    else:
        db.session.commit()
    log_event("CALL_STATUS", call_id=call_id, status=status)
    return session
