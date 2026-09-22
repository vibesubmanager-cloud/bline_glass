from flask import Blueprint, g, redirect, request, send_file

from app.services.message_service import (
    MessageError,
    create_message,
    get_owned_media,
    list_conversations,
    list_thread,
    mark_read,
    unread_messages,
)
from app.utils.responses import fail, ok
from app.utils.security import login_required
from app.utils.validation import ValidationError, optional_string, require_json, validate_lat_lng

messages_bp = Blueprint("messages", __name__)


def _fail(error: Exception):
    if isinstance(error, MessageError):
        status = 403 if error.code == "FORBIDDEN" else 404 if error.code in {"NOT_FOUND", "CONTACT_NOT_FOUND", "NO_APP_ACCOUNT"} else 400
        return fail(error.code, str(error), status)
    if isinstance(error, ValidationError):
        return fail(error.code, error.message, 400)
    return fail("MESSAGE_FAILED", "I couldn't send that message.", 400)


@messages_bp.get("")
@messages_bp.get("/")
@login_required
def conversations():
    with_id = (request.args.get("with") or "").strip()
    try:
        if with_id:
            return ok(list_thread(g.current_user, with_id))
        return ok({"conversations": list_conversations(g.current_user)})
    except MessageError as exc:
        return _fail(exc)
    except Exception:
        return fail("MESSAGE_FAILED", "I couldn't load those messages. Please try again.", 500)


@messages_bp.get("/unread")
@login_required
def unread():
    return ok({"messages": unread_messages(g.current_user)})


@messages_bp.post("/read")
@login_required
def read():
    data = request.get_json(silent=True) or {}
    ids = data.get("ids") if isinstance(data.get("ids"), list) else []
    count = mark_read(g.current_user, [str(item) for item in ids if item])
    return ok({"read": count})


@messages_bp.post("")
@messages_bp.post("/")
@messages_bp.post("/send")
@login_required
def send():
    try:
        if request.content_type and "multipart/form-data" in request.content_type:
            target = request.form.get("target")
            recipient_id = request.form.get("recipient_id")
            msg_type = (request.form.get("type") or "text").lower()
            body = request.form.get("body")
            latitude = longitude = None
            if request.form.get("latitude") and request.form.get("longitude"):
                latitude, longitude = validate_lat_lng(request.form.get("latitude"), request.form.get("longitude"))
            upload = request.files.get("file")
            media_bytes = upload.read() if upload and upload.filename else None
            media_mime = upload.mimetype if upload else None
        else:
            data = require_json(request.get_json(silent=True))
            target = optional_string(data, "target", 120)
            recipient_id = optional_string(data, "recipient_id", 64)
            msg_type = (optional_string(data, "type", 16) or "text").lower()
            body = optional_string(data, "body", 2000)
            latitude = longitude = None
            if data.get("latitude") is not None and data.get("longitude") is not None:
                latitude, longitude = validate_lat_lng(data.get("latitude"), data.get("longitude"))
            media_bytes = None
            media_mime = None
        payload = create_message(
            g.current_user,
            target=target,
            recipient_id=recipient_id,
            msg_type=msg_type,
            body=body,
            latitude=latitude,
            longitude=longitude,
            media_bytes=media_bytes,
            media_mime=media_mime,
        )
        return ok(payload, 201)
    except (MessageError, ValidationError) as exc:
        return _fail(exc)
    except Exception:
        return fail("MESSAGE_FAILED", "I couldn't send that message. Please try again.", 500)


@messages_bp.get("/media/<message_id>")
@login_required
def media(message_id):
    try:
        stored, mime, kind = get_owned_media(g.current_user, message_id)
    except MessageError as exc:
        return _fail(exc)
    if kind == "url":
        return redirect(stored)
    return send_file(stored, mimetype=mime, as_attachment=False, download_name=stored.name)
