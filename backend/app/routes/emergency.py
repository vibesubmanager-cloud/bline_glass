from flask import Blueprint, g, request

from app.services.emergency_service import EmergencyServiceError, activate_emergency, cancel_emergency
from app.services.usage_service import record_usage
from app.utils.logging import log_event
from app.utils.responses import fail, ok
from app.utils.security import login_required

emergency_bp = Blueprint("emergency", __name__)


@emergency_bp.post("/activate")
@login_required
def activate():
    data = request.get_json(silent=True) or {}
    try:
        payload = activate_emergency(
            g.current_user,
            latitude=data.get("latitude"),
            longitude=data.get("longitude"),
            accuracy=data.get("accuracy"),
            share_location=data.get("share_location"),
        )
    except EmergencyServiceError as exc:
        return fail(exc.code, str(exc), 400)
    log_event("EMERGENCY_ACTIVATED", user_id=g.current_user.id)
    record_usage("EMERGENCY_ACTIVATED", g.current_user.id)
    return ok(payload)


@emergency_bp.post("/cancel")
@login_required
def cancel():
    data = request.get_json(silent=True) or {}
    event_id = data.get("event_id")
    if not event_id:
        return fail("VALIDATION_ERROR", "event_id is required.", 400)
    try:
        payload = cancel_emergency(g.current_user, event_id)
    except EmergencyServiceError as exc:
        return fail(exc.code, str(exc), 404)
    return ok(payload)
