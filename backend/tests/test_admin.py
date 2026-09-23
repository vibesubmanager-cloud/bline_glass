def _login_admin(client):
    response = client.post("/api/admin/login", json={"username": "admin", "password": "AdminSight1!"})
    assert response.status_code == 200
    token = response.get_json()["data"]["token"]
    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token}"
    return client


def test_admin_page_is_separate(client):
    page = client.get("/admin", follow_redirects=True)
    assert page.status_code == 200
    html = page.get_data(as_text=True)
    assert "admin.css" in html
    assert "admin.js" in html
    assert "main.css" not in html
    login = client.get("/pages/admin-login.html")
    assert login.status_code == 200
    assert "admin.css" in login.get_data(as_text=True)


def test_admin_login_and_users(client):
    denied = client.get("/api/admin/users")
    assert denied.status_code == 401

    bad = client.post("/api/admin/login", json={"username": "admin", "password": "wrongpass"})
    assert bad.status_code == 401

    _login_admin(client)
    users = client.get("/api/admin/users")
    assert users.status_code == 200
    assert users.get_json()["success"] is True


def test_phone_login_rejects_admin(client):
    response = client.post("/api/auth/login", json={"username": "admin", "password": "AdminSight1!"})
    assert response.status_code == 403


def test_regular_user_cannot_use_admin(auth_client):
    response = auth_client.get("/api/admin/users")
    assert response.status_code == 403


def test_admin_can_view_and_update_user(client):
    created = client.post(
        "/api/auth/register",
        json={"name": "Ada", "email": "ada-admin@example.com", "password": "securepass"},
    )
    user_id = created.get_json()["data"]["user"]["id"]
    _login_admin(client)
    detail = client.get(f"/api/admin/users/{user_id}")
    assert detail.status_code == 200
    payload = detail.get_json()["data"]
    assert payload["user"]["email"] == "ada-admin@example.com"
    saved = client.put(
        f"/api/admin/users/{user_id}",
        json={"username": "ada_sight", "password": "newpass12"},
    )
    assert saved.status_code == 200
    assert saved.get_json()["data"]["user"]["username"] == "ada_sight"

    phone = client.post("/api/auth/login", json={"username": "ada_sight", "password": "newpass12"})
    assert phone.status_code == 200


def test_admin_sees_messages(client):
    blind = client.post(
        "/api/auth/register",
        json={"name": "Bea", "email": "bea@example.com", "password": "securepass"},
    ).get_json()["data"]["user"]
    helper = client.post(
        "/api/auth/register",
        json={
            "role": "assistant",
            "name": "Carl",
            "email": "carl@example.com",
            "password": "securepass",
            "system_id": blind["system_id"],
            "relationship": "brother",
        },
    ).get_json()["data"]
    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {helper['token']}"
    sent = client.post(
        "/api/messages/send",
        json={"recipient_id": blind["id"], "type": "text", "body": "Are you safe?"},
    )
    assert sent.status_code in {200, 201}
    _login_admin(client)
    thread = client.get(f"/api/admin/users/{blind['id']}/messages?with={helper['user']['id']}")
    assert thread.status_code == 200
    bodies = [item["body"] for item in thread.get_json()["data"]["messages"]]
    assert "Are you safe?" in bodies


def test_admin_api_keys_are_masked(client):
    _login_admin(client)
    created = client.post(
        "/api/admin/keys",
        json={"provider": "gemini", "label": "Vision 1", "key": "AIzaSyFAKESECRETKEYVALUE1234"},
    )
    assert created.status_code == 201
    item = created.get_json()["data"]["key"]
    assert item["hint"].endswith("1234")
    assert "AIza" not in item["hint"]
    listed = client.get("/api/admin/keys")
    keys = listed.get_json()["data"]["keys"]["gemini"]
    assert keys[0]["label"] == "Vision 1"
    assert "key_value" not in keys[0]


def test_admin_daily_key_is_masked(client):
    _login_admin(client)
    created = client.post(
        "/api/admin/keys",
        json={"provider": "daily", "label": "Daily 1", "key": "daily-test-secret-key-value-1234"},
    )
    assert created.status_code == 201
    item = created.get_json()["data"]["key"]
    assert item["hint"].endswith("1234")
    assert "daily-test-secret" not in item["hint"]
    listed = client.get("/api/admin/keys")
    keys = listed.get_json()["data"]["keys"]["daily"]
    assert keys[0]["label"] == "Daily 1"
    assert "key_value" not in keys[0]


def test_gemini_test_needs_photo(client):
    _login_admin(client)
    created = client.post(
        "/api/admin/keys",
        json={"provider": "gemini", "label": "Vision 1", "key": "AIzaSyFAKESECRETKEYVALUE1234"},
    )
    key_id = created.get_json()["data"]["key"]["id"]
    result = client.post(f"/api/admin/keys/{key_id}/test", json={})
    assert result.status_code == 200
    payload = result.get_json()["data"]
    assert payload["ok"] is False
    assert payload["needs_photo"] is True


def test_admin_test_section_is_on_page(client):
    page = client.get("/pages/admin.html")
    html = page.get_data(as_text=True)
    assert "section-test" in html
    assert "gemini-test-form" in html
    assert "Daily calling key" in html
    assert "text-test-form" in html
