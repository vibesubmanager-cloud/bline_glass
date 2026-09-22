from flask import Blueprint, g, request

from app.extensions import db
from app.models.contact import Contact
from app.models.user import User
from app.services.identity_service import (
    FAMILY_RELATIONSHIPS,
    IdentityError,
    create_assistant_for_blind,
)
from app.services.share_location_service import ShareLocationError, share_location
from app.utils.responses import fail, ok
from app.utils.security import login_required
from app.utils.validation import (
    ValidationError,
    optional_string,
    require_json,
    require_string,
    validate_email,
    validate_password,
    validate_phone,
    validate_username,
)

contacts_bp = Blueprint("contacts", __name__)


def _owned(contact_id: str) -> Contact | None:
    return Contact.query.filter_by(id=contact_id, user_id=g.current_user.id).first()


def _link_user(phone: str | None) -> str | None:
    if not phone:
        return None
    other = User.query.filter_by(phone=phone).first()
    if other and other.id != g.current_user.id:
        return other.id
    return None


def _is_linked_assistant(contact: Contact, owner: User) -> bool:
    if not contact.linked_user_id:
        return False
    linked = db.session.get(User, contact.linked_user_id)
    return bool(
        linked
        and linked.role == "assistant"
        and linked.linked_blind_user_id == owner.id
        and linked.is_active
    )


def restore_linked_assistants(owner: User) -> None:
    """Put assistant accounts back on the blind person's contact list if they were deleted."""
    if owner.role != "blind":
        return
    assistants = User.query.filter_by(
        role="assistant",
        linked_blind_user_id=owner.id,
        is_active=True,
    ).all()
    if not assistants:
        return
    existing = {
        contact.linked_user_id
        for contact in Contact.query.filter_by(user_id=owner.id).all()
        if contact.linked_user_id
    }
    added = False
    for assistant in assistants:
        if assistant.id in existing:
            continue
        relationship = assistant.relationship_to_blind or "family"
        db.session.add(
            Contact(
                user_id=owner.id,
                name=assistant.name,
                phone=assistant.phone,
                relationship=relationship,
                is_emergency_contact=relationship.lower() in FAMILY_RELATIONSHIPS,
                linked_user_id=assistant.id,
            )
        )
        added = True
    if added:
        db.session.commit()


def _contact_item(contact: Contact, owner: User) -> dict:
    item = contact.public_dict()
    if contact.linked_user_id:
        linked = db.session.get(User, contact.linked_user_id)
        if linked and linked.email:
            item["email"] = linked.email
    item["can_video"] = bool(contact.linked_user_id)
    if _is_linked_assistant(contact, owner):
        item["readonly"] = True
        item["linked_account"] = True
    return item


@contacts_bp.get("")
@login_required
def list_contacts():
    restore_linked_assistants(g.current_user)
    contacts = Contact.query.filter_by(user_id=g.current_user.id).order_by(Contact.name.asc()).all()
    items = [_contact_item(c, g.current_user) for c in contacts]
    if g.current_user.role == "assistant" and g.current_user.linked_blind_user_id:
        blind = db.session.get(User, g.current_user.linked_blind_user_id)
        if blind and not any(item.get("linked_user_id") == blind.id for item in items):
            items.insert(
                0,
                {
                    "id": f"linked-{blind.id}",
                    "name": blind.name,
                    "phone": blind.phone,
                    "relationship": g.current_user.relationship_to_blind,
                    "is_emergency_contact": True,
                    "linked_user_id": blind.id,
                    "readonly": True,
                    "can_video": True,
                    "created_at": None,
                },
            )
    return ok({"contacts": items})


