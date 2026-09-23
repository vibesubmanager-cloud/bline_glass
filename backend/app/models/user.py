from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.extensions import db


def _utcnow():
    return datetime.now(timezone.utc)


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name = db.Column(db.String(120), nullable=False)
    first_name = db.Column(db.String(80), nullable=True)
    last_name = db.Column(db.String(80), nullable=True)
    username = db.Column(db.String(64), unique=True, nullable=True, index=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    phone = db.Column(db.String(32), unique=True, nullable=True, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(16), default="blind", nullable=False, index=True)
    system_id = db.Column(db.String(16), unique=True, nullable=True, index=True)
    health_notes = db.Column(db.Text, nullable=True)
    other_notes = db.Column(db.Text, nullable=True)
    linked_blind_user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=True, index=True)
    relationship_to_blind = db.Column(db.String(80), nullable=True)
    is_active = db.Column(db.Boolean, default=True, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    settings = db.relationship(
        "UserSettings", backref="user", uselist=False, cascade="all, delete-orphan"
    )
    contacts = db.relationship(
        "Contact",
        backref="owner",
        cascade="all, delete-orphan",
        foreign_keys="Contact.user_id",
    )

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "first_name": self.first_name,
            "last_name": self.last_name,
            "username": self.username,
            "email": self.email,
            "phone": self.phone,
            "role": self.role or "blind",
            "system_id": self.system_id,
            "health_notes": self.health_notes,
            "other_notes": self.other_notes,
            "linked_blind_user_id": self.linked_blind_user_id,
            "relationship_to_blind": self.relationship_to_blind,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }


class UserSettings(db.Model):
    __tablename__ = "user_settings"

    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), primary_key=True)
    speech_rate = db.Column(db.Float, default=1.0, nullable=False)
    high_contrast = db.Column(db.Boolean, default=True, nullable=False)
    voice_name = db.Column(db.String(120), nullable=True)
    language = db.Column(db.String(16), default="en-US", nullable=False)
    share_location_in_emergency = db.Column(db.Boolean, default=True, nullable=False)
    walking_directions = db.Column(db.Boolean, default=False, nullable=False)
    calling_configured = db.Column(db.Boolean, default=False, nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False
    )

    def public_dict(self) -> dict:
        return {
            "speech_rate": self.speech_rate,
            "high_contrast": self.high_contrast,
            "voice_name": self.voice_name,
            "language": self.language,
            "share_location_in_emergency": self.share_location_in_emergency,
            "walking_directions": bool(self.walking_directions),
            "calling_configured": bool(self.calling_configured),
        }
