from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.extensions import db


def _utcnow():
    return datetime.now(timezone.utc)


class Message(db.Model):
    __tablename__ = "messages"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    conversation_id = db.Column(db.String(80), nullable=False, index=True)
    sender_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)
    recipient_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)
    type = db.Column(db.String(16), default="text", nullable=False)
    body = db.Column(db.Text, nullable=True)
    media_filename = db.Column(db.String(180), nullable=True)
    media_mime = db.Column(db.String(80), nullable=True)
    latitude = db.Column(db.Float, nullable=True)
    longitude = db.Column(db.Float, nullable=True)
    maps_url = db.Column(db.String(255), nullable=True)
    read_at = db.Column(db.DateTime(timezone=True), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False, index=True)

    def public_dict(self, viewer_id: str | None = None) -> dict:
        item = {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "sender_id": self.sender_id,
            "recipient_id": self.recipient_id,
            "type": self.type,
            "body": self.body,
            "maps_url": self.maps_url,
            "latitude": self.latitude,
            "longitude": self.longitude,
            "has_media": bool(self.media_filename),
            "media_url": (
                self.media_filename
                if self.media_filename and str(self.media_filename).startswith("http")
                else (f"/api/messages/media/{self.id}" if self.media_filename else None)
            ),
            "mine": viewer_id == self.sender_id if viewer_id else False,
            "read_at": self.read_at.isoformat() if self.read_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
        return item
