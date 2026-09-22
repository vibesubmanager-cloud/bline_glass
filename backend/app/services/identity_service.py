"""Blind-person system IDs, usernames, and assistant lookup."""

from __future__ import annotations

import secrets
import re

from app.extensions import db
from app.models.contact import Contact
from app.models.user import User, UserSettings
from app.utils.security import hash_password

FAMILY_RELATIONSHIPS = {"family", "brother", "sister", "son", "daughter", "mother", "father"}


class IdentityError(Exception):
    def __init__(self, message: str, code: str = "VALIDATION_ERROR", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def new_system_id() -> str:
    while True:
        code = "AIS-" + "".join(secrets.choice(ALPHABET) for _ in range(6))
        if not User.query.filter_by(system_id=code).first():
            return code


def unique_username(base: str) -> str:
    cleaned = re.sub(r"[^a-z0-9._]", "", (base or "user").lower())[:24] or "user"
    candidate = cleaned
    n = 1
    while User.query.filter_by(username=candidate).first():
        n += 1
        candidate = f"{cleaned}{n}"
    return candidate


def ensure_user_identity(user: User) -> None:
    if not user.role:
        user.role = "blind"
    if not user.first_name and user.name:
        parts = user.name.split(None, 1)
        user.first_name = parts[0]
        user.last_name = parts[1] if len(parts) > 1 else None
    if not user.username:
        user.username = unique_username((user.email or "user").split("@")[0])
    if user.role == "blind" and not user.system_id:
        user.system_id = new_system_id()


def lookup_blind_profile(system_id: str) -> dict | None:
    code = (system_id or "").strip().upper()
    if not code:
        return None
    user = User.query.filter_by(system_id=code, role="blind").first()
    if not user:
        return None
    return {
        "system_id": user.system_id,
        "name": user.name,
        "first_name": user.first_name,
        "last_name": user.last_name,
    }


def display_name(first_name: str, last_name: str | None, fallback: str | None = None) -> str:
    full = " ".join(part for part in [first_name, last_name] if part).strip()
    return full or fallback or first_name


def create_assistant_for_blind(
    linked_blind: User,
    *,
    first_name: str,
    last_name: str | None,
    username: str,
    email: str,
    phone: str | None,
    password: str,
    relationship: str,
) -> User:
    if User.query.filter_by(email=email).first():
        raise IdentityError("An account with that email already exists.", "EMAIL_EXISTS", 409)
    if User.query.filter_by(username=username).first():
        raise IdentityError("That username is already taken.", "USERNAME_EXISTS", 409)
    if phone and User.query.filter_by(phone=phone).first():
        raise IdentityError("An account with that phone number already exists.", "PHONE_EXISTS", 409)

    display = display_name(first_name, last_name)
    assistant = User(
        name=display,
        first_name=first_name,
        last_name=last_name,
        username=username,
        email=email,
        phone=phone,
        password_hash=hash_password(password),
        role="assistant",
        linked_blind_user_id=linked_blind.id,
        relationship_to_blind=relationship,
    )
    assistant.settings = UserSettings()
    db.session.add(assistant)
    db.session.flush()
    db.session.add(
        Contact(
            user_id=linked_blind.id,
            name=display,
            phone=phone,
            relationship=relationship,
            is_emergency_contact=relationship.lower() in FAMILY_RELATIONSHIPS,
            linked_user_id=assistant.id,
        )
    )
    db.session.add(
        Contact(
            user_id=assistant.id,
            name=linked_blind.name,
            phone=linked_blind.phone,
            relationship=relationship,
            is_emergency_contact=True,
            linked_user_id=linked_blind.id,
        )
    )
    db.session.commit()
    return assistant
