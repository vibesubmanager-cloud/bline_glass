"""App logo stored in Admin and shown on the live camera HUD."""

from __future__ import annotations

import base64
import io

from PIL import Image
from werkzeug.datastructures import FileStorage

from app.extensions import db
from app.services.cloudinary_service import CloudinaryServiceError, get_cloudinary_service
from app.services.subscription_service import get_settings
from app.utils.validation import ValidationError

MAX_LOGO_BYTES = 3 * 1024 * 1024
MAX_LOGO_SIDE = 256


def branding_payload() -> dict:
    settings = get_settings()
    return {"logo_url": settings.logo_url or ""}


def save_logo(file: FileStorage) -> dict:
    if not file or not file.filename:
        raise ValidationError("Choose a logo image.", "IMAGE_REQUIRED")
    mime = (file.mimetype or "").lower()
    if mime not in {"image/jpeg", "image/jpg", "image/png", "image/webp"}:
        raise ValidationError("Use a JPEG, PNG, or WebP logo.", "IMAGE_TYPE")
    file.stream.seek(0, 2)
    size = file.stream.tell()
    file.stream.seek(0)
    if size > MAX_LOGO_BYTES:
        raise ValidationError("That logo is too large. Use an image under 3 MB.", "IMAGE_TOO_LARGE")
    try:
        image = Image.open(file.stream)
        image.load()
    except Exception as exc:
        raise ValidationError("I could not read that logo.", "IMAGE_INVALID") from exc
    image.thumbnail((MAX_LOGO_SIDE, MAX_LOGO_SIDE))
    buffer = io.BytesIO()
    keep_alpha = image.mode in {"RGBA", "LA"} or "transparency" in image.info
    if keep_alpha:
        image = image.convert("RGBA")
        image.save(buffer, format="PNG", optimize=True)
        out_mime = "image/png"
    else:
        image = image.convert("RGB")
        image.save(buffer, format="JPEG", quality=88)
        out_mime = "image/jpeg"
    data = buffer.getvalue()
    url = None
    cloud = get_cloudinary_service()
    if cloud.configured():
        try:
            result = cloud.upload_bytes(data, folder="aisight/brand", resource_type="image")
            url = result.get("url")
        except CloudinaryServiceError:
            url = None
    if not url:
        encoded = base64.b64encode(data).decode("ascii")
        url = f"data:{out_mime};base64,{encoded}"
    settings = get_settings()
    settings.logo_url = url
    db.session.commit()
    return branding_payload()


def clear_logo() -> dict:
    settings = get_settings()
    settings.logo_url = None
    db.session.commit()
    return branding_payload()
