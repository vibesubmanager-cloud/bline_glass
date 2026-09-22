from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.extensions import db


def _utcnow():
    return datetime.now(timezone.utc)


class NavigationSession(db.Model):
    __tablename__ = "navigation_sessions"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)
    destination_query = db.Column(db.String(255), nullable=False)
    destination_name = db.Column(db.String(255), nullable=True)
    destination_lat = db.Column(db.Float, nullable=True)
    destination_lng = db.Column(db.Float, nullable=True)
    origin_lat = db.Column(db.Float, nullable=True)
    origin_lng = db.Column(db.Float, nullable=True)
    status = db.Column(db.String(32), default="active", nullable=False, index=True)
    route_summary = db.Column(db.JSON, nullable=True)
    started_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
    ended_at = db.Column(db.DateTime(timezone=True), nullable=True)

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "destination_query": self.destination_query,
            "destination_name": self.destination_name,
            "destination_lat": self.destination_lat,
            "destination_lng": self.destination_lng,
            "origin_lat": self.origin_lat,
            "origin_lng": self.origin_lng,
            "status": self.status,
            "route_summary": self.route_summary,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
        }
