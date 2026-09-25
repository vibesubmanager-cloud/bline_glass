"""Admin views of users, contacts, messages, and usage."""

from __future__ import annotations

from sqlalchemy import func, or_

from app.extensions import db
from app.models.call import CallSession
from app.models.contact import Contact
from app.models.emergency import EmergencyEvent
from app.models.message import Message
from app.models.usage import UsageLog
from app.models.user import User
from app.services.identity_service import display_name, unique_username
from app.utils.security import hash_password
from app.utils.validation import (
    ValidationError,
    optional_string,
    validate_email,
    validate_password,
    validate_phone,
    validate_username,
)


class AdminError(RuntimeError):
    def __init__(self, message: str, code: str = "ADMIN_ERROR", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def _user_summary(user: User) -> dict:
    data = user.public_dict()
    data["is_active"] = bool(user.is_active)
    data["contact_count"] = Contact.query.filter_by(user_id=user.id).count()
    data["message_count"] = Message.query.filter(
        or_(Message.sender_id == user.id, Message.recipient_id == user.id)
    ).count()
    if user.role == "blind":
        data["assistant_count"] = User.query.filter_by(
            role="assistant", linked_blind_user_id=user.id
        ).count()
    return data


def list_users(search: str = "", role: str = "") -> list[dict]:
    query = User.query.filter(User.role != "admin")
    needle = (search or "").strip().lower()
    if needle:
        like = f"%{needle}%"
        query = query.filter(
            or_(
                User.name.ilike(like),
                User.username.ilike(like),
                User.email.ilike(like),
                User.phone.ilike(like),
                User.system_id.ilike(like),
            )
        )
    if role in {"blind", "assistant"}:
        query = query.filter_by(role=role)
    rows = query.order_by(User.created_at.desc()).all()
    return [_user_summary(user) for user in rows]


def list_emergencies(limit: int = 40) -> list[dict]:
    admin_ids = [row.id for row in User.query.filter_by(role="admin", is_active=True).all()]
    events = EmergencyEvent.query.order_by(EmergencyEvent.started_at.desc()).limit(max(1, min(limit, 80))).all()
    live_calls = (
        CallSession.query.filter(CallSession.call_type.in_(["evideo", "ewebrtc"]))
        .filter(CallSession.status.in_(["ringing", "active"]))
        .order_by(CallSession.started_at.desc())
        .all()
    )
    seen_users = set()
    items = []

    def _messages_for(user_id: str) -> list:
        query = Message.query.filter(Message.sender_id == user_id)
        if admin_ids:
            query = query.filter(Message.recipient_id.in_(admin_ids))
        return query.order_by(Message.created_at.desc()).limit(6).all()

    def _call_for(user_id: str, preferred: CallSession | None = None) -> CallSession | None:
        if preferred:
            return preferred
        return (
            CallSession.query.filter_by(caller_id=user_id)
            .filter(CallSession.call_type.in_(["evideo", "ewebrtc"]))
            .order_by(CallSession.started_at.desc())
            .first()
        )

    def _pack(user_id: str, event: EmergencyEvent | None, call: CallSession | None) -> dict:
        person = db.session.get(User, user_id)
        last_messages = _messages_for(user_id)
        return {
            "event": event.public_dict() if event else {"status": call.status if call else "open", "started_at": call.started_at.isoformat() if call and call.started_at else None},
            "user": person.public_dict() if person else {},
            "call": call.public_dict() if call else None,
            "jitsi": {"domain": "meet.jit.si", "room": call.jitsi_room_name, "video": True}
            if call and call.jitsi_room_name
            else None,
            "messages": [row.public_dict(user_id) for row in last_messages],
        }

    for call in live_calls:
        if call.caller_id in seen_users:
            continue
        seen_users.add(call.caller_id)
        event = (
            EmergencyEvent.query.filter_by(user_id=call.caller_id)
            .order_by(EmergencyEvent.started_at.desc())
            .first()
        )
        items.append(_pack(call.caller_id, event, call))

    for event in events:
        if event.user_id in seen_users:
            continue
        seen_users.add(event.user_id)
        items.append(_pack(event.user_id, event, _call_for(event.user_id)))

    if len(items) < limit and admin_ids:
        extra = (
            Message.query.filter(Message.recipient_id.in_(admin_ids))
            .order_by(Message.created_at.desc())
            .limit(40)
            .all()
        )
        for row in extra:
            if row.sender_id in seen_users:
                continue
            sender = db.session.get(User, row.sender_id)
            if not sender or sender.role == "admin":
                continue
            seen_users.add(row.sender_id)
            items.append(_pack(row.sender_id, None, _call_for(row.sender_id)))
            if len(items) >= limit:
                break
    return items


def list_message_alerts(limit: int = 25) -> list[dict]:
    admin_ids = [row.id for row in User.query.filter_by(role="admin", is_active=True).all()]
    query = Message.query
    if admin_ids:
        query = query.filter(or_(Message.recipient_id.in_(admin_ids), Message.sender_id.in_(admin_ids)))
    rows = query.order_by(Message.created_at.desc()).limit(max(1, min(limit, 40))).all()
    items = []
    for row in rows:
        sender = db.session.get(User, row.sender_id)
        recipient = db.session.get(User, row.recipient_id)
        body = row.body or ""
        items.append(
            {
                "message": row.public_dict(row.sender_id),
                "from_name": sender.name if sender else "Someone",
                "to_name": recipient.name if recipient else "Emergency admin",
                "emergency": "emergency" in body.lower() or body.upper().startswith("EMERGENCY"),
            }
        )
    return items


def get_user_or_404(user_id: str) -> User:
    user = db.session.get(User, user_id)
    if not user or user.role == "admin":
        raise AdminError("I could not find that user.", "NOT_FOUND", 404)
    return user


def _peer_name(owner: User, peer: User | None) -> str:
    if not peer:
        return "Unknown"
    contact = Contact.query.filter_by(user_id=owner.id, linked_user_id=peer.id).first()
    return contact.name if contact else peer.name


def user_detail(user: User) -> dict:
    contacts = [item.public_dict() for item in Contact.query.filter_by(user_id=user.id).all()]
    assistants = []
    linked_blind = None
    if user.role == "blind":
        for helper in User.query.filter_by(role="assistant", linked_blind_user_id=user.id).all():
            assistants.append(
                {
                    "id": helper.id,
                    "name": helper.name,
                    "username": helper.username,
                    "email": helper.email,
                    "phone": helper.phone,
                    "relationship_to_blind": helper.relationship_to_blind,
                }
            )
    elif user.linked_blind_user_id:
        blind = db.session.get(User, user.linked_blind_user_id)
        if blind:
            linked_blind = {
                "id": blind.id,
                "name": blind.name,
                "username": blind.username,
                "system_id": blind.system_id,
                "phone": blind.phone,
            }

    messages = (
        Message.query.filter(or_(Message.sender_id == user.id, Message.recipient_id == user.id))
        .order_by(Message.created_at.desc())
        .all()
    )
    threads = []
    seen = set()
    for row in messages:
        if row.conversation_id in seen:
            continue
        seen.add(row.conversation_id)
        peer_id = row.recipient_id if row.sender_id == user.id else row.sender_id
        peer = db.session.get(User, peer_id)
        threads.append(
            {
                "peer": {
                    "id": peer_id,
                    "name": _peer_name(user, peer),
                    "username": peer.username if peer else None,
                    "role": peer.role if peer else None,
                    "phone": peer.phone if peer else None,
                },
                "last_message": row.public_dict(),
            }
        )

    usage = (
        UsageLog.query.filter_by(user_id=user.id)
        .order_by(UsageLog.created_at.desc())
        .limit(40)
        .all()
    )
    usage_counts = dict(
        db.session.query(UsageLog.event_type, func.count(UsageLog.id))
        .filter(UsageLog.user_id == user.id)
        .group_by(UsageLog.event_type)
        .all()
    )
    emergencies = [
        item.public_dict()
        for item in EmergencyEvent.query.filter_by(user_id=user.id)
        .order_by(EmergencyEvent.started_at.desc())
        .limit(10)
        .all()
    ]
    calls = [
        item.public_dict()
        for item in CallSession.query.filter(
            or_(CallSession.caller_id == user.id, CallSession.callee_id == user.id)
        )
        .order_by(CallSession.started_at.desc())
        .limit(10)
        .all()
    ]
    settings = user.settings.public_dict() if user.settings else {}
    return {
        "user": _user_summary(user),
        "settings": settings,
        "contacts": contacts,
        "assistants": assistants,
        "linked_blind": linked_blind,
        "conversations": threads,
        "usage": [
            {
                "id": item.id,
                "event_type": item.event_type,
                "created_at": item.created_at.isoformat() if item.created_at else None,
            }
            for item in usage
        ],
        "usage_counts": usage_counts,
        "emergencies": emergencies,
        "calls": calls,
    }


def list_thread(user: User, peer_id: str) -> dict:
    peer = db.session.get(User, peer_id)
    if not peer:
        raise AdminError("I could not find that conversation.", "NOT_FOUND", 404)
    thread_id = ":".join(sorted([user.id, peer.id]))
    rows = (
        Message.query.filter_by(conversation_id=thread_id)
        .order_by(Message.created_at.asc())
        .limit(200)
        .all()
    )
    return {
        "peer": {
            "id": peer.id,
            "name": _peer_name(user, peer),
            "username": peer.username,
            "role": peer.role,
            "phone": peer.phone,
        },
        "messages": [row.public_dict() for row in rows],
    }


def update_user(user: User, data: dict) -> User:
    if "first_name" in data or "last_name" in data or "name" in data:
        first_name = optional_string(data, "first_name", 80) or user.first_name
        last_name = optional_string(data, "last_name", 80) if "last_name" in data else user.last_name
        if first_name:
            user.first_name = first_name
            user.last_name = last_name
            user.name = display_name(first_name, last_name, user.name)
    if "username" in data and data.get("username"):
        username = validate_username(str(data.get("username")))
        taken = User.query.filter(User.username == username, User.id != user.id).first()
        if taken:
            raise ValidationError("That username is already taken.", "USERNAME_EXISTS")
        user.username = username
    elif "username" in data and not user.username:
        user.username = unique_username((user.email or "user").split("@")[0])
    if "email" in data and data.get("email"):
        email = validate_email(str(data.get("email")))
        taken = User.query.filter(User.email == email, User.id != user.id).first()
        if taken:
            raise ValidationError("An account with that email already exists.", "EMAIL_EXISTS")
        user.email = email
    if "phone" in data:
        phone = validate_phone(data.get("phone"))
        if phone:
            taken = User.query.filter(User.phone == phone, User.id != user.id).first()
            if taken:
                raise ValidationError("An account with that phone number already exists.", "PHONE_EXISTS")
        user.phone = phone
    if "health_notes" in data:
        user.health_notes = optional_string(data, "health_notes", 2000)
    if "other_notes" in data:
        user.other_notes = optional_string(data, "other_notes", 2000)
    if "is_active" in data:
        user.is_active = bool(data.get("is_active"))
    if "plan" in data and data.get("plan") is not None:
        next_plan = str(data.get("plan")).strip().lower()
        if next_plan not in {"free", "premium"}:
            raise ValidationError("Plan must be free or premium.", "INVALID_PLAN")
        user.plan = next_plan
    if data.get("password"):
        user.password_hash = hash_password(validate_password(str(data.get("password"))))
    if not user.username:
        user.username = unique_username((user.email or "user").split("@")[0])
    db.session.commit()
    return user
