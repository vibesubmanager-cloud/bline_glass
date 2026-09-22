def test_register_and_login(client):
    register = client.post(
        "/api/auth/register",
        json={"name": "Ada", "email": "ada@example.com", "password": "securepass"},
    )
    assert register.status_code == 201
    assert register.get_json()["success"] is True
    assert "token" in register.get_json()["data"]

    bad = client.post(
        "/api/auth/login",
        json={"email": "ada@example.com", "password": "wrongpass"},
    )
    assert bad.status_code == 401

    ok = client.post(
        "/api/auth/login",
        json={"email": "ada@example.com", "password": "securepass"},
    )
    assert ok.status_code == 200
    assert ok.get_json()["data"]["user"]["email"] == "ada@example.com"


def test_password_not_returned(client):
    response = client.post(
        "/api/auth/register",
        json={"name": "Ada", "email": "ada2@example.com", "password": "securepass"},
    )
    payload = response.get_json()["data"]["user"]
    assert "password" not in payload
    assert "password_hash" not in payload


def test_protected_route_requires_auth(client):
    response = client.get("/api/contacts")
    assert response.status_code == 401


def test_me_and_logout(auth_client):
    me = auth_client.get("/api/auth/me")
    assert me.status_code == 200
    payload = me.get_json()["data"]["user"]
    assert payload["name"] == "Ada"
    assert payload["role"] == "blind"
    assert payload["system_id"]
    logout = auth_client.post("/api/auth/logout")
    assert logout.status_code == 200


def test_login_with_username(client):
    register = client.post(
        "/api/auth/register",
        json={
            "first_name": "Priya",
            "last_name": "Shah",
            "username": "priya",
            "email": "priya@example.com",
            "password": "securepass",
            "phone": "+15557654321",
            "health_notes": "Low vision",
            "emergency_contacts": [{"name": "Brother", "phone": "+15550001111", "relationship": "brother"}],
        },
    )
    assert register.status_code == 201
    user = register.get_json()["data"]["user"]
    assert user["username"] == "priya"
    assert user["system_id"].startswith("AIS-")

    ok = client.post("/api/auth/login", json={"username": "priya", "password": "securepass"})
    assert ok.status_code == 200
    assert ok.get_json()["data"]["user"]["username"] == "priya"


def test_assistant_lookup_and_register(client):
    blind = client.post(
        "/api/auth/register",
        json={"name": "Ada", "email": "ada-blind@example.com", "password": "securepass"},
    ).get_json()["data"]["user"]
    lookup = client.get(f"/api/auth/lookup-id?system_id={blind['system_id']}")
    assert lookup.status_code == 200
    assert lookup.get_json()["data"]["profile"]["name"] == "Ada"

    missing = client.get("/api/auth/lookup-id?system_id=AIS-NOPE01")
    assert missing.status_code == 404

    assistant = client.post(
        "/api/auth/register",
        json={
            "role": "assistant",
            "first_name": "John",
            "last_name": "Doe",
            "username": "johnhelp",
            "email": "john@example.com",
            "password": "securepass",
            "system_id": blind["system_id"],
            "relationship": "son",
        },
    )
    assert assistant.status_code == 201
    data = assistant.get_json()["data"]
    assert data["user"]["role"] == "assistant"
    assert data["linked_blind"]["name"] == "Ada"

    token = data["token"]
    contacts = client.get("/api/contacts", headers={"Authorization": f"Bearer {token}"})
    names = [item["name"] for item in contacts.get_json()["data"]["contacts"]]
    assert "Ada" in names

    blind_token = client.post(
        "/api/auth/login",
        json={"email": "ada-blind@example.com", "password": "securepass"},
    ).get_json()["data"]["token"]
    blind_headers = {"Authorization": f"Bearer {blind_token}"}
    listed = client.get("/api/contacts", headers=blind_headers).get_json()["data"]["contacts"]
    assistant_contact = next(item for item in listed if item["name"] == "John Doe")
    assert assistant_contact["readonly"] is True
    blocked = client.delete(f"/api/contacts/{assistant_contact['id']}", headers=blind_headers)
    assert blocked.status_code == 400

    from app.extensions import db
    from app.models.contact import Contact

    with client.application.app_context():
        row = db.session.get(Contact, assistant_contact["id"])
        db.session.delete(row)
        db.session.commit()
    restored = client.get("/api/contacts", headers=blind_headers).get_json()["data"]["contacts"]
    assert any(item["name"] == "John Doe" for item in restored)


def test_blind_user_can_add_assistant_from_contacts(auth_client, client):
    created = auth_client.post(
        "/api/contacts/assistants",
        json={
            "first_name": "Sara",
            "last_name": "Khan",
            "username": "sarakhan",
            "email": "sara@example.com",
            "phone": "+15550009999",
            "password": "securepass",
            "relationship": "daughter",
        },
    )
    assert created.status_code == 201
    listed = auth_client.get("/api/contacts").get_json()["data"]["contacts"]
    assert any(item["name"] == "Sara Khan" for item in listed)

    login = client.post("/api/auth/login", json={"username": "sarakhan", "password": "securepass"})
    assert login.status_code == 200
    data = login.get_json()["data"]
    assert data["user"]["role"] == "assistant"
    assert data["linked_blind"]["name"] == "Ada"
