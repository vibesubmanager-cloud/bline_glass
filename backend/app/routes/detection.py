from flask import Blueprint, current_app, g, request

from app.services.response_engine import speak_detections, speak_error
from app.services.usage_service import record_usage
from app.services.yolo_service import get_yolo_service
from app.utils.logging import log_event
from app.utils.responses import fail, ok
from app.utils.security import login_required
from app.utils.validation import ValidationError, load_image_from_base64, load_image_from_upload

detection_bp = Blueprint("detection", __name__)


@detection_bp.route("/", methods=["POST"], strict_slashes=False)
@login_required
def detect():
    log_event("DETECTION_REQUEST", user_id=g.current_user.id)
    query_object = None
    try:
        if "image" in request.files:
            image = load_image_from_upload(request.files["image"])
            query_object = (request.form.get("object") or "").strip() or None
        else:
            data = request.get_json(silent=True) or {}
            image = load_image_from_base64(data.get("image"))
            query_object = (data.get("object") or "").strip() or None
        confidence = float(current_app.config.get("YOLO_CONFIDENCE", 0.35))
        detections = get_yolo_service().detect(image, confidence=confidence)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except Exception:
        return fail(
            "DETECTION_SERVICE_ERROR",
            speak_error("DETECTION_SERVICE_ERROR"),
            503,
        )
    spoken = speak_detections(detections, query_object=query_object)
    record_usage("YOLO_DETECT", g.current_user.id, {"count": len(detections)})
    return ok({"detections": detections, "count": len(detections), "spoken": spoken})
