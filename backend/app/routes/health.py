from flask import Blueprint, current_app, request

from app.services.gemini_service import get_gemini_service
from app.services.groq_service import get_groq_service
from app.utils.logging import arrow, log_error
from app.utils.responses import fail, ok
from app.utils.security import login_required
from app.utils.validation import ValidationError, load_image_from_upload

health_bp = Blueprint("health", __name__)


@health_bp.get("/health")
def health():
    return ok(
        {
            "service": "vibe-eye",
            "status": "ok",
            "gemini_configured": bool(current_app.config.get("GEMINI_API_KEY")),
            "groq_configured": bool(current_app.config.get("GROQ_API_KEY")),
            "maps_configured": True,
            "cloudinary_configured": bool(current_app.config.get("CLOUDINARY_CLOUD_NAME")),
            "jitsi_domain": "meet.jit.si",
        }
    )


@health_bp.get("/branding")
def branding():
    from app.services.branding_service import branding_payload

    return ok(branding_payload())


@health_bp.post("/health/groq")
@login_required
def test_groq():
    arrow("GROQ TEST START")
    try:
        data = request.get_json(silent=True) or {}
        text = data.get("text") if isinstance(data.get("text"), str) else ""
        arrow(f"GROQ TEST TEXT={text[:80]!r}")
        result = get_groq_service().ping_chat(text)
        arrow(f"GROQ TEST DONE ok={result.get('ok')} ms={result.get('ms')} reply={(result.get('reply') or '')[:120]!r}")
        return ok(result)
    except Exception as exc:
        arrow(f"GROQ TEST CRASH {type(exc).__name__}: {exc}")
        log_error("GROQ_TEST_FAILED", exc)
        return ok({"ok": False, "reply": f"Groq test crashed: {exc}", "ms": 0})


@health_bp.post("/health/gemini")
@login_required
def test_gemini():
    arrow("GEMINI TEST START")
    try:
        if "image" not in request.files:
            raise ValidationError("Upload a photo to test Gemini.", "IMAGE_REQUIRED")
        image = load_image_from_upload(request.files["image"])
        result = get_gemini_service().ping_describe(image)
        arrow(f"GEMINI TEST DONE ok={result.get('ok')} ms={result.get('ms')} reply={(result.get('reply') or '')[:120]!r}")
        return ok(result)
    except ValidationError as exc:
        arrow(f"GEMINI TEST VALIDATION {exc}")
        return fail(exc.code, exc.message, 400)
    except Exception as exc:
        arrow(f"GEMINI TEST CRASH {type(exc).__name__}: {exc}")
        log_error("GEMINI_TEST_FAILED", exc)
        return ok({"ok": False, "reply": f"Gemini test crashed: {exc}", "ms": 0})
