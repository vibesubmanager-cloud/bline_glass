"""Input validation helpers. Never trust client payloads."""

from __future__ import annotations

import re
from typing import Any

from PIL import Image
from werkzeug.datastructures import FileStorage

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
PHONE_RE = re.compile(r"^\+?[0-9][0-9\-\s]{6,20}$")
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024


class ValidationError(ValueError):
    def __init__(self, message: str, code: str = "VALIDATION_ERROR"):
        super().__init__(message)
        self.code = code
        self.message = message


def require_json(data: Any) -> dict:
    if not isinstance(data, dict):
        raise ValidationError("Request body must be JSON.")
    return data


def require_string(data: dict, field: str, min_len: int = 1, max_len: int = 255) -> str:
    value = data.get(field)
    if not isinstance(value, str):
        raise ValidationError(f"{field} is required.")
    value = value.strip()
    if len(value) < min_len or len(value) > max_len:
        raise ValidationError(f"{field} must be between {min_len} and {max_len} characters.")
    return value


def optional_string(data: dict, field: str, max_len: int = 255) -> str | None:
    value = data.get(field)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be text.")
    value = value.strip()
    if len(value) > max_len:
        raise ValidationError(f"{field} is too long.")
    return value


def validate_email(email: str) -> str:
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise ValidationError("Please enter a valid email address.")
    return email


def validate_username(username: str) -> str:
    value = (username or "").strip()
    if len(value) < 3 or len(value) > 32:
        raise ValidationError("Username must be between 3 and 32 characters.")
    if not re.match(r"^[A-Za-z0-9._]+$", value):
        raise ValidationError("Username can only use letters, numbers, dots, and underscores.")
    return value.lower()


def validate_password(password: str) -> str:
    if len(password) < 8:
        raise ValidationError("Password must be at least 8 characters.")
    if len(password) > 128:
        raise ValidationError("Password is too long.")
    return password


def validate_phone(phone: str | None) -> str | None:
    if not phone:
        return None
    compact = phone.strip()
    if not PHONE_RE.match(compact):
        raise ValidationError("Please enter a valid phone number.")
    return compact


def validate_lat_lng(lat, lng) -> tuple[float, float]:
    try:
        lat_f = float(lat)
        lng_f = float(lng)
    except (TypeError, ValueError) as exc:
        raise ValidationError("Location coordinates are invalid.") from exc
    if not -90 <= lat_f <= 90 or not -180 <= lng_f <= 180:
        raise ValidationError("Location coordinates are out of range.")
    return lat_f, lng_f


def load_image_from_upload(file: FileStorage) -> Image.Image:
    if not file or not file.filename:
        raise ValidationError("An image is required.", "IMAGE_REQUIRED")
    mime = (file.mimetype or "").lower()
    if mime not in ALLOWED_IMAGE_TYPES:
        raise ValidationError("Please send a JPEG, PNG, or WebP image.", "IMAGE_TYPE")
    file.stream.seek(0, 2)
    size = file.stream.tell()
    file.stream.seek(0)
    if size > MAX_IMAGE_BYTES:
        raise ValidationError("Image is too large. Maximum size is 5 MB.", "IMAGE_TOO_LARGE")
    try:
        image = Image.open(file.stream)
        image.load()
        image = image.convert("RGB")
    except Exception as exc:
        raise ValidationError("I could not read that image.", "IMAGE_INVALID") from exc
    return image


def load_image_from_base64(data_url: str) -> Image.Image:
    import base64
    import io

    if not data_url or not isinstance(data_url, str):
        raise ValidationError("An image is required.", "IMAGE_REQUIRED")
    payload = data_url.split(",", 1)[-1]
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception as exc:
        raise ValidationError("I could not read that image.", "IMAGE_INVALID") from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise ValidationError("Image is too large. Maximum size is 5 MB.", "IMAGE_TOO_LARGE")
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
        return image.convert("RGB")
    except Exception as exc:
        raise ValidationError("I could not read that image.", "IMAGE_INVALID") from exc
