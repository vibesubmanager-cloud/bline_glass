"""Share the user's live location with a trusted contact."""

from __future__ import annotations

import re
from urllib.parse import quote

from app.models.contact import Contact
from app.models.user import User
from app.utils.logging import log_event


class ShareLocationError(RuntimeError):
    def __init__(self, message: str, code: str = "CONTACT_NOT_FOUND"):
        super().__init__(message)
        self.code = code


RELATION_ALIASES = {
    "brother": ("brother", "brothers", "bro", "brotha"),
    "sister": ("sister", "sisters", "sis"),
    "son": ("son", "sons"),
    "daughter": ("daughter", "daughters"),
    "mother": ("mother", "mom", "mum", "mama"),
    "father": ("father", "dad", "papa"),
    "family": ("family", "parent", "parents"),
    "caregiver": ("caregiver", "carer"),
    "friend": ("friend", "friends"),
}

BROADCAST_TARGETS = {
    "everybody",
    "everyone",
    "anyone",
    "anybody",
    "somebody",
    "someone",
    "all",
    "them",
    "people",
    "contact",
    "contacts",
    "my contact",
    "my contacts",
    "your contact",
    "your contacts",
    "all of them",
    "all of my contacts",
    "all my contacts",
    "all contacts",
    "every one",
    "the group",
}

_FILLER = re.compile(r"\b(please|now|thanks|thank you|for me)\b", re.I)
_LEADING = re.compile(r"^(my|the|a|an)\s+")


def _norm(value: str | None) -> str:
    text = (value or "").lower()
    text = re.sub(r"[^a-z0-9\s]", " ", text)
    for word in (" my ", " the ", " a ", " an "):
        text = text.replace(word, " ")
    return " ".join(text.split())


def clean_target(value: str | None) -> str:
    text = _norm(value)
    text = _FILLER.sub(" ", text)
    text = _LEADING.sub("", text)
    return " ".join(text.split())


def is_broadcast_target(target: str | None) -> bool:
    query = clean_target(target)
    if not query:
        return True
    if query in BROADCAST_TARGETS:
        return True
    if query.startswith("all of ") or query.startswith("all my "):
        return True
    words = query.split()
    extra = {"in", "of", "to", "and"}
    if words and all(word in BROADCAST_TARGETS or word in extra for word in words):
        return True
    return "everybody" in query or "everyone" in query


def _relationship_key(query: str) -> str | None:
    cleaned = clean_target(query) or _norm(query)
    words = cleaned.split()
    for key, aliases in RELATION_ALIASES.items():
        if cleaned in aliases or any(alias in words for alias in aliases):
            return key
    return None


def list_user_contacts(user: User) -> list[Contact]:
    return Contact.query.filter_by(user_id=user.id).order_by(Contact.name.asc()).all()


def find_matching_contact(contacts: list[Contact], target: str | None) -> Contact | None:
    query = clean_target(target)
    if not query or is_broadcast_target(query):
        return None
    rel = _relationship_key(query)
    if rel:
        match = next((c for c in contacts if _norm(c.relationship) == rel or rel in _norm(c.relationship)), None)
        if match:
            return match
    words = query.split()
    for contact in contacts:
        name = _norm(contact.name)
        if not name:
            continue
        parts = name.split()
        if name == query or query == parts[0]:
            return contact
        if len(query) >= 3 and query in parts:
            return contact
        if parts[0] in words and len(parts[0]) >= 3:
            return contact
    return None


def resolve_contacts(user: User, target: str | None) -> list[Contact]:
    contacts = list_user_contacts(user)
    if not contacts:
        raise ShareLocationError(
            "You don't have a contact yet. Add a family member in contacts first.",
            "CONTACT_NOT_FOUND",
        )
    match = find_matching_contact(contacts, target)
    if match:
        return [match]
    return contacts


def pick_contact(user: User, target: str | None) -> Contact:
    return resolve_contacts(user, target)[0]


def contact_names(contacts: list[Contact]) -> str:
    names = [contact.name for contact in contacts if contact.name]
    if not names:
        return "your contacts"
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} and {names[1]}"
    return "all of your contacts"


def share_location(user: User, target: str | None, latitude: float, longitude: float, destination: str | None = None) -> dict:
    contacts = resolve_contacts(user, target)
    maps_url = f"https://maps.google.com/?q={latitude},{longitude}"
    place = (destination or "").strip()
    if place:
        body = f"{user.name} needs help getting to {place}. Live location: {maps_url}"
    else:
        body = f"{user.name} shared a live location: {maps_url}"

    sms_sent = False
    from app.services.emergency_service import _send_sms

    for contact in contacts:
        if contact.phone:
            sms_sent = _send_sms(contact.phone, body) or sms_sent
    log_event("LOCATION_SHARED", user_id=user.id, contact_ids=[c.id for c in contacts], sms=sms_sent)

    who = contact_names(contacts)
    spoken = f"Done. I have sent your location to {who}."
    if place:
        spoken = f"Done. I have sent your location to {who} so they can help you get to {place}."
    spoken += " They will see it in vibeEye."
    if sms_sent:
        spoken += " A text message was also sent."

    return {
        "contact": contacts[0].public_dict(),
        "contacts": [contact.public_dict() for contact in contacts],
        "maps_url": maps_url,
        "message": body,
        "sms_sent": sms_sent,
        "spoken": spoken,
    }


def sms_link(phone: str | None, body: str) -> str | None:
    if not phone:
        return None
    return f"sms:{phone}&body={quote(body)}"
