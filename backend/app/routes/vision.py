from flask import Blueprint, g, request

from app.services.gemini_service import GeminiServiceError, get_gemini_service
from app.services.response_engine import speak_read_result
from app.services.subscription_service import vision_gate
from app.services.usage_service import record_usage
from app.utils.logging import log_event
from app.utils.responses import fail, ok
from app.utils.security import login_required
from app.utils.validation import ValidationError, load_image_from_base64, load_image_from_upload, require_string

vision_bp = Blueprint("vision", __name__)


def _load_image():
    if "image" in request.files:
        return load_image_from_upload(request.files["image"])
    data = request.get_json(silent=True) or {}
    if data.get("image"):
        return load_image_from_base64(data["image"])
    raise ValidationError("An image is required.", "IMAGE_REQUIRED")


@vision_bp.post("/read")
@login_required
def read_text():
    blocked = vision_gate(g.current_user)
    if blocked:
        return blocked
    log_event("VISION_REQUEST", kind="read", user_id=g.current_user.id)
    try:
        image = _load_image()
        result = get_gemini_service().read_text(image)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except GeminiServiceError as exc:
        return fail("VISION_SERVICE_ERROR", str(exc), 503)
    spoken = speak_read_result(result.get("text"), result.get("uncertain", False))
    record_usage("VISION_READ", g.current_user.id)
    return ok({"text": result.get("text"), "uncertain": result.get("uncertain", False), "spoken": spoken})


@vision_bp.post("/describe")
@login_required
def describe():
    blocked = vision_gate(g.current_user)
    if blocked:
        return blocked
    log_event("VISION_REQUEST", kind="describe", user_id=g.current_user.id)
    try:
        image = _load_image()
        result = get_gemini_service().describe(image)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except GeminiServiceError as exc:
        return fail("VISION_SERVICE_ERROR", str(exc), 503)
    record_usage("VISION_DESCRIBE", g.current_user.id)
    return ok({"description": result.get("description"), "spoken": result.get("description")})


@vision_bp.post("/question")
@login_required
def question():
    blocked = vision_gate(g.current_user)
    if blocked:
        return blocked
    log_event("VISION_REQUEST", kind="question", user_id=g.current_user.id)
    data = request.get_json(silent=True) or {}
    if request.form:
        data = {**data, **request.form.to_dict()}
    try:
        question_text = require_string(data if isinstance(data, dict) else {}, "question", max_len=500)
        image = _load_image()
        result = get_gemini_service().answer(image, question_text)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except GeminiServiceError as exc:
        return fail("VISION_SERVICE_ERROR", str(exc), 503)
    record_usage("VISION_QUESTION", g.current_user.id)
    return ok({"answer": result.get("answer"), "spoken": result.get("answer")})
