from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.extensions import db


def _utcnow():
    return datetime.now(timezone.utc)


class Contact(db.Model):
    __tablename__ = "contacts"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)
    name = db.Column(db.String(120), nullable=False)
    phone = db.Column(db.String(32), nullable=True)
    relationship = db.Column(db.String(80), nullable=True)
    is_emergency_contact = db.Column(db.Boolean, default=False, nullable=False)
    linked_user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "phone": self.phone,
            "relationship": self.relationship,
            "is_emergency_contact": self.is_emergency_contact,
            "linked_user_id": self.linked_user_id,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
