from flask import Blueprint, g, request

from app.extensions import limiter
from app.services.payment_service import (
    apply_stripe_webhook,
    cancel_subscription,
    confirm_checkout,
    create_checkout,
)
from app.services.subscription_service import SubscriptionError, public_payload
from app.utils.responses import fail, ok
from app.utils.security import login_required
from app.utils.validation import ValidationError, require_json


billing_bp = Blueprint("billing", __name__)


def _error(exc: Exception):
    if isinstance(exc, SubscriptionError):
        return fail(exc.code, exc.message, exc.status)
    if isinstance(exc, ValidationError):
        return fail(exc.code, exc.message, 400)
    return fail("BILLING_ERROR", "I could not update your plan.", 400)


@billing_bp.get("/plans")
@login_required
def plans():
    return ok(public_payload(g.current_user))


@billing_bp.post("/subscribe")
@login_required
def subscribe():
    try:
        data = request.get_json(silent=True) or {}
        return_url = str(data.get("return_url") or "")
        return ok(create_checkout(g.current_user, return_url))
    except Exception as exc:
        return _error(exc)


@billing_bp.post("/confirm")
@login_required
def confirm():
    try:
        data = require_json(request.get_json(silent=True))
        return ok(confirm_checkout(g.current_user, data))
    except Exception as exc:
        return _error(exc)


@billing_bp.post("/cancel")
@login_required
def cancel():
    try:
        user = cancel_subscription(g.current_user)
        return ok({**public_payload(user), "spoken": "You are back on the free plan."})
    except Exception as exc:
        return _error(exc)


@billing_bp.post("/stripe/webhook")
@limiter.exempt
def stripe_webhook():
    try:
        return ok(apply_stripe_webhook(request.get_data() or b"", request.headers.get("Stripe-Signature") or ""))
    except SubscriptionError as exc:
        return fail(exc.code, exc.message, exc.status)
    except Exception:
        return fail("WEBHOOK_ERROR", "Stripe webhook failed.", 400)
