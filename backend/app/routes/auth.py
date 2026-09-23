from flask import Blueprint, g, request
from sqlalchemy import or_

from app.extensions import db, limiter
from app.models.contact import Contact
from app.models.user import User, UserSettings
from app.services.identity_service import (
    IdentityError,
    create_assistant_for_blind,
    display_name,
    ensure_user_identity,
    lookup_blind_profile,
    new_system_id,
    unique_username,
)
from app.services.usage_service import record_usage
from app.utils.logging import log_event
from app.utils.responses import fail, ok
from app.utils.security import create_token, hash_password, login_required, verify_password
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

auth_bp = Blueprint("auth", __name__)


def _linked_blind_summary(user: User) -> dict | None:
    if not user.linked_blind_user_id:
        return None
    blind = db.session.get(User, user.linked_blind_user_id)
    if not blind:
        return None
    return {
        "id": blind.id,
        "name": blind.name,
        "first_name": blind.first_name,
        "last_name": blind.last_name,
        "system_id": blind.system_id,
        "phone": blind.phone,
    }


def _full_blind_profile(blind: User) -> dict:
    assistants = User.query.filter_by(linked_blind_user_id=blind.id, role="assistant").all()
    contacts = Contact.query.filter_by(user_id=blind.id).order_by(Contact.name.asc()).all()
    return {
        "user": {
            **blind.public_dict(),
            "settings": blind.settings.public_dict() if blind.settings else {},
        },
        "assistants": [
            {
                "id": person.id,
                "name": person.name,
                "relationship": person.relationship_to_blind,
                "phone": person.phone,
                "email": person.email,
            }
            for person in assistants
        ],
        "contacts": [
            {
                "id": item.id,
                "name": item.name,
                "phone": item.phone,
                "relationship": item.relationship,
                "is_emergency_contact": bool(item.is_emergency_contact),
            }
            for item in contacts
        ],
    }


def _auth_payload(user: User) -> dict:
    ensure_user_identity(user)
    db.session.commit()
    settings = user.settings.public_dict() if user.settings else {}
    payload = {"user": user.public_dict(), "token": create_token(user.id), "settings": settings}
    if user.role == "assistant":
        payload["linked_blind"] = _linked_blind_summary(user)
    return payload


@auth_bp.post("/register")
@limiter.limit("10 per minute")
def register():
    try:
        data = require_json(request.get_json(silent=True))
        role = (optional_string(data, "role", 16) or "blind").lower()
        if role not in {"blind", "assistant"}:
            raise ValidationError("Choose blind person or assistant.")
        first_name = optional_string(data, "first_name", 80)
        last_name = optional_string(data, "last_name", 80)
        name = optional_string(data, "name", 120)
        if not first_name and name:
            parts = name.split(None, 1)
            first_name = parts[0]
            last_name = last_name or (parts[1] if len(parts) > 1 else None)
        if not first_name:
            raise ValidationError("First name is required.")
        display = display_name(first_name, last_name, name)
        email = validate_email(require_string(data, "email", max_len=255))
        password = validate_password(require_string(data, "password", min_len=8, max_len=128))
        phone = validate_phone(data.get("phone"))
        raw_username = optional_string(data, "username", 32)
        username = validate_username(raw_username) if raw_username else unique_username(email.split("@")[0])
        health_notes = optional_string(data, "health_notes", 2000)
        other_notes = optional_string(data, "other_notes", 2000)
        system_id_in = optional_string(data, "system_id", 16)
        relationship = optional_string(data, "relationship", 80)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)

    linked_blind = None
    if role == "assistant":
        if not system_id_in:
            return fail("VALIDATION_ERROR", "Enter the blind person's system ID.", 400)
        linked_blind = User.query.filter_by(system_id=system_id_in.strip().upper(), role="blind").first()
        if not linked_blind:
            return fail("BLIND_ID_NOT_FOUND", "I could not find a blind person with that system ID.", 404)
        if not relationship:
            return fail("VALIDATION_ERROR", "Choose how you are related to this person.", 400)
        try:
            user = create_assistant_for_blind(
                linked_blind,
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
        token_payload = _auth_payload(user)
        log_event("USER_REGISTERED", user_id=user.id, role=role)
        record_usage("USER_REGISTERED", user.id)
        return ok(token_payload, 201)

    if User.query.filter_by(email=email).first():
        return fail("EMAIL_EXISTS", "An account with that email already exists.", 409)
    if User.query.filter_by(username=username).first():
        return fail("USERNAME_EXISTS", "That username is already taken.", 409)
    if phone and User.query.filter_by(phone=phone).first():
        return fail("PHONE_EXISTS", "An account with that phone number already exists.", 409)

    user = User(
        name=display,
        first_name=first_name,
        last_name=last_name,
        username=username,
        email=email,
        phone=phone,
        password_hash=hash_password(password),
        role=role,
        health_notes=health_notes if role == "blind" else None,
        other_notes=other_notes if role == "blind" else None,
        system_id=new_system_id() if role == "blind" else None,
        linked_blind_user_id=linked_blind.id if linked_blind else None,
        relationship_to_blind=relationship if role == "assistant" else None,
    )
    user.settings = UserSettings()
    db.session.add(user)
    db.session.flush()

    if role == "blind":
        contacts = data.get("emergency_contacts") if isinstance(data.get("emergency_contacts"), list) else []
        for item in contacts[:5]:
            if not isinstance(item, dict):
                continue
            try:
                cname = require_string(item, "name", min_len=1, max_len=120)
                cphone = validate_phone(item.get("phone"))
            except ValidationError:
                continue
            rel = optional_string(item, "relationship", 80) or "family"
            db.session.add(
                Contact(
                    user_id=user.id,
                    name=cname,
                    phone=cphone,
                    relationship=rel,
                    is_emergency_contact=True,
                )
            )
    db.session.commit()
    token_payload = _auth_payload(user)
    log_event("USER_REGISTERED", user_id=user.id, role=role)
    record_usage("USER_REGISTERED", user.id)
    return ok(token_payload, 201)


@auth_bp.post("/login")
@limiter.limit("15 per minute")
def login():
    try:
        data = require_json(request.get_json(silent=True))
        identifier = optional_string(data, "username", 255) or optional_string(data, "email", 255)
        if not identifier:
            raise ValidationError("Username is required.")
        password = require_string(data, "password", min_len=1, max_len=128)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)

    ident = identifier.strip()
    user = User.query.filter(or_(User.username == ident.lower(), User.email == ident.lower())).first()
    if not user or not verify_password(password, user.password_hash):
        return fail("AUTH_INVALID", "Username or password is incorrect.", 401)
    if user.role == "admin":
        return fail("AUTH_INVALID", "Use the admin website to sign in.", 403)
    if not user.is_active:
        return fail("AUTH_DISABLED", "This account is disabled.", 403)

    log_event("USER_LOGIN", user_id=user.id)
    record_usage("USER_LOGIN", user.id)
    return ok(_auth_payload(user))


