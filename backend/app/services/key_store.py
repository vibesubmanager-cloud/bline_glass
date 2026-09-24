"""Stored API keys for Gemini and Groq. Admin can add up to 20 per provider."""

from __future__ import annotations

from datetime import datetime, timezone

from flask import current_app

from app.extensions import db
from app.models.api_key import ApiKey

PROVIDERS = (
    "gemini",
    "groq",
    "daily",
    "stripe_secret",
    "stripe_publishable",
    "stripe_webhook",
    "paypal_client",
    "paypal_secret",
)
MAX_KEYS_PER_PROVIDER = 20
_ENV_FIELDS = {
    "gemini": "GEMINI_API_KEY",
    "groq": "GROQ_API_KEY",
    "daily": "DAILY_API_KEY",
    "stripe_secret": "STRIPE_SECRET_KEY",
    "stripe_publishable": "STRIPE_PUBLISHABLE_KEY",
    "stripe_webhook": "STRIPE_WEBHOOK_SECRET",
    "paypal_client": "PAYPAL_CLIENT_ID",
    "paypal_secret": "PAYPAL_SECRET",
}


class KeyStoreError(RuntimeError):
    def __init__(self, message: str, code: str = "KEY_ERROR", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def _utcnow():
    return datetime.now(timezone.utc)


def seed_env_keys() -> None:
    for provider, field in _ENV_FIELDS.items():
        if ApiKey.query.filter_by(provider=provider).first():
            continue
        value = (current_app.config.get(field) or "").strip()
        if not value:
            continue
        db.session.add(
            ApiKey(
                provider=provider,
                label="From server .env",
                key_value=value,
                sort_order=0,
                is_active=True,
            )
        )
    db.session.commit()


def list_keys(provider: str | None = None) -> list[ApiKey]:
    query = ApiKey.query
    if provider:
        query = query.filter_by(provider=provider)
    return query.order_by(ApiKey.provider.asc(), ApiKey.sort_order.asc(), ApiKey.created_at.asc()).all()


def active_secrets(provider: str) -> list[tuple[ApiKey | None, str]]:
    rows = [row for row in list_keys(provider) if row.is_active and (row.key_value or "").strip()]
    rows.sort(
        key=lambda row: (
            0 if row.last_ok_at else 1,
            -(row.last_ok_at.timestamp() if row.last_ok_at else 0),
            row.sort_order,
        )
    )
    if rows:
        return [(row, row.key_value.strip()) for row in rows]
    env_value = (current_app.config.get(_ENV_FIELDS.get(provider, ""), "") or "").strip()
    if env_value:
        return [(None, env_value)]
    return []


def mark_ok(row: ApiKey | None) -> None:
    if row is None:
        return
    row.last_ok_at = _utcnow()
    row.last_error = None
    db.session.commit()


def mark_error(row: ApiKey | None, message: str) -> None:
    if row is None:
        return
    row.last_error = (message or "Key failed")[:180]
    db.session.commit()


def add_key(provider: str, key_value: str, label: str | None = None) -> ApiKey:
    provider = (provider or "").strip().lower()
    if provider not in PROVIDERS:
        raise KeyStoreError("Choose a supported provider.")
    secret = (key_value or "").strip()
    if len(secret) < 8:
        raise KeyStoreError("Paste a full API key.")
    count = ApiKey.query.filter_by(provider=provider).count()
    if count >= MAX_KEYS_PER_PROVIDER:
        raise KeyStoreError(f"You can store at most {MAX_KEYS_PER_PROVIDER} {provider} keys.")
    if ApiKey.query.filter_by(provider=provider, key_value=secret).first():
        raise KeyStoreError("That key is already saved.", "KEY_EXISTS", 409)
    row = ApiKey(
        provider=provider,
        label=(label or f"{provider} key {count + 1}").strip()[:80],
        key_value=secret,
        sort_order=count,
        is_active=True,
    )
    db.session.add(row)
    db.session.commit()
    return row


def update_key(row: ApiKey, *, label=None, key_value=None, is_active=None, sort_order=None) -> ApiKey:
    if label is not None:
        row.label = str(label).strip()[:80] or row.label
    if key_value:
        secret = str(key_value).strip()
        if len(secret) < 8:
            raise KeyStoreError("Paste a full API key.")
        row.key_value = secret
    if is_active is not None:
        row.is_active = bool(is_active)
    if sort_order is not None:
        row.sort_order = int(sort_order)
    db.session.commit()
    return row


def delete_key(row: ApiKey) -> None:
    db.session.delete(row)
    db.session.commit()


def upsert_key(provider: str, key_value: str, label: str | None = None) -> ApiKey:
    provider = (provider or "").strip().lower()
    if provider not in PROVIDERS:
        raise KeyStoreError("Choose a supported provider.")
    secret = (key_value or "").strip()
    if len(secret) < 8:
        raise KeyStoreError("Paste a full API key.")
    row = ApiKey.query.filter_by(provider=provider).order_by(ApiKey.sort_order.asc(), ApiKey.created_at.asc()).first()
    if row:
        return update_key(row, label=label or row.label, key_value=secret, is_active=True)
    return add_key(provider, secret, label)
