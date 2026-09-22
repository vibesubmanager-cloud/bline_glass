"""Emergency activation: locate (with consent), notify contacts, offer a call."""

from __future__ import annotations

from datetime import datetime, timezone

from app.extensions import db
from app.models.contact import Contact
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

    contacts = (
        Contact.query.filter_by(user_id=user.id, is_emergency_contact=True)
        .order_by(Contact.updated_at.desc())
        .all()
    )
    if not contacts:
        contacts = Contact.query.filter_by(user_id=user.id).all()
    if not contacts:
        raise EmergencyServiceError(
            "You don't have an emergency contact yet. Add one in contacts.",
            "NO_EMERGENCY_CONTACT",
        )

    event = EmergencyEvent(
        user_id=user.id,
        latitude=latitude if allowed else None,
        longitude=longitude if allowed else None,
        accuracy_meters=accuracy if allowed else None,
        location_shared=bool(allowed and latitude is not None),
        status="activated",
        notified_contact_ids=[c.id for c in contacts],
    )
    db.session.add(event)
    db.session.commit()
    log_event("EMERGENCY_ACTIVATED", event_id=event.id, contacts=len(contacts))

    sms_sent = []
    location_text = ""
    if event.location_shared:
        location_text = f" Location: https://maps.google.com/?q={event.latitude},{event.longitude}"
    body = f"Vibe Eye emergency alert from {user.name}.{location_text}"
    for contact in contacts:
        if contact.phone and _send_sms(contact.phone, body):
            sms_sent.append(contact.id)

    primary = contacts[0]
    return {
        "event": event.public_dict(),
        "contacts": [c.public_dict() for c in contacts],
        "primary_contact": primary.public_dict(),
        "sms_sent": sms_sent,
        "spoken": _spoken_summary(primary, event.location_shared, bool(sms_sent)),
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


def _spoken_summary(primary: Contact, location_shared: bool, sms: bool) -> str:
    parts = [f"Emergency activated. I will contact {primary.name}."]
    if location_shared:
        parts.append("Your location will be shared with your emergency contact.")
    else:
        parts.append("Location was not shared.")
    if sms:
        parts.append("A text message was sent.")
    return " ".join(parts)
