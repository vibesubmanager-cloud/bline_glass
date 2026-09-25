"""Stripe Checkout and PayPal Subscriptions using keys stored in Admin."""

from __future__ import annotations

import hashlib
import hmac
import json
from urllib.parse import urlparse

import requests

from app.extensions import db
from app.models.user import User
from app.services.key_store import active_secrets, upsert_key
from app.services.subscription_service import SubscriptionError, get_settings, set_user_plan
from app.utils.validation import ValidationError


STRIPE_API = "https://api.stripe.com/v1"
PAYPAL_LIVE = "https://api-m.paypal.com"
PAYPAL_SANDBOX = "https://api-m.sandbox.paypal.com"
HTTP_TIMEOUT = 25

PAYMENT_FIELDS = {
    "stripe_secret": ("stripe_secret", "Stripe secret key"),
    "stripe_publishable": ("stripe_publishable", "Stripe publishable key"),
    "stripe_webhook": ("stripe_webhook", "Stripe webhook secret"),
    "paypal_client_id": ("paypal_client", "PayPal client ID"),
    "paypal_secret": ("paypal_secret", "PayPal secret"),
}


def first_secret(provider: str) -> str:
    rows = active_secrets(provider)
    return rows[0][1] if rows else ""


def payment_status() -> dict:
    settings = get_settings()
    stripe_secret = bool(first_secret("stripe_secret"))
    stripe_publishable = bool(first_secret("stripe_publishable"))
    paypal_client = bool(first_secret("paypal_client"))
    paypal_secret = bool(first_secret("paypal_secret"))
    provider = (settings.payment_provider or "").strip().lower()
    if provider not in {"stripe", "paypal"}:
        provider = ""
    stripe_ready = stripe_secret and stripe_publishable
    paypal_ready = paypal_client and paypal_secret
    ready = (provider == "stripe" and stripe_ready) or (provider == "paypal" and paypal_ready)
    return {
        "payment_provider": provider,
        "paypal_mode": settings.paypal_mode or "live",
        "stripe_ready": stripe_ready,
        "paypal_ready": paypal_ready,
        "payment_ready": ready,
        "stripe_secret_saved": stripe_secret,
        "stripe_publishable_saved": stripe_publishable,
        "stripe_webhook_saved": bool(first_secret("stripe_webhook")),
        "paypal_client_saved": paypal_client,
        "paypal_secret_saved": paypal_secret,
    }


def save_payment_keys(data: dict) -> None:
    for field, (provider, label) in PAYMENT_FIELDS.items():
        value = str(data.get(field) or "").strip()
        if not value or value.startswith("••••"):
            continue
        upsert_key(provider, value, label)


