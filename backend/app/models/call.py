from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.extensions import db


def _utcnow():
    return datetime.now(timezone.utc)


class CallSession(db.Model):
    __tablename__ = "call_sessions"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    caller_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=False, index=True)
    callee_id = db.Column(db.String(36), db.ForeignKey("users.id"), nullable=True, index=True)
    contact_id = db.Column(db.String(36), db.ForeignKey("contacts.id"), nullable=True)
    call_type = db.Column(db.String(32), default="webrtc", nullable=False)
    status = db.Column(db.String(32), default="ringing", nullable=False, index=True)
    daily_room_name = db.Column(db.String(128), nullable=True)
    daily_room_url = db.Column(db.String(255), nullable=True)
    started_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
    ended_at = db.Column(db.DateTime(timezone=True), nullable=True)

    def public_dict(self) -> dict:
        return {
            "id": self.id,
            "caller_id": self.caller_id,
            "callee_id": self.callee_id,
            "contact_id": self.contact_id,
            "call_type": self.call_type,
            "status": self.status,
            "started_at": self.started_at.isoformat() if self.started_at else None,
            "ended_at": self.ended_at.isoformat() if self.ended_at else None,
        }


class CallSignal(db.Model):
    __tablename__ = "call_signals"

    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    target_user_id = db.Column(db.String(36), nullable=False, index=True)
    payload = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime(timezone=True), default=_utcnow, nullable=False)
