"""Cloudinary uploads. Credentials stay on the backend. Images are not stored by default."""

from __future__ import annotations

import io

from PIL import Image

from app.utils.logging import log_error, log_event


class CloudinaryServiceError(RuntimeError):
    pass


class CloudinaryService:
    def __init__(self, cloud_name: str, api_key: str, api_secret: str):
        self.cloud_name = cloud_name
        self.api_key = api_key
        self.api_secret = api_secret

    def configured(self) -> bool:
        return bool(self.cloud_name and self.api_key and self.api_secret)

    def upload_bytes(self, data: bytes, *, folder: str = "aisight", resource_type: str = "auto") -> dict:
        if not self.configured():
            raise CloudinaryServiceError("Cloudinary is not configured.")
        try:
            import cloudinary
            import cloudinary.uploader
        except ImportError as exc:
            raise CloudinaryServiceError("Cloudinary library is not installed.") from exc

        cloudinary.config(
            cloud_name=self.cloud_name,
            api_key=self.api_key,
            api_secret=self.api_secret,
            secure=True,
        )
        try:
            result = cloudinary.uploader.upload(
                io.BytesIO(data),
                folder=folder,
                resource_type=resource_type,
            )
        except Exception as exc:
            log_error("CLOUDINARY_ERROR", exc)
            raise CloudinaryServiceError("Image storage is temporarily unavailable.") from exc
        log_event("CLOUDINARY_UPLOAD", public_id=result.get("public_id"))
        return {
            "public_id": result.get("public_id"),
            "url": result.get("secure_url") or result.get("url"),
        }

    def upload_image(self, image: Image.Image, folder: str = "aisight") -> dict:
        if not self.configured():
            raise CloudinaryServiceError("Cloudinary is not configured.")
        try:
            import cloudinary
            import cloudinary.uploader
        except ImportError as exc:
            raise CloudinaryServiceError("Cloudinary library is not installed.") from exc

        cloudinary.config(
            cloud_name=self.cloud_name,
            api_key=self.api_key,
            api_secret=self.api_secret,
            secure=True,
        )
        buffer = io.BytesIO()
        image.convert("RGB").save(buffer, format="JPEG", quality=80)
        buffer.seek(0)
        try:
            result = cloudinary.uploader.upload(
                buffer,
                folder=folder,
                resource_type="image",
            )
        except Exception as exc:
            log_error("CLOUDINARY_ERROR", exc)
            raise CloudinaryServiceError("Image storage is temporarily unavailable.") from exc
        log_event("CLOUDINARY_UPLOAD", public_id=result.get("public_id"))
        return {
            "public_id": result.get("public_id"),
            "url": result.get("secure_url") or result.get("url"),
        }


def get_cloudinary_service() -> CloudinaryService:
    from flask import current_app

    return CloudinaryService(
        cloud_name=current_app.config.get("CLOUDINARY_CLOUD_NAME", ""),
        api_key=current_app.config.get("CLOUDINARY_API_KEY", ""),
        api_secret=current_app.config.get("CLOUDINARY_API_SECRET", ""),
    )
