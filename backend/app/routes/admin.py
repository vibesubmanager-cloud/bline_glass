from flask import Blueprint, g, request

from app.extensions import db, limiter
from app.models.api_key import ApiKey
from app.models.user import User, UserSettings
from app.services.admin_service import AdminError, get_user_or_404, list_thread, list_users, update_user, user_detail
from app.services.identity_service import display_name
from app.services.key_store import (
    KeyStoreError,
    MAX_KEYS_PER_PROVIDER,
    PROVIDERS,
    add_key,
    delete_key,
    list_keys,
    mark_error,
    mark_ok,
    update_key,
)
from app.utils.logging import log_event
from app.utils.responses import fail, ok
from app.utils.security import admin_required, create_token, hash_password, verify_password
from app.utils.validation import (
    ValidationError,
    load_image_from_upload,
    optional_string,
    require_json,
    require_string,
)

admin_bp = Blueprint("admin", __name__)


def _error(exc: Exception):
    if isinstance(exc, AdminError):
        return fail(exc.code, exc.message, exc.status)
    if isinstance(exc, KeyStoreError):
        return fail(exc.code, exc.message, exc.status)
    if isinstance(exc, ValidationError):
        return fail(exc.code, exc.message, 400)
    return fail("ADMIN_ERROR", "I could not complete that admin request.", 400)


@admin_bp.post("/login")
@limiter.limit("15 per minute")
def login():
    try:
        data = require_json(request.get_json(silent=True))
        username = (optional_string(data, "username", 255) or "").strip().lower()
        password = require_string(data, "password", min_len=1, max_len=128)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    user = User.query.filter_by(username=username, role="admin").first()
    if not user or not verify_password(password, user.password_hash):
        return fail("AUTH_INVALID", "Admin username or password is incorrect.", 401)
    if not user.is_active:
        return fail("AUTH_DISABLED", "This admin account is disabled.", 403)
    log_event("ADMIN_LOGIN", user_id=user.id)
    return ok(
        {
            "token": create_token(user.id),
            "user": {"id": user.id, "name": user.name, "username": user.username, "role": "admin"},
        }
    )


@admin_bp.get("/me")
@admin_required
def me():
    user = g.current_user
    return ok({"user": {"id": user.id, "name": user.name, "username": user.username, "role": "admin"}})


@admin_bp.get("/users")
@admin_required
def users():
    search = (request.args.get("q") or "").strip()
    role = (request.args.get("role") or "").strip().lower()
    return ok({"users": list_users(search, role)})


@admin_bp.get("/users/<user_id>")
@admin_required
def user(user_id: str):
    try:
        return ok(user_detail(get_user_or_404(user_id)))
    except Exception as exc:
        return _error(exc)


@admin_bp.put("/users/<user_id>")
@admin_required
def save_user(user_id: str):
    try:
        data = require_json(request.get_json(silent=True))
        user = update_user(get_user_or_404(user_id), data)
        return ok(user_detail(user))
    except Exception as exc:
        return _error(exc)


@admin_bp.get("/users/<user_id>/messages")
@admin_required
def user_messages(user_id: str):
    try:
        user = get_user_or_404(user_id)
        peer_id = (request.args.get("with") or "").strip()
        if not peer_id:
            return fail("VALIDATION_ERROR", "Choose a conversation to open.", 400)
        return ok(list_thread(user, peer_id))
    except Exception as exc:
        return _error(exc)


@admin_bp.get("/keys")
@admin_required
@limiter.exempt
def keys():
    grouped = {provider: [] for provider in PROVIDERS}
    for row in list_keys():
        grouped.setdefault(row.provider, []).append(row.public_dict())
    return ok({"keys": grouped, "max_per_provider": MAX_KEYS_PER_PROVIDER})


@admin_bp.post("/keys")
@admin_required
@limiter.exempt
def create_key():
    try:
        data = require_json(request.get_json(silent=True))
        provider = require_string(data, "provider", max_len=32)
        key_value = require_string(data, "key", min_len=8, max_len=2048)
        label = optional_string(data, "label", 80)
        row = add_key(provider, key_value, label)
        return ok({"key": row.public_dict()}, 201)
    except Exception as exc:
        db.session.rollback()
        return _error(exc)


