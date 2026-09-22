from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.extensions import db


def _utcnow():
    return datetime.now(timezone.utc)


class EmergencyEvent(db.Model):
    __tablename__ = "emergency_events"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)
    latitude = db.Column(db.Float, nullable=True)
    longitude = db.Column(db.Float, nullable=True)
    accuracy_meters = db.Column(db.Float, nullable=True)
    location_shared = db.Column(db.Boolean, default=False, nullable=False)
    status = db.Column(db.String(32), default="activated", nullable=False, index=True)
    notified_contact_ids = db.Column(db.JSON, default=list)
    started_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
    resolved_at = db.Column(db.DateTime(timezone=True), nullable=True)

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "latitude": self.latitude if self.location_shared else None,
            "longitude": self.longitude if self.location_shared else None,
            "accuracy_meters": self.accuracy_meters if self.location_shared else None,
            "location_shared": self.location_shared,
            "status": self.status,
            "notified_contact_ids": self.notified_contact_ids or [],
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
        }
