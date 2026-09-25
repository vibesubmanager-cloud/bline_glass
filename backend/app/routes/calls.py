from flask import Blueprint, g, request

from app.extensions import limiter
from app.models.contact import Contact
from app.services.calling_service import (
    CallingServiceError,
    accept_call,
    drain_signals,
    post_signal,
    require_call_party,
    resolve_contact_for_call,
    set_call_status,
    start_call,
    start_group_call,
)
from app.services.usage_service import record_usage
from app.utils.responses import fail, ok
from app.utils.security import login_required
from app.services.share_location_service import is_broadcast_target
from app.utils.validation import ValidationError, require_json, require_string

calls_bp = Blueprint("calls", __name__)


@calls_bp.post("/start")
@login_required
def start():
    try:
        data = require_json(request.get_json(silent=True))
        media = "video" if str(data.get("media") or "").lower() == "video" else "audio"
        target = str(data.get("target") or "").strip()
        emergency = bool(data.get("emergency")) or target.lower() in {"emergency", "sos"}
        group = bool(data.get("group")) or emergency or is_broadcast_target(target) or target.lower() in {
            "group",
            "family",
            "contacts",
            "",
        }
        if emergency or group or (g.current_user.role != "assistant" and not data.get("contact_id")):
            payload = start_group_call(g.current_user, media=media, emergency=emergency)
            record_usage("CALL_STARTED", g.current_user.id)
            payload["spoken"] = payload.get("spoken") or "Calling your group. Anyone who is free can pick up."
            return ok(payload)
        if data.get("contact_id"):
            contact = Contact.query.filter_by(id=data["contact_id"], user_id=g.current_user.id).first()
            if not contact:
                raise CallingServiceError("Who should I call?", "CONTACT_NOT_FOUND")
        else:
            target = require_string(data, "target", min_len=1, max_len=120)
            contact = resolve_contact_for_call(g.current_user.id, target)
        payload = start_call(g.current_user, contact, media=media)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except CallingServiceError as exc:
        code = 404 if exc.code in {"CONTACT_NOT_FOUND", "VIDEO_UNAVAILABLE"} else 400
        if exc.code == "CALL_NOT_CONFIGURED":
            code = 503
        return fail(exc.code, str(exc), code)

    record_usage("CALL_STARTED", g.current_user.id)
    spoken = f"Calling {contact.name}."
    call_type = (payload.get("call") or {}).get("call_type")
    if call_type == "video":
        spoken = f"Starting a video call with {contact.name}."
    elif call_type == "webrtc":
        spoken = f"Starting a voice call with {contact.name}."
    elif payload.get("tel_url"):
        spoken = f"Calling {contact.name} on the phone."
    payload["spoken"] = spoken
    return ok(payload)


@calls_bp.post("/end")
@login_required
def end():
    try:
        data = require_json(request.get_json(silent=True))
        call_id = require_string(data, "call_id")
        session = set_call_status(call_id, g.current_user.id, "ended")
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except CallingServiceError as exc:
        return fail(exc.code, str(exc), 404)
    return ok({"call": session.public_dict(), "spoken": "Call ended."})


@calls_bp.post("/reject")
@login_required
def reject():
    try:
        data = require_json(request.get_json(silent=True))
        call_id = require_string(data, "call_id")
        session = set_call_status(call_id, g.current_user.id, "rejected")
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except CallingServiceError as exc:
        return fail(exc.code, str(exc), 404)
    return ok({"call": session.public_dict(), "spoken": "Call declined."})


@calls_bp.post("/signal")
@login_required
@limiter.exempt
def signal():
    data = request.get_json(silent=True) or {}
    target = data.get("target_user_id")
    if not target:
        return fail("VALIDATION_ERROR", "target_user_id is required.", 400)
    call_id = (data.get("call_id") or "").strip()
    if call_id:
        try:
            require_call_party(call_id, g.current_user.id)
        except CallingServiceError as exc:
            return fail(exc.code, str(exc), 404)
    kind = str(data.get("signal_type") or "")
    if kind not in {"ring", "end", "reject"}:
        return fail("VALIDATION_ERROR", "That call signal is not allowed.", 400)
    post_signal(
        target,
        {
            "from_user_id": g.current_user.id,
            "from_name": g.current_user.name,
            "call_id": data.get("call_id"),
            "signal_type": kind,
            "media": data.get("media") or "audio",
        },
    )
    return ok({"queued": True})


@calls_bp.get("/poll")
@login_required
@limiter.exempt
def poll():
    return ok({"signals": drain_signals(g.current_user.id)})


@calls_bp.post("/accept")
@login_required
def accept():
    try:
        data = require_json(request.get_json(silent=True))
        call_id = require_string(data, "call_id")
        payload = accept_call(call_id, g.current_user)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except CallingServiceError as exc:
        return fail(exc.code, str(exc), 404)
    payload["spoken"] = "Call connected."
    return ok(payload)
