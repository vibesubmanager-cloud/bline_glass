from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.extensions import db


def _utcnow():
    return datetime.now(timezone.utc)


class ApiKey(db.Model):
    __tablename__ = "api_keys"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    provider = db.Column(db.String(32), nullable=False, index=True)
    label = db.Column(db.String(80), nullable=False, default="Key")
    key_value = db.Column(db.Text, nullable=False)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    sort_order = db.Column(db.Integer, default=0, nullable=False)
    last_ok_at = db.Column(db.DateTime(timezone=True), nullable=True)
    last_error = db.Column(db.String(180), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    def hint(self) -> str:
        value = self.key_value or ""
        if len(value) <= 4:
            return "••••"
        return f"••••{value[-4:]}"

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "provider": self.provider,
            "label": self.label,
            "hint": self.hint(),
            "is_active": bool(self.is_active),
            "sort_order": self.sort_order,
            "last_ok_at": self.last_ok_at.isoformat() if self.last_ok_at else None,
            "last_error": self.last_error,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
