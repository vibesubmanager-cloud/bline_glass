def _register(client):
    response = client.post(
        "/api/auth/register",
        json={
            "name": "Ada",
            "email": "ada@example.com",
            "password": "securepass",
            "phone": "+15551234567",
        },
    )
    token = response.get_json()["data"]["token"]
    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token}"
    return client, response.get_json()["data"]["user"]["id"]


def _login_admin(client):
    response = client.post("/api/admin/login", json={"username": "admin", "password": "AdminSight1!"})
    assert response.status_code == 200
    token = response.get_json()["data"]["token"]
    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token}"
    return client


def test_plans_are_free_until_admin_enables(auth_client):
    listed = auth_client.get("/api/billing/plans")
    assert listed.status_code == 200
    data = listed.get_json()["data"]
    assert data["subscriptions_enabled"] is False
    assert data["can_describe"] is True
    assert data["user_plan"] == "free"
    blocked = auth_client.post("/api/vision/describe")
    assert blocked.status_code != 402


def test_admin_can_toggle_and_edit_subscription(app):
    user_client, _user_id = _register(app.test_client())
    admin_client = _login_admin(app.test_client())

    denied = app.test_client().get("/api/admin/subscription")
    assert denied.status_code == 401

    saved = admin_client.put(
        "/api/admin/subscription",
        json={
            "subscriptions_enabled": True,
            "premium_price_dollars": 5,
            "premium_name": "Premium",
            "free_name": "Free",
            "premium_tagline": "Describe and Read",
        },
    )
    assert saved.status_code == 200
    payload = saved.get_json()["data"]
    assert payload["subscriptions_enabled"] is True
    assert payload["premium_price_cents"] == 500
    assert payload["price_label"] == "$5 / month"

    plans = user_client.get("/api/billing/plans")
    data = plans.get_json()["data"]
    assert data["can_describe"] is False
    assert user_client.post("/api/vision/read").status_code == 402
    assert user_client.post("/api/vision/describe").status_code == 402
    assert user_client.post("/api/vision/question", json={"question": "what is this"}).status_code == 402

    subscribed = user_client.post("/api/billing/subscribe")
    assert subscribed.status_code == 200
    assert subscribed.get_json()["data"]["user_plan"] == "premium"
    assert subscribed.get_json()["data"]["can_describe"] is True
    assert user_client.post("/api/vision/describe").status_code != 402

    cancelled = user_client.post("/api/billing/cancel")
    assert cancelled.get_json()["data"]["user_plan"] == "free"
    assert user_client.post("/api/vision/read").status_code == 402

    off = admin_client.put("/api/admin/subscription", json={"subscriptions_enabled": False})
    assert off.status_code == 200
    assert user_client.get("/api/billing/plans").get_json()["data"]["can_describe"] is True
    assert user_client.post("/api/vision/describe").status_code != 402


def test_admin_can_set_user_plan(app):
    user_client, user_id = _register(app.test_client())
    admin_client = _login_admin(app.test_client())
    admin_client.put("/api/admin/subscription", json={"subscriptions_enabled": True})
    saved = admin_client.put(f"/api/admin/users/{user_id}", json={"plan": "premium"})
    assert saved.status_code == 200
    assert saved.get_json()["data"]["user"]["plan"] == "premium"
    assert user_client.get("/api/billing/plans").get_json()["data"]["can_describe"] is True


def test_update_settings_helpers(app):
    from app.services.subscription_service import get_settings, update_settings

    with app.app_context():
        settings = update_settings({"subscriptions_enabled": True, "premium_price_dollars": 5})
        assert settings.subscriptions_enabled is True
        assert settings.premium_price_cents == 500
        row = get_settings()
        assert row.id == 1