@auth_bp.get("/lookup-id")
@limiter.limit("30 per minute")
def lookup_id():
    system_id = (request.args.get("system_id") or "").strip()
    profile = lookup_blind_profile(system_id)
    if not profile:
        return fail("BLIND_ID_NOT_FOUND", "I could not find a blind person with that system ID.", 404)
    return ok({"profile": profile})


@auth_bp.post("/logout")
@login_required
def logout():
    log_event("USER_LOGOUT", user_id=g.current_user.id)
    record_usage("USER_LOGOUT", g.current_user.id)
    return ok({"message": "Signed out."})


@auth_bp.get("/me")
@login_required
def me():
    ensure_user_identity(g.current_user)
    db.session.commit()
    settings = g.current_user.settings.public_dict() if g.current_user.settings else {}
    payload = {"user": g.current_user.public_dict(), "settings": settings}
    if g.current_user.role == "assistant":
        payload["linked_blind"] = _linked_blind_summary(g.current_user)
    return ok(payload)


@auth_bp.get("/profile")
@login_required
def profile():
    viewer = g.current_user
    if viewer.role == "blind":
        blind = viewer
        viewer_role = "self"
    else:
        if not viewer.linked_blind_user_id:
            return fail("PROFILE_UNAVAILABLE", "No blind person is linked to this account yet.", 404)
        blind = db.session.get(User, viewer.linked_blind_user_id)
        if not blind:
            return fail("PROFILE_UNAVAILABLE", "I could not find the linked profile.", 404)
        viewer_role = "assistant"
    payload = _full_blind_profile(blind)
    payload["viewer"] = {
        "id": viewer.id,
        "name": viewer.name,
        "role": viewer.role,
        "relationship": viewer.relationship_to_blind if viewer.role == "assistant" else None,
        "view": viewer_role,
    }
    return ok(payload)


@auth_bp.put("/settings")
@login_required
def update_settings():
    data = request.get_json(silent=True) or {}
    settings = g.current_user.settings
    if settings is None:
        settings = UserSettings(user_id=g.current_user.id)
        db.session.add(settings)
    if "speech_rate" in data:
        try:
            rate = float(data["speech_rate"])
            if not 0.5 <= rate <= 2.0:
                raise ValueError
            settings.speech_rate = rate
        except (TypeError, ValueError):
            return fail("VALIDATION_ERROR", "Speech rate must be between 0.5 and 2.0.", 400)
    if "high_contrast" in data:
        settings.high_contrast = bool(data["high_contrast"])
    if "language" in data and isinstance(data["language"], str):
        settings.language = data["language"][:16]
    if "voice_name" in data:
        settings.voice_name = data["voice_name"][:120] if data["voice_name"] else None
    if "share_location_in_emergency" in data:
        settings.share_location_in_emergency = bool(data["share_location_in_emergency"])
    if "walking_directions" in data:
        settings.walking_directions = bool(data["walking_directions"])
    if "calling_configured" in data:
        settings.calling_configured = bool(data["calling_configured"])
    db.session.commit()
    return ok({"settings": settings.public_dict()})