@contacts_bp.post("/assistants")
@login_required
def create_assistant_contact():
    if g.current_user.role != "blind":
        return fail("FORBIDDEN", "Only a blind person can add an assistant here.", 403)
    try:
        data = require_json(request.get_json(silent=True))
        first_name = require_string(data, "first_name", min_len=2, max_len=80)
        last_name = require_string(data, "last_name", min_len=1, max_len=80)
        username = validate_username(require_string(data, "username", min_len=3, max_len=32))
        email = validate_email(require_string(data, "email", max_len=255))
        password = validate_password(require_string(data, "password", min_len=8, max_len=128))
        phone = validate_phone(data.get("phone"))
        relationship = require_string(data, "relationship", min_len=1, max_len=80)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    try:
        assistant = create_assistant_for_blind(
            g.current_user,
            first_name=first_name,
            last_name=last_name,
            username=username,
            email=email,
            phone=phone,
            password=password,
            relationship=relationship,
        )
    except IdentityError as exc:
        return fail(exc.code, exc.message, exc.status)
    contact = Contact.query.filter_by(user_id=g.current_user.id, linked_user_id=assistant.id).first()
    return ok(
        {
            "contact": _contact_item(contact, g.current_user) if contact else assistant.public_dict(),
            "assistant": {
                "name": assistant.name,
                "username": assistant.username,
                "email": assistant.email,
            },
        },
        201,
    )


@contacts_bp.post("")
@login_required
def create_contact():
    try:
        data = require_json(request.get_json(silent=True))
        name = require_string(data, "name", min_len=1, max_len=120)
        phone = validate_phone(optional_string(data, "phone", 32))
        relationship = optional_string(data, "relationship", 80)
        is_emergency = bool(data.get("is_emergency_contact"))
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    contact = Contact(
        user_id=g.current_user.id,
        name=name,
        phone=phone,
        relationship=relationship,
        is_emergency_contact=is_emergency,
        linked_user_id=_link_user(phone),
    )
    db.session.add(contact)
    db.session.commit()
    return ok({"contact": contact.public_dict()}, 201)


@contacts_bp.put("/<contact_id>")
@login_required
def update_contact(contact_id):
    contact = _owned(contact_id)
    if not contact:
        return fail("CONTACT_NOT_FOUND", "Contact not found.", 404)
    data = request.get_json(silent=True) or {}
    try:
        if "name" in data:
            contact.name = require_string(data, "name", min_len=1, max_len=120)
        if "phone" in data:
            contact.phone = validate_phone(optional_string(data, "phone", 32))
            contact.linked_user_id = _link_user(contact.phone)
        if "relationship" in data:
            contact.relationship = optional_string(data, "relationship", 80)
        if "is_emergency_contact" in data:
            contact.is_emergency_contact = bool(data["is_emergency_contact"])
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    db.session.commit()
    return ok({"contact": contact.public_dict()})


@contacts_bp.delete("/<contact_id>")
@login_required
def delete_contact(contact_id):
    contact = _owned(contact_id)
    if not contact:
        return fail("CONTACT_NOT_FOUND", "Contact not found.", 404)
    if _is_linked_assistant(contact, g.current_user):
        return fail(
            "CONTACT_LINKED",
            f"{contact.name} still has an assistant account, so they stay in your contacts.",
            400,
        )
    db.session.delete(contact)
    db.session.commit()
    return ok({"deleted": True})


@contacts_bp.post("/share-location")
@login_required
def share_location_route():
    data = request.get_json(silent=True) or {}
    try:
        latitude = float(data.get("latitude"))
        longitude = float(data.get("longitude"))
    except (TypeError, ValueError):
        return fail("GPS_UNAVAILABLE", "I need your location before I can share it.", 400)
    target = data.get("target") if isinstance(data.get("target"), str) else None
    destination = data.get("destination") if isinstance(data.get("destination"), str) else None
    try:
        payload = share_location(g.current_user, target, latitude, longitude, destination)
    except ShareLocationError as exc:
        return fail(exc.code, str(exc), 404)
    contacts = payload.get("contacts") or [payload["contact"]]
    payload["sms_url"] = None
    for item in contacts:
        linked_id = item.get("linked_user_id")
        if not linked_id:
            continue
        try:
            from app.services.message_service import create_message

            create_message(
                g.current_user,
                recipient_id=linked_id,
                msg_type="location",
                body=payload["message"],
                latitude=latitude,
                longitude=longitude,
            )
        except Exception:
            from app.utils.logging import log_event

            log_event("CHAT_LOCATION_FAILED")
    return ok(payload)
