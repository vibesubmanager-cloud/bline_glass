"""Application-level call sessions. Jitsi Meet carries live audio and video."""

from __future__ import annotations

import json
import uuid
from collections import defaultdict, deque
from datetime import datetime, timezone

from app.extensions import db
from app.models.call import CallSession, CallSignal
from app.models.contact import Contact
from app.models.user import User
from app.utils.logging import log_event

JITSI_DOMAIN = "meet.jit.si"
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


def _is_group_session(session: CallSession) -> bool:
    kind = session.call_type or ""
    return kind.startswith("g") or kind.startswith("e")


def _admin_ids() -> list[str]:
    return [row.id for row in User.query.filter_by(role="admin", is_active=True).all()]


def family_user_ids(owner_id: str) -> list[str]:
    ids = []
    seen = set()
    for contact in Contact.query.filter_by(user_id=owner_id).all():
        uid = contact.linked_user_id
        if uid and uid != owner_id and uid not in seen:
            seen.add(uid)
            ids.append(uid)
    for helper in User.query.filter_by(role="assistant", linked_blind_user_id=owner_id, is_active=True).all():
        if helper.id != owner_id and helper.id not in seen:
            seen.add(helper.id)
            ids.append(helper.id)
    return ids


def ring_user_ids(caller: User, emergency: bool = False) -> list[str]:
    if emergency:
        return [admin_id for admin_id in _admin_ids() if admin_id != caller.id]
    owner_id = caller.linked_blind_user_id if caller.role == "assistant" and caller.linked_blind_user_id else caller.id
    ids = family_user_ids(owner_id)
    if caller.role == "assistant" and owner_id not in ids and owner_id != caller.id:
        ids.insert(0, owner_id)
    return [item for item in ids if item != caller.id]


def can_join_call(session: CallSession, user_id: str) -> bool:
    if user_id in {session.caller_id, session.callee_id}:
        return True
    if not _is_group_session(session):
        return False
    if (session.call_type or "").startswith("e"):
        return user_id in _admin_ids() or user_id == session.caller_id
    caller = db.session.get(User, session.caller_id)
    owners = [session.caller_id]
    if caller and caller.role == "assistant" and caller.linked_blind_user_id:
        owners.append(caller.linked_blind_user_id)
    for owner_id in owners:
        if user_id == owner_id or user_id in family_user_ids(owner_id):
            return True
    return False


def require_call_party(call_id: str, user_id: str) -> CallSession:
    session = db.session.get(CallSession, call_id)
    if not session or not can_join_call(session, user_id):
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


def _new_jitsi_room() -> str:
    return f"aidobot-call-{uuid.uuid4().hex}"


def _jitsi_payload(session: CallSession) -> dict:
    return {
        "domain": JITSI_DOMAIN,
        "room": session.jitsi_room_name,
        "video": (session.call_type or "") in {"video", "gvideo", "evideo"},
    }


def start_call(caller: User, contact: Contact, media: str = "audio") -> dict:
    video = (media or "audio").strip().lower() == "video"
    callee = None
    if contact.linked_user_id:
        callee = db.session.get(User, contact.linked_user_id)
    elif contact.phone:
        callee = User.query.filter_by(phone=contact.phone).first()

    if video and (not callee or callee.id == caller.id):
        raise CallingServiceError(
            f"{contact.name} cannot video call yet. They need an vibeEye account, like a family assistant.",
            "VIDEO_UNAVAILABLE",
        )

    if (not callee or callee.id == caller.id) and not contact.phone:
        raise CallingServiceError(
            "That contact has no phone number and is not a vibeEye user.",
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
        jitsi_room_name=_new_jitsi_room() if call_type in {"webrtc", "video"} else None,
    )
    db.session.add(session)
    db.session.commit()
    log_event("CALL_STARTED", call_id=session.id, call_type=call_type)
    return {
        "call": session.public_dict(),
        "contact": contact.public_dict(),
        "jitsi": _jitsi_payload(session) if session.jitsi_room_name else None,
        "tel_url": f"tel:{contact.phone}" if contact.phone and call_type == "tel" else None,
        "ring_user_ids": [callee.id] if callee and callee.id != caller.id and call_type in {"webrtc", "video"} else [],
    }


def start_group_call(caller: User, media: str = "audio", emergency: bool = False) -> dict:
    video = (media or "audio").strip().lower() == "video" or emergency
    targets = ring_user_ids(caller, emergency=emergency)
    if not targets:
        raise CallingServiceError(
            "Emergency admin is not available. Set an admin account on the server.",
            "CONTACT_NOT_FOUND",
        ) if emergency else CallingServiceError(
            "Add family who can sign in to vibeEye, so the in-app video call can ring them.",
            "CONTACT_NOT_FOUND",
        )
    call_type = ("e" if emergency else "g") + ("video" if video else "webrtc")
    session = CallSession(
        caller_id=caller.id,
        callee_id=targets[0],
        contact_id=None,
        call_type=call_type,
        status="ringing",
        jitsi_room_name=_new_jitsi_room(),
    )
    db.session.add(session)
    db.session.commit()
    log_event("GROUP_CALL_STARTED", call_id=session.id, call_type=call_type, rings=len(targets))
    for uid in targets:
        post_signal(
            uid,
            {
                "from_user_id": caller.id,
                "from_name": caller.name,
                "call_id": session.id,
                "signal_type": "ring",
                "media": "video" if video else "audio",
                "emergency": emergency,
            },
        )
    label = "emergency admin" if emergency else "your family group"
    spoken = "Starting an emergency video call to admin." if emergency else (
        "Starting a video call to your group." if video else "Calling your group. Anyone who is free can pick up."
    )
    return {
        "call": session.public_dict(),
        "contact": {"name": label},
        "jitsi": _jitsi_payload(session),
        "tel_url": None,
        "ring_user_ids": targets,
        "group": True,
        "emergency": emergency,
        "spoken": spoken,
    }


def accept_call(call_id: str, user: User) -> dict:
    session = set_call_status(call_id, user.id, "active")
    if not session.jitsi_room_name:
        raise CallingServiceError("Unable to connect the call. Please try again.")
    return {"call": session.public_dict(), "jitsi": _jitsi_payload(session)}


def set_call_status(call_id: str, user_id: str, status: str) -> CallSession:
    session = db.session.get(CallSession, call_id)
    if not session or not can_join_call(session, user_id):
        raise CallingServiceError("Call not found.", "CALL_NOT_FOUND")
    if status == "rejected" and _is_group_session(session) and user_id != session.caller_id:
        return session
    session.status = status
    if status in {"ended", "rejected", "missed", "failed"}:
        session.ended_at = datetime.now(timezone.utc)
    db.session.commit()
    log_event("CALL_STATUS", call_id=call_id, status=status)
    return session
