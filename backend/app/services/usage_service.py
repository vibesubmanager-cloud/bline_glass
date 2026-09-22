"""Optional usage logging. Never store images, audio, passwords, or tokens."""

from __future__ import annotations

from app.extensions import db
from app.models.usage import UsageLog
from app.utils.logging import logger


def record_usage(event_type: str, user_id: str | None = None, metadata: dict | None = None) -> None:
    try:
        log = UsageLog(event_type=event_type, user_id=user_id, metadata_json=metadata)
        db.session.add(log)
        db.session.commit()
    except Exception:
        db.session.rollback()
        logger.exception("USAGE_LOG_FAILED event=%s", event_type)
