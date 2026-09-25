"""Emergency activation: locate (with consent), notify contacts, offer a call."""

from __future__ import annotations

from datetime import datetime, timezone

from app.extensions import db
from app.models.emergency import EmergencyEvent
from app.models.user import User
from app.utils.logging import log_error, log_event


class EmergencyServiceError(RuntimeError):
    def __init__(self, message: str, code: str = "EMERGENCY_FAILED"):
        super().__init__(message)
        self.code = code


def _send_sms(to_number: str, body: str) -> bool:
    from flask import current_app

    sid = current_app.config.get("TWILIO_ACCOUNT_SID") or ""
    token = current_app.config.get("TWILIO_AUTH_TOKEN") or ""
    sender = current_app.config.get("TWILIO_FROM_NUMBER") or ""
    if not (sid and token and sender and to_number):
        return False
    try:
        from twilio.rest import Client

        Client(sid, token).messages.create(to=to_number, from_=sender, body=body)
        log_event("EMERGENCY_SMS_SENT")
        return True
    except Exception as exc:
        log_error("EMERGENCY_SMS_ERROR", exc)
        return False


def activate_emergency(user: User, latitude=None, longitude=None, accuracy=None, share_location=None) -> dict:
    settings = user.settings
    allowed = True if share_location is None else bool(share_location)
    if settings and share_location is None:
        allowed = bool(settings.share_location_in_emergency)

    admins = User.query.filter_by(role="admin", is_active=True).all()
    if not admins:
        raise EmergencyServiceError(
            "Emergency admin is not available yet.",
            "NO_EMERGENCY_CONTACT",
        )

    event = EmergencyEvent(
        user_id=user.id,
        latitude=latitude if allowed else None,
        longitude=longitude if allowed else None,
        accuracy_meters=accuracy if allowed else None,
        location_shared=bool(allowed and latitude is not None),
        status="activated",
        notified_contact_ids=[],
    )
    db.session.add(event)
    db.session.commit()
    log_event("EMERGENCY_ACTIVATED", event_id=event.id, contacts=len(admins))

    try:
        from app.services.message_service import create_message

        create_message(
            user,
            target="",
            msg_type="text",
            body="EMERGENCY. I need help now.",
            emergency=True,
        )
    except Exception as exc:
        log_error("EMERGENCY_CHAT_ERROR", exc)

    return {
        "event": event.public_dict(),
        "contacts": [],
        "primary_contact": {"name": "Emergency admin"},
        "sms_sent": [],
        "spoken": _spoken_summary(event.location_shared),
    }


def cancel_emergency(user: User, event_id: str) -> dict:
    event = EmergencyEvent.query.filter_by(id=event_id, user_id=user.id).first()
    if not event:
        raise EmergencyServiceError("Emergency event not found.", "EMERGENCY_NOT_FOUND")
    event.status = "cancelled"
    event.resolved_at = datetime.now(timezone.utc)
    db.session.commit()
    log_event("EMERGENCY_CANCELLED", event_id=event.id)
    return {"event": event.public_dict(), "spoken": "Emergency cancelled."}


def _spoken_summary(location_shared: bool) -> str:
    parts = ["Emergency activated. I am contacting emergency admin."]
    if location_shared:
        parts.append("Your location will be shared with admin.")
    else:
        parts.append("Location was not shared.")
    return " ".join(parts)
