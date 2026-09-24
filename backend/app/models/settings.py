from __future__ import annotations

from datetime import datetime, timezone

from app.extensions import db


def _utcnow():
    return datetime.now(timezone.utc)


class AppSettings(db.Model):
    __tablename__ = "app_settings"

    id = db.Column(db.Integer, primary_key=True)
    subscriptions_enabled = db.Column(db.Boolean, default=False, nullable=False)
    premium_price_cents = db.Column(db.Integer, default=500, nullable=False)
    premium_interval = db.Column(db.String(16), default="month", nullable=False)
    free_name = db.Column(db.String(40), default="Free", nullable=False)
    premium_name = db.Column(db.String(40), default="Premium", nullable=False)
    free_tagline = db.Column(db.String(160), default="Detection, calls, and messages", nullable=False)
    premium_tagline = db.Column(db.String(160), default="Describe and Read", nullable=False)
    payment_provider = db.Column(db.String(16), default="", nullable=False)
    paypal_mode = db.Column(db.String(16), default="live", nullable=False)
    paypal_product_id = db.Column(db.String(64), nullable=True)
    paypal_plan_id = db.Column(db.String(64), nullable=True)
    updated_at = db.Column(db.DateTime(timezone=True), default=_utcnow, onupdate=_utcnow, nullable=False)