def test_payment_keys_are_masked_and_drive_checkout(app, monkeypatch):
    import json

    user_client, user_id = _register(app.test_client())
    admin_client = _login_admin(app.test_client())
    saved_keys = admin_client.put(
        "/api/admin/payments",
        json={
            "stripe_secret": "sk_test_1234567890abcdef",
            "stripe_publishable": "pk_test_1234567890abcdef",
        },
    )
    assert saved_keys.status_code == 200
    listed = admin_client.get("/api/admin/keys")
    stripe_secret = listed.get_json()["data"]["keys"]["stripe_secret"][0]
    assert stripe_secret["hint"].endswith("cdef")
    assert "sk_test_1234567890" not in json.dumps(listed.get_json())

    admin_client.put(
        "/api/admin/subscription",
        json={"subscriptions_enabled": True, "payment_provider": "stripe", "premium_price_dollars": 5},
    )
    plans = user_client.get("/api/billing/plans").get_json()["data"]
    assert plans["payment_provider"] == "stripe"
    assert plans["payment_ready"] is True

    class FakeResponse:
        def __init__(self, payload, status=200):
            self.status_code = status
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

    def fake_post(url, **_kwargs):
        assert "checkout/sessions" in url
        return FakeResponse({"url": "https://checkout.stripe.com/c/pay_test"})

    def fake_get(url, **_kwargs):
        if url.endswith("/balance"):
            return FakeResponse({"object": "balance"})
        assert "checkout/sessions/" in url
        return FakeResponse(
            {
                "status": "complete",
                "payment_status": "paid",
                "client_reference_id": user_id,
                "customer": "cus_1",
                "subscription": "sub_1",
            }
        )

    monkeypatch.setattr("app.services.payment_service.requests.post", fake_post)
    monkeypatch.setattr("app.services.payment_service.requests.get", fake_get)

    checkout = user_client.post(
        "/api/billing/subscribe",
        json={"return_url": "http://localhost/pages/plans.html"},
    )
    assert checkout.status_code == 200
    body = checkout.get_json()["data"]
    assert body["checkout_url"] == "https://checkout.stripe.com/c/pay_test"
    assert body["provider"] == "stripe"
    assert body["user_plan"] == "free"

    confirmed = user_client.post(
        "/api/billing/confirm",
        json={"provider": "stripe", "session_id": "cs_test_123"},
    )
    assert confirmed.status_code == 200
    assert confirmed.get_json()["data"]["user_plan"] == "premium"


def test_paypal_keys_and_provider(app, monkeypatch):
    user_client, _user_id = _register(app.test_client())
    admin_client = _login_admin(app.test_client())
    admin_client.put(
        "/api/admin/payments",
        json={"paypal_client_id": "paypal-client-id-value", "paypal_secret": "paypal-secret-value-1234"},
    )
    admin_client.put(
        "/api/admin/subscription",
        json={"subscriptions_enabled": True, "payment_provider": "paypal", "paypal_mode": "sandbox"},
    )
    plans = user_client.get("/api/billing/plans").get_json()["data"]
    assert plans["payment_provider"] == "paypal"
    assert plans["payment_ready"] is True
    assert plans["paypal_mode"] == "sandbox"

    import json

    class FakeResponse:
        def __init__(self, payload, status=200):
            self.status_code = status
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

    def fake_post(url, **_kwargs):
        if url.endswith("/v1/oauth2/token"):
            return FakeResponse({"access_token": "token"})
        if url.endswith("/v1/catalogs/products"):
            return FakeResponse({"id": "PROD-1"})
        if url.endswith("/v1/billing/plans"):
            return FakeResponse({"id": "P-PLAN"})
        if url.endswith("/v1/billing/subscriptions"):
            return FakeResponse(
                {
                    "id": "I-SUB",
                    "links": [{"rel": "approve", "href": "https://www.paypal.com/agree?token=1"}],
                }
            )
        return FakeResponse({}, 404)

    monkeypatch.setattr("app.services.payment_service.requests.post", fake_post)
    started = user_client.post(
        "/api/billing/subscribe",
        json={"return_url": "http://localhost/pages/plans.html"},
    )
    assert started.status_code == 200
    assert "paypal.com" in started.get_json()["data"]["checkout_url"]