@admin_bp.put("/keys/<key_id>")
@admin_required
def save_key(key_id: str):
    try:
        data = require_json(request.get_json(silent=True))
        row = db.session.get(ApiKey, key_id)
        if not row:
            raise KeyStoreError("I could not find that key.", "NOT_FOUND", 404)
        update_key(
            row,
            label=data.get("label") if "label" in data else None,
            key_value=data.get("key") if data.get("key") else None,
            is_active=data.get("is_active") if "is_active" in data else None,
            sort_order=data.get("sort_order") if "sort_order" in data else None,
        )
        return ok({"key": row.public_dict()})
    except Exception as exc:
        return _error(exc)


@admin_bp.delete("/keys/<key_id>")
@admin_required
def remove_key(key_id: str):
    row = db.session.get(ApiKey, key_id)
    if not row:
        return fail("NOT_FOUND", "I could not find that key.", 404)
    delete_key(row)
    return ok({"removed": True})


@admin_bp.post("/keys/<key_id>/test")
@admin_required
def test_key(key_id: str):
    row = db.session.get(ApiKey, key_id)
    if not row:
        return fail("NOT_FOUND", "I could not find that key.", 404)
    text = ""
    if request.form:
        text = (request.form.get("text") or "").strip()
    else:
        data = request.get_json(silent=True) or {}
        text = str(data.get("text") or "").strip()
    image = None
    if "image" in request.files and request.files["image"].filename:
        try:
            image = load_image_from_upload(request.files["image"])
        except ValidationError as exc:
            return fail(exc.code, exc.message, 400)
    if row.provider == "gemini" and image is None:
        return ok(
            {
                "ok": False,
                "needs_photo": True,
                "reply": "Upload a photo in Test to try this Gemini key.",
                "key": row.public_dict(),
            }
        )
    try:
        result = _run_key_test(row, text=text, image=image)
    except Exception as exc:
        mark_error(row, str(exc)[:180])
        return ok({"ok": False, "reply": str(exc)[:180], "key": row.public_dict()})
    if result.get("ok"):
        mark_ok(row)
    else:
        mark_error(row, result.get("reply") or "Key failed")
    db.session.refresh(row)
    return ok({**result, "key": row.public_dict()})


def _run_key_test(row: ApiKey, *, text: str = "", image=None) -> dict:
    if row.provider == "gemini":
        if image is None:
            return {"ok": False, "needs_photo": True, "reply": "Upload a photo to test this Gemini key."}
        from app.services.gemini_service import GeminiServiceError, get_gemini_service

        question = text
        service = get_gemini_service()
        if question:
            try:
                spoken = service.answer(image, question, only_key=row.key_value, key_row=row).get("answer") or ""
            except GeminiServiceError as exc:
                return {"ok": False, "reply": str(exc)}
            return {"ok": bool(spoken), "reply": spoken or "Gemini returned an empty reply."}
        return service.ping_describe(image, only_key=row.key_value, key_row=row)
    if row.provider == "groq":
        from app.services.groq_service import get_groq_service

        return get_groq_service().ping_chat(text or "hi", only_key=row.key_value, key_row=row)
    if row.provider == "daily":
        from app.services.daily_service import ping_daily

        return ping_daily(row.key_value)
    return {"ok": False, "reply": "Unknown provider."}


def seed_admin_user() -> None:
    from flask import current_app

    if User.query.filter_by(role="admin").first():
        return
    username = (current_app.config.get("ADMIN_USERNAME") or "admin").strip().lower() or "admin"
    password = (current_app.config.get("ADMIN_PASSWORD") or "").strip()
    if current_app.config.get("TESTING") and not password:
        password = "AdminSight1!"
    if not password:
        log_event("ADMIN_NOT_SEEDED", reason="ADMIN_PASSWORD missing")
        return
    if User.query.filter_by(username=username).first():
        username = "aisightadmin"
    user = User(
        name=display_name("Admin", None, "Admin"),
        first_name="Admin",
        username=username,
        email=f"{username}@admin.local",
        password_hash=hash_password(password),
        role="admin",
        is_active=True,
    )
    user.settings = UserSettings()
    db.session.add(user)
    db.session.commit()
    log_event("ADMIN_SEEDED", username=username)