def ping_stripe(secret: str) -> dict:
    response = requests.get(
        f"{STRIPE_API}/balance",
        auth=(secret, ""),
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code >= 400:
        message = _stripe_error(response)
        return {"ok": False, "reply": message}
    return {"ok": True, "reply": "Stripe secret key works."}


def ping_paypal(client_id: str, secret: str, mode: str = "live") -> dict:
    try:
        _paypal_token(client_id, secret, mode)
    except SubscriptionError as exc:
        return {"ok": False, "reply": exc.message}
    return {"ok": True, "reply": "PayPal client ID and secret work."}


def create_checkout(user: User, return_url: str) -> dict:
    settings = get_settings()
    status = payment_status()
    provider = status["payment_provider"]
    if not provider:
        user = set_user_plan(user, "premium")
        return {
            "checkout_url": None,
            "provider": "",
            **_payload(user),
            "spoken": "Premium is on. You can use Describe and Read.",
        }
    if not status["payment_ready"]:
        raise SubscriptionError(
            "Save the Stripe or PayPal keys in Admin, then choose that provider on Subscriptions.",
            "PAYMENT_NOT_READY",
            400,
        )
    safe_return = _safe_return_url(return_url)
    if provider == "stripe":
        url = _stripe_checkout(user, settings, safe_return)
        spoken = "Opening Stripe to pay for Premium."
    else:
        url = _paypal_checkout(user, settings, safe_return)
        spoken = "Opening PayPal to pay for Premium."
    return {
        "checkout_url": url,
        "provider": provider,
        **_payload(user),
        "spoken": spoken,
    }


def confirm_checkout(user: User, data: dict) -> dict:
    provider = str(data.get("provider") or "").strip().lower()
    if provider == "stripe":
        _confirm_stripe(user, str(data.get("session_id") or ""))
    elif provider == "paypal":
        _confirm_paypal(user, str(data.get("subscription_id") or data.get("token") or ""))
    else:
        raise ValidationError("Choose Stripe or PayPal to confirm.", "INVALID_PROVIDER")
    return {
        **_payload(user),
        "spoken": "Premium is on. You can use Describe and Read.",
    }


def cancel_subscription(user: User) -> User:
    try:
        if user.stripe_subscription_id:
            secret = first_secret("stripe_secret")
            if secret:
                requests.delete(
                    f"{STRIPE_API}/subscriptions/{user.stripe_subscription_id}",
                    auth=(secret, ""),
                    timeout=HTTP_TIMEOUT,
                )
        if user.paypal_subscription_id:
            token = _paypal_token(first_secret("paypal_client"), first_secret("paypal_secret"), get_settings().paypal_mode)
            if token:
                requests.post(
                    f"{_paypal_base()}/v1/billing/subscriptions/{user.paypal_subscription_id}/cancel",
                    headers=_paypal_headers(token),
                    json={"reason": "Cancelled in vibeEye"},
                    timeout=HTTP_TIMEOUT,
                )
    except Exception:
        pass
    user.stripe_subscription_id = None
    user.paypal_subscription_id = None
    return set_user_plan(user, "free")


def apply_stripe_webhook(payload: bytes, signature: str) -> dict:
    secret = first_secret("stripe_webhook")
    if secret and not _stripe_signature_ok(payload, signature, secret):
        raise SubscriptionError("Stripe webhook signature is invalid.", "WEBHOOK_INVALID", 400)
    try:
        event = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SubscriptionError("Stripe webhook body is invalid.", "WEBHOOK_INVALID", 400) from exc
    kind = event.get("type") or ""
    obj = (event.get("data") or {}).get("object") or {}
    user = _user_from_stripe_object(obj)
    if not user:
        return {"ok": True, "ignored": True}
    if kind in {"checkout.session.completed", "invoice.paid", "customer.subscription.updated"}:
        status = (obj.get("status") or obj.get("payment_status") or "").lower()
        if kind == "customer.subscription.updated" and status in {"canceled", "unpaid", "incomplete_expired"}:
            user.plan = "free"
        else:
            user.plan = "premium"
            if obj.get("subscription"):
                user.stripe_subscription_id = str(obj.get("subscription"))
            if obj.get("id") and str(obj.get("id")).startswith("sub_"):
                user.stripe_subscription_id = str(obj.get("id"))
            if obj.get("customer"):
                user.stripe_customer_id = str(obj.get("customer"))
    elif kind in {"customer.subscription.deleted", "invoice.payment_failed"}:
        if kind == "customer.subscription.deleted":
            user.plan = "free"
            user.stripe_subscription_id = None
    db.session.commit()
    return {"ok": True}


def _payload(user: User) -> dict:
    from app.services.subscription_service import public_payload

    return public_payload(user)


def _safe_return_url(raw: str) -> str:
    url = (raw or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValidationError("Open Plans from the app so payment can return here.", "INVALID_RETURN")
    return url.split("?")[0]


def _stripe_checkout(user: User, settings, return_url: str) -> str:
    secret = first_secret("stripe_secret")
    interval = "year" if settings.premium_interval == "year" else "month"
    name = settings.premium_name or "vibeEye Premium"
    data = {
        "mode": "subscription",
        "success_url": f"{return_url}?billing=success&session_id={{CHECKOUT_SESSION_ID}}",
        "cancel_url": f"{return_url}?billing=cancel",
        "client_reference_id": user.id,
        "customer_email": user.email or "",
        "metadata[user_id]": user.id,
        "line_items[0][quantity]": 1,
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": int(settings.premium_price_cents or 500),
        "line_items[0][price_data][product_data][name]": name,
        "line_items[0][price_data][recurring][interval]": interval,
        "subscription_data[metadata][user_id]": user.id,
    }
    response = requests.post(
        f"{STRIPE_API}/checkout/sessions",
        auth=(secret, ""),
        data=data,
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code >= 400:
        raise SubscriptionError(_stripe_error(response), "STRIPE_ERROR", 502)
    url = (response.json() or {}).get("url")
    if not url:
        raise SubscriptionError("Stripe did not return a checkout page.", "STRIPE_ERROR", 502)
    return url


def _confirm_stripe(user: User, session_id: str) -> None:
    session_id = (session_id or "").strip()
    if not session_id:
        raise ValidationError("Stripe did not return a session.", "MISSING_SESSION")
    secret = first_secret("stripe_secret")
    if not secret:
        raise SubscriptionError("Stripe is not configured.", "PAYMENT_NOT_READY", 400)
    response = requests.get(
        f"{STRIPE_API}/checkout/sessions/{session_id}",
        auth=(secret, ""),
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code >= 400:
        raise SubscriptionError(_stripe_error(response), "STRIPE_ERROR", 502)
    session = response.json() or {}
    ref = str(session.get("client_reference_id") or "")
    if ref and ref != user.id:
        raise SubscriptionError("That payment does not belong to this account.", "PAYMENT_MISMATCH", 403)
    paid = (session.get("payment_status") or "").lower() in {"paid", "no_payment_required"}
    status = (session.get("status") or "").lower()
    if not paid and status != "complete":
        raise SubscriptionError("That Stripe payment is not complete yet.", "PAYMENT_INCOMPLETE", 400)
    user.plan = "premium"
    if session.get("customer"):
        user.stripe_customer_id = str(session.get("customer"))
    if session.get("subscription"):
        user.stripe_subscription_id = str(session.get("subscription"))
    db.session.commit()


def _paypal_base() -> str:
    mode = (get_settings().paypal_mode or "live").strip().lower()
    return PAYPAL_SANDBOX if mode == "sandbox" else PAYPAL_LIVE


def _paypal_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _paypal_token(client_id: str, secret: str, mode: str | None = None) -> str:
    if not client_id or not secret:
        raise SubscriptionError("Save the PayPal client ID and secret in Admin.", "PAYMENT_NOT_READY", 400)
    base = PAYPAL_SANDBOX if (mode or get_settings().paypal_mode) == "sandbox" else PAYPAL_LIVE
    response = requests.post(
        f"{base}/v1/oauth2/token",
        auth=(client_id, secret),
        data={"grant_type": "client_credentials"},
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code >= 400:
        raise SubscriptionError(_paypal_error(response), "PAYPAL_ERROR", 502)
    token = (response.json() or {}).get("access_token")
    if not token:
        raise SubscriptionError("PayPal did not return an access token.", "PAYPAL_ERROR", 502)
    return token


def _paypal_checkout(user: User, settings, return_url: str) -> str:
    token = _paypal_token(first_secret("paypal_client"), first_secret("paypal_secret"))
    plan_id = _ensure_paypal_plan(token, settings)
    response = requests.post(
        f"{_paypal_base()}/v1/billing/subscriptions",
        headers=_paypal_headers(token),
        json={
            "plan_id": plan_id,
            "custom_id": user.id,
            "application_context": {
                "brand_name": "vibeEye",
                "user_action": "SUBSCRIBE_NOW",
                "return_url": f"{return_url}?billing=paypal",
                "cancel_url": f"{return_url}?billing=cancel",
            },
        },
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code >= 400:
        raise SubscriptionError(_paypal_error(response), "PAYPAL_ERROR", 502)
    body = response.json() or {}
    for link in body.get("links") or []:
        if link.get("rel") in {"approve", "payer-action"}:
            sub_id = body.get("id")
            if sub_id:
                user.paypal_subscription_id = str(sub_id)
                db.session.commit()
            return link.get("href")
    raise SubscriptionError("PayPal did not return an approval page.", "PAYPAL_ERROR", 502)


def _ensure_paypal_plan(token: str, settings) -> str:
    cents = int(settings.premium_price_cents or 500)
    amount = f"{cents / 100:.2f}"
    interval = "YEAR" if settings.premium_interval == "year" else "MONTH"
    if settings.paypal_plan_id:
        return settings.paypal_plan_id
    product = requests.post(
        f"{_paypal_base()}/v1/catalogs/products",
        headers=_paypal_headers(token),
        json={
            "name": settings.premium_name or "vibeEye Premium",
            "type": "SERVICE",
            "description": settings.premium_tagline or "Describe and Read",
        },
        timeout=HTTP_TIMEOUT,
    )
    if product.status_code >= 400:
        raise SubscriptionError(_paypal_error(product), "PAYPAL_ERROR", 502)
    product_id = (product.json() or {}).get("id")
    plan = requests.post(
        f"{_paypal_base()}/v1/billing/plans",
        headers=_paypal_headers(token),
        json={
            "product_id": product_id,
            "name": f"{settings.premium_name or 'Premium'} {amount}",
            "billing_cycles": [
                {
                    "frequency": {"interval_unit": interval, "interval_count": 1},
                    "tenure_type": "REGULAR",
                    "sequence": 1,
                    "total_cycles": 0,
                    "pricing_scheme": {"fixed_price": {"value": amount, "currency_code": "USD"}},
                }
            ],
            "payment_preferences": {
                "auto_bill_outstanding": True,
                "payment_failure_threshold": 3,
            },
        },
        timeout=HTTP_TIMEOUT,
    )
    if plan.status_code >= 400:
        raise SubscriptionError(_paypal_error(plan), "PAYPAL_ERROR", 502)
    plan_id = (plan.json() or {}).get("id")
    if not plan_id:
        raise SubscriptionError("PayPal did not create a billing plan.", "PAYPAL_ERROR", 502)
    settings.paypal_product_id = product_id
    settings.paypal_plan_id = plan_id
    db.session.commit()
    return plan_id


def _confirm_paypal(user: User, subscription_id: str) -> None:
    subscription_id = (subscription_id or user.paypal_subscription_id or "").strip()
    if not subscription_id:
        raise ValidationError("PayPal did not return a subscription.", "MISSING_SESSION")
    token = _paypal_token(first_secret("paypal_client"), first_secret("paypal_secret"))
    response = requests.get(
        f"{_paypal_base()}/v1/billing/subscriptions/{subscription_id}",
        headers=_paypal_headers(token),
        timeout=HTTP_TIMEOUT,
    )
    if response.status_code >= 400:
        raise SubscriptionError(_paypal_error(response), "PAYPAL_ERROR", 502)
    body = response.json() or {}
    status = (body.get("status") or "").upper()
    custom = str(body.get("custom_id") or "")
    if custom and custom != user.id:
        raise SubscriptionError("That PayPal payment does not belong to this account.", "PAYMENT_MISMATCH", 403)
    if status == "APPROVED":
        activate = requests.post(
            f"{_paypal_base()}/v1/billing/subscriptions/{subscription_id}/activate",
            headers=_paypal_headers(token),
            json={"reason": "Activated in vibeEye"},
            timeout=HTTP_TIMEOUT,
        )
        if activate.status_code < 400:
            status = "ACTIVE"
    if status not in {"ACTIVE", "SUSPENDED"}:
        raise SubscriptionError("That PayPal subscription is not active yet.", "PAYMENT_INCOMPLETE", 400)
    user.plan = "premium"
    user.paypal_subscription_id = subscription_id
    db.session.commit()


def _user_from_stripe_object(obj: dict) -> User | None:
    meta = obj.get("metadata") or {}
    user_id = str(meta.get("user_id") or obj.get("client_reference_id") or "")
    if user_id:
        user = db.session.get(User, user_id)
        if user:
            return user
    customer = str(obj.get("customer") or "")
    if customer:
        return User.query.filter_by(stripe_customer_id=customer).first()
    sub = str(obj.get("subscription") or obj.get("id") or "")
    if sub.startswith("sub_"):
        return User.query.filter_by(stripe_subscription_id=sub).first()
    return None


def _stripe_signature_ok(payload: bytes, header: str, secret: str) -> bool:
    items = {}
    for part in (header or "").split(","):
        if "=" in part:
            key, value = part.split("=", 1)
            items[key.strip()] = value.strip()
    timestamp = items.get("t")
    signature = items.get("v1")
    if not timestamp or not signature:
        return False
    signed = f"{timestamp}.".encode("utf-8") + payload
    expected = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


def _stripe_error(response) -> str:
    try:
        body = response.json() or {}
        return (body.get("error") or {}).get("message") or response.text[:180] or "Stripe request failed."
    except Exception:
        return (response.text or "Stripe request failed.")[:180]


def _paypal_error(response) -> str:
    try:
        body = response.json() or {}
        if body.get("message"):
            return str(body.get("message"))[:180]
        details = body.get("details") or []
        if details:
            return str(details[0].get("description") or details[0])[:180]
        return (response.text or "PayPal request failed.")[:180]
    except Exception:
        return (response.text or "PayPal request failed.")[:180]
