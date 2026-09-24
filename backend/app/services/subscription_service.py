"""Global subscription switch and per-user Free / Premium plans."""

from __future__ import annotations

from app.extensions import db
from app.models.settings import AppSettings
from app.models.user import User
from app.utils.responses import fail
from app.utils.validation import ValidationError, optional_string


SETTINGS_ID = 1
PREMIUM_SPOKEN = (
    "Describe and Read are on Premium. Open Plans to subscribe for five dollars a month."
)


class SubscriptionError(RuntimeError):
    def __init__(self, message: str, code: str = "SUBSCRIPTION_ERROR", status: int = 400):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status


def get_settings() -> AppSettings:
    row = db.session.get(AppSettings, SETTINGS_ID)
    if row:
        return row
    row = AppSettings(
        id=SETTINGS_ID,
        subscriptions_enabled=False,
        premium_price_cents=500,
        premium_interval="month",
        free_name="Free",
        premium_name="Premium",
        free_tagline="Detection, calls, and messages",
        premium_tagline="Describe and Read",
    )
    db.session.add(row)
    db.session.commit()
    return row


def user_plan(user: User | None) -> str:
    plan = (getattr(user, "plan", None) or "free").strip().lower()
    return "premium" if plan == "premium" else "free"


def can_use_premium_vision(user: User | None) -> bool:
    settings = get_settings()
    if not settings.subscriptions_enabled:
        return True
    return user_plan(user) == "premium"


def vision_gate(user: User | None):
    if can_use_premium_vision(user):
        return None
    return fail("PREMIUM_REQUIRED", PREMIUM_SPOKEN, 402)


def _price_label(cents: int, interval: str) -> str:
    dollars = max(0, int(cents or 0)) / 100
    if dollars == int(dollars):
        amount = f"${int(dollars)}"
    else:
        amount = f"${dollars:.2f}"
    unit = "month" if (interval or "month") == "month" else interval
    return f"{amount} / {unit}"


def public_payload(user: User | None) -> dict:
    settings = get_settings()
    plan = user_plan(user)
    enabled = bool(settings.subscriptions_enabled)
    from app.services.payment_service import payment_status

    pay = payment_status()
    return {
        "subscriptions_enabled": enabled,
        "can_describe": can_use_premium_vision(user),
        "user_plan": plan,
        "price_cents": settings.premium_price_cents,
        "price_label": _price_label(settings.premium_price_cents, settings.premium_interval),
        "interval": settings.premium_interval,
        "payment_provider": pay["payment_provider"],
        "payment_ready": pay["payment_ready"],
        "paypal_mode": pay["paypal_mode"],
        "plans": [
            {
                "id": "free",
                "name": settings.free_name,
                "tagline": settings.free_tagline,
                "price_label": "Free",
                "features": [
                    "Object detection",
                    "Video calls",
                    "Messages",
                ],
                "locked": [],
            },
            {
                "id": "premium",
                "name": settings.premium_name,
                "tagline": settings.premium_tagline,
                "price_label": _price_label(settings.premium_price_cents, settings.premium_interval),
                "features": [
                    "Everything in Free",
                    "Describe mode",
                    "Read mode",
                ],
                "locked": [],
            },
        ],
    }


def admin_payload() -> dict:
    settings = get_settings()
    data = public_payload(None)
    data.update(
        {
            "free_name": settings.free_name,
            "premium_name": settings.premium_name,
            "free_tagline": settings.free_tagline,
            "premium_tagline": settings.premium_tagline,
            "premium_price_cents": settings.premium_price_cents,
            "payment_provider": settings.payment_provider or "",
            "paypal_mode": settings.paypal_mode or "live",
        }
    )
    from app.services.payment_service import payment_status

    data.update(payment_status())
    return data


def update_settings(data: dict) -> AppSettings:
    settings = get_settings()
    previous_price = settings.premium_price_cents
    previous_interval = settings.premium_interval
    if "subscriptions_enabled" in data:
        settings.subscriptions_enabled = bool(data.get("subscriptions_enabled"))
    if "payment_provider" in data:
        provider = str(data.get("payment_provider") or "").strip().lower()
        if provider not in {"", "none", "stripe", "paypal"}:
            raise ValidationError("Payment provider must be none, Stripe, or PayPal.", "INVALID_PROVIDER")
        settings.payment_provider = "" if provider in {"", "none"} else provider
    if "paypal_mode" in data and data.get("paypal_mode"):
        mode = str(data.get("paypal_mode")).strip().lower()
        if mode not in {"live", "sandbox"}:
            raise ValidationError("PayPal mode must be live or sandbox.", "INVALID_MODE")
        if mode != (settings.paypal_mode or "live"):
            settings.paypal_plan_id = None
            settings.paypal_product_id = None
        settings.paypal_mode = mode
    if "premium_price_cents" in data and data.get("premium_price_cents") is not None:
        try:
            cents = int(data.get("premium_price_cents"))
        except (TypeError, ValueError) as exc:
            raise ValidationError("Enter a valid price in cents.", "INVALID_PRICE") from exc
        if cents < 0 or cents > 100000:
            raise ValidationError("Price must be between 0 and 1000 dollars.", "INVALID_PRICE")
        settings.premium_price_cents = cents
    if "premium_price_dollars" in data and data.get("premium_price_dollars") is not None:
        try:
            dollars = float(data.get("premium_price_dollars"))
        except (TypeError, ValueError) as exc:
            raise ValidationError("Enter a valid monthly price.", "INVALID_PRICE") from exc
        cents = int(round(dollars * 100))
        if cents < 0 or cents > 100000:
            raise ValidationError("Price must be between 0 and 1000 dollars.", "INVALID_PRICE")
        settings.premium_price_cents = cents
    if "premium_interval" in data and data.get("premium_interval"):
        interval = str(data.get("premium_interval")).strip().lower()
        if interval not in {"month", "year"}:
            raise ValidationError("Interval must be month or year.", "INVALID_INTERVAL")
        settings.premium_interval = interval
    if "free_name" in data:
        settings.free_name = optional_string(data, "free_name", 40) or "Free"
    if "premium_name" in data:
        settings.premium_name = optional_string(data, "premium_name", 40) or "Premium"
    if "free_tagline" in data:
        settings.free_tagline = optional_string(data, "free_tagline", 160) or settings.free_tagline
    if "premium_tagline" in data:
        settings.premium_tagline = optional_string(data, "premium_tagline", 160) or settings.premium_tagline
    if settings.premium_price_cents != previous_price or settings.premium_interval != previous_interval:
        settings.paypal_plan_id = None
    db.session.commit()
    return settings


def set_user_plan(user: User, plan: str) -> User:
    next_plan = (plan or "free").strip().lower()
    if next_plan not in {"free", "premium"}:
        raise ValidationError("Plan must be free or premium.", "INVALID_PLAN")
    user.plan = next_plan
    db.session.commit()
    return user
