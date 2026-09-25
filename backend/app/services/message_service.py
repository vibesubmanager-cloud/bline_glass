"""In-app chat between a blind person and linked assistants."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import current_app
from sqlalchemy import or_

from app.extensions import db
from app.models.contact import Contact
from app.models.message import Message
from app.models.user import User
from app.services.share_location_service import (
    ShareLocationError,
    contact_names,
    find_matching_contact,
    list_user_contacts,
    pick_contact,
)
from app.utils.logging import log_event

ALLOWED_AUDIO = {
    "audio/webm",
    "audio/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/m4a",
    "audio/x-m4a",
    "audio/wav",
    "audio/x-wav",
    "audio/aac",
    "video/webm",
    "video/mp4",
}
AUDIO_EXT = {
    "audio/webm": ".webm",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/m4a": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/aac": ".aac",
    "video/webm": ".webm",
    "video/mp4": ".m4a",
}
MAX_MEDIA_BYTES = 5 * 1024 * 1024


class MessageError(RuntimeError):
    def __init__(self, message: str, code: str = "MESSAGE_FAILED"):
        super().__init__(message)
        self.code = code


def conversation_id_for(user_a: str, user_b: str) -> str:
    return ":".join(sorted([user_a, user_b]))


def media_dir() -> Path:
    folder = Path(current_app.instance_path) / "message_media"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _persist_media(media_bytes: bytes, ext: str, msg_type: str) -> str:
    from app.services.cloudinary_service import CloudinaryServiceError, get_cloudinary_service

    cloud = get_cloudinary_service()
    if cloud.configured():
        try:
            result = cloud.upload_bytes(
                media_bytes,
                folder="aisight/messages",
                resource_type="image" if msg_type == "image" else "auto",
            )
        except CloudinaryServiceError as exc:
            raise MessageError(str(exc), "STORAGE_UNAVAILABLE") from exc
        url = result.get("url")
        if not url:
            raise MessageError("Image storage did not return a file address.", "STORAGE_UNAVAILABLE")
        return url
    if current_app.config.get("FLASK_ENV") == "production":
        raise MessageError(
            "Photo storage is not configured. Set Cloudinary on the server.",
            "STORAGE_UNAVAILABLE",
        )
    filename = f"{uuid.uuid4().hex}{ext}"
    (media_dir() / filename).write_bytes(media_bytes)
    return filename


def resolve_peer(user: User, target: str | None, recipient_id: str | None = None) -> tuple[User, Contact | None]:
    if recipient_id:
        if recipient_id == user.id:
            raise MessageError("You cannot message yourself.", "CONTACT_NOT_FOUND")
        peer = db.session.get(User, recipient_id)
        if not peer:
            raise MessageError("I couldn't find that person.", "CONTACT_NOT_FOUND")
        if not _are_linked(user, peer):
            raise MessageError("You can only chat with a linked assistant or the person you help.", "FORBIDDEN")
        contact = Contact.query.filter_by(user_id=user.id, linked_user_id=peer.id).first()
        return peer, contact

    if user.role == "assistant" and not (target or "").strip():
        if not user.linked_blind_user_id:
            raise MessageError("You are not linked to a blind person yet.", "CONTACT_NOT_FOUND")
        peer = db.session.get(User, user.linked_blind_user_id)
        if not peer:
            raise MessageError("I couldn't find the person you help.", "CONTACT_NOT_FOUND")
        contact = Contact.query.filter_by(user_id=user.id, linked_user_id=peer.id).first()
        return peer, contact

    try:
        contact = pick_contact(user, target)
    except ShareLocationError as exc:
        raise MessageError(str(exc), exc.code) from exc
    if not contact.linked_user_id:
        raise MessageError(
            f"{contact.name} does not have an vibeEye account yet, so I cannot send an in-app message.",
            "NO_APP_ACCOUNT",
        )
    peer = db.session.get(User, contact.linked_user_id)
    if not peer or peer.id == user.id:
        raise MessageError(f"I couldn't reach {contact.name} in the app.", "CONTACT_NOT_FOUND")
    return peer, contact


def _are_linked(user: User, peer: User) -> bool:
    if user.role == "assistant" and user.linked_blind_user_id == peer.id:
        return True
    if peer.role == "assistant" and peer.linked_blind_user_id == user.id:
        return True
    if Contact.query.filter_by(user_id=user.id, linked_user_id=peer.id).first():
        return True
    if Contact.query.filter_by(user_id=peer.id, linked_user_id=user.id).first():
        return True
    return False


def _spoken_for(message: Message, peer_name: str) -> str:
    who = peer_name or "your contacts"
    if message.type == "location":
        return f"Done. I have sent your location to {who}."
    if message.type == "image":
        return f"Done. I have sent the picture to {who}."
    if message.type == "voice":
        return f"Done. I have sent the voice note to {who}."
    return f"Done. I have sent your message to {who}."


def _resolve_send_peers(sender: User, target: str | None, recipient_id: str | None) -> list[tuple[User, Contact | None]]:
    if recipient_id:
        return [resolve_peer(sender, target, recipient_id)]
    if sender.role == "assistant" and not (target or "").strip():
        return [resolve_peer(sender, None, None)]

    if sender.role != "assistant" and not recipient_id:
        contacts = list_user_contacts(sender)
        if not contacts:
            raise MessageError(
                "You don't have a contact yet. Add a family member in contacts first.",
                "CONTACT_NOT_FOUND",
            )
        peers = []
        for contact in contacts:
            if not contact.linked_user_id:
                continue
            peer = db.session.get(User, contact.linked_user_id)
            if peer and peer.id != sender.id:
                peers.append((peer, contact))
        if not peers:
            raise MessageError(
                "Your group is not signed in to vibeEye yet, so I cannot deliver that.",
                "NO_APP_ACCOUNT",
            )
        return peers

    contacts = list_user_contacts(sender)
    if not contacts:
        raise MessageError(
            "You don't have a contact yet. Add a family member in contacts first.",
            "CONTACT_NOT_FOUND",
        )

    specific = find_matching_contact(contacts, target)
    if specific and specific.linked_user_id:
        return [resolve_peer(sender, None, specific.linked_user_id)]

    peers = []
    for contact in contacts:
        if not contact.linked_user_id:
            continue
        peer = db.session.get(User, contact.linked_user_id)
        if peer and peer.id != sender.id:
            peers.append((peer, contact))
    if not peers:
        raise MessageError(
            "Your group is not signed in to vibeEye yet, so I cannot deliver that.",
            "NO_APP_ACCOUNT",
        )
    return peers


def create_message(
    sender: User,
    *,
    target: str | None = None,
    recipient_id: str | None = None,
    msg_type: str = "text",
    body: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    media_bytes: bytes | None = None,
    media_mime: str | None = None,
    emergency: bool = False,
) -> dict:
    pairs = list(_resolve_send_peers(sender, target, recipient_id))
    emergency_flag = (
        emergency
        or (body or "").upper().startswith("EMERGENCY")
        or "emergency" in (body or "").lower()
    )
    if emergency_flag:
        seen = {peer.id for peer, _contact in pairs}
        for admin in User.query.filter_by(role="admin", is_active=True).all():
            if admin.id != sender.id and admin.id not in seen:
                pairs.append((admin, None))
                seen.add(admin.id)
    msg_type = (msg_type or "text").lower()
    if msg_type not in {"text", "location", "image", "voice"}:
        raise MessageError("That message type is not supported.", "VALIDATION_ERROR")

    maps_url = None
    if msg_type == "location":
        if latitude is None or longitude is None:
            raise MessageError("I need your location before I can send it.", "GPS_UNAVAILABLE")
        maps_url = f"https://maps.google.com/?q={latitude},{longitude}"
        body = body or f"{sender.name} shared a live location: {maps_url}"
    elif msg_type == "text":
        text = (body or "").strip()
        if not text:
            raise MessageError("What should I say?", "VALIDATION_ERROR")
        body = text
    elif msg_type in {"image", "voice"}:
        if not media_bytes:
            raise MessageError("I did not receive that recording or picture.", "VALIDATION_ERROR")
        if len(media_bytes) > MAX_MEDIA_BYTES:
            raise MessageError("That file is too large. Keep it under 5 MB.", "IMAGE_TOO_LARGE")

    stored_mime = None
    ext = ".webm"
    if media_bytes:
        if msg_type == "image":
            stored_mime = "image/jpeg"
            ext = ".jpg"
        else:
            mime = (media_mime or "audio/webm").split(";")[0].strip().lower()
            if mime not in ALLOWED_AUDIO:
                raise MessageError("That audio format is not supported.", "VALIDATION_ERROR")
            stored_mime = mime
            ext = AUDIO_EXT.get(mime, ".webm")

    created = []
    stored_ref = None
    if media_bytes:
        stored_ref = _persist_media(media_bytes, ext, msg_type)
    for peer, contact in pairs:
        message = Message(
            conversation_id=conversation_id_for(sender.id, peer.id),
            sender_id=sender.id,
            recipient_id=peer.id,
            type=msg_type,
            body=body,
            media_filename=stored_ref,
            media_mime=stored_mime,
            latitude=latitude,
            longitude=longitude,
            maps_url=maps_url,
        )
        db.session.add(message)
        created.append((message, peer, contact))
    db.session.commit()
    log_event("MESSAGE_SENT", message_id=created[0][0].id, type=msg_type, count=len(created))
    contacts = [contact for _message, _peer, contact in created if contact]
    who = contact_names(contacts) if contacts else created[0][1].name
    spoken = _spoken_for(created[0][0], who)
    first_message, first_peer, first_contact = created[0]
    peer_name = first_contact.name if first_contact else first_peer.name
    return {
        "message": first_message.public_dict(sender.id),
        "peer": {"id": first_peer.id, "name": peer_name},
        "spoken": spoken,
    }


def list_thread(user: User, recipient_id: str, limit: int = 80) -> dict:
    peer, contact = resolve_peer(user, None, recipient_id)
    thread_id = conversation_id_for(user.id, peer.id)
    rows = (
        Message.query.filter_by(conversation_id=thread_id)
        .order_by(Message.created_at.asc())
        .limit(max(1, min(limit, 200)))
        .all()
    )
    now = datetime.now(timezone.utc)
    unread = [row for row in rows if row.recipient_id == user.id and row.read_at is None]
    for row in unread:
        row.read_at = now
    if unread:
        db.session.commit()
    return {
        "peer": {"id": peer.id, "name": contact.name if contact else peer.name, "phone": peer.phone},
        "messages": [row.public_dict(user.id) for row in rows],
    }


def list_group_messages(user: User, limit: int = 120) -> dict:
    if user.role == "assistant" and user.linked_blind_user_id:
        return list_thread(user, user.linked_blind_user_id, limit=limit)
    peer_ids = family_peer_ids(user)
    if not peer_ids:
        return {"peer": {"id": "group", "name": "Family group"}, "messages": []}
    rows = (
        Message.query.filter(
            or_(
                db.and_(Message.sender_id == user.id, Message.recipient_id.in_(peer_ids)),
                db.and_(Message.recipient_id == user.id, Message.sender_id.in_(peer_ids)),
            )
        )
        .order_by(Message.created_at.asc())
        .limit(max(1, min(limit, 200)))
        .all()
    )
    now = datetime.now(timezone.utc)
    unread = [row for row in rows if row.recipient_id == user.id and row.read_at is None]
    for row in unread:
        row.read_at = now
    if unread:
        db.session.commit()
    unique = []
    seen_out = set()
    for row in rows:
        if row.sender_id == user.id:
            key = (row.type, row.body or "", row.media_filename or "", row.maps_url or "")
            if key in seen_out:
                continue
            seen_out.add(key)
        unique.append(row)
    rows = unique
    names = {}
    for row in rows:
        other = row.recipient_id if row.sender_id == user.id else row.sender_id
        if other not in names:
            contact = Contact.query.filter_by(user_id=user.id, linked_user_id=other).first()
            peer = db.session.get(User, other)
            names[other] = contact.name if contact else (peer.name if peer else "Family")
    messages = []
    for row in rows:
        data = row.public_dict(user.id)
        other = row.recipient_id if row.sender_id == user.id else row.sender_id
        data["from_name"] = "You" if row.sender_id == user.id else names.get(other, "Family")
        messages.append(data)
    return {"peer": {"id": "group", "name": "Family group"}, "messages": messages}


def family_peer_ids(user: User) -> list[str]:
    ids = []
    seen = set()
    for contact in list_user_contacts(user):
        uid = contact.linked_user_id
        if uid and uid != user.id and uid not in seen:
            seen.add(uid)
            ids.append(uid)
    if user.role != "assistant":
        for helper in User.query.filter_by(role="assistant", linked_blind_user_id=user.id, is_active=True).all():
            if helper.id not in seen:
                seen.add(helper.id)
                ids.append(helper.id)
    return ids


def list_conversations(user: User) -> list[dict]:
    rows = (
        Message.query.filter(or_(Message.sender_id == user.id, Message.recipient_id == user.id))
        .order_by(Message.created_at.desc())
        .all()
    )
    seen = set()
    conversations = []
    for row in rows:
        if row.conversation_id in seen:
            continue
        seen.add(row.conversation_id)
        peer_id = row.recipient_id if row.sender_id == user.id else row.sender_id
        peer = db.session.get(User, peer_id)
        contact = Contact.query.filter_by(user_id=user.id, linked_user_id=peer_id).first()
        unread = Message.query.filter_by(
            conversation_id=row.conversation_id,
            recipient_id=user.id,
            read_at=None,
        ).count()
        conversations.append(
            {
                "peer": {
                    "id": peer_id,
                    "name": contact.name if contact else (peer.name if peer else "Contact"),
                },
                "last_message": row.public_dict(user.id),
                "unread": unread,
            }
        )
    return conversations


def unread_messages(user: User) -> list[dict]:
    rows = (
        Message.query.filter_by(recipient_id=user.id, read_at=None)
        .order_by(Message.created_at.asc())
        .all()
    )
    items = []
    for row in rows:
        sender = db.session.get(User, row.sender_id)
        contact = Contact.query.filter_by(user_id=user.id, linked_user_id=row.sender_id).first()
        name = contact.name if contact else (sender.name if sender else "Someone")
        preview = row.body or ""
        if row.type == "image":
            preview = "sent a picture"
        elif row.type == "voice":
            preview = "sent a voice note"
        elif row.type == "location":
            preview = "sent a location"
        emergency = "emergency" in (row.body or "").lower() or (row.body or "").upper().startswith("EMERGENCY")
        spoken = (
            f"Emergency message from {name}. {preview}" if emergency else f"New message from {name}. {preview}"
        )
        items.append(
            {
                "message": row.public_dict(user.id),
                "from_name": name,
                "spoken": spoken.strip(),
            }
        )
    return items


def mark_read(user: User, message_ids: list[str]) -> int:
    if not message_ids:
        return 0
    now = datetime.now(timezone.utc)
    rows = Message.query.filter(Message.id.in_(message_ids), Message.recipient_id == user.id, Message.read_at.is_(None)).all()
    for row in rows:
        row.read_at = now
    if rows:
        db.session.commit()
    return len(rows)


def get_owned_media(user: User, message_id: str):
    message = db.session.get(Message, message_id)
    if not message or user.id not in {message.sender_id, message.recipient_id}:
        raise MessageError("Message not found.", "NOT_FOUND")
    if not message.media_filename:
        raise MessageError("That message has no file.", "NOT_FOUND")
    if str(message.media_filename).startswith("http"):
        return message.media_filename, message.media_mime or "application/octet-stream", "url"
    path = media_dir() / message.media_filename
    if not path.is_file():
        raise MessageError("That file is no longer available.", "NOT_FOUND")
    return path, message.media_mime or "application/octet-stream", "file"
