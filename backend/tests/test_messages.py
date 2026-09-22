from io import BytesIO

from PIL import Image


def _register_pair(client):
    blind = client.post(
        "/api/auth/register",
        json={"name": "Ada", "email": "ada-chat@example.com", "password": "securepass"},
    )
    assert blind.status_code == 201
    blind_data = blind.get_json()["data"]
    assistant = client.post(
        "/api/auth/register",
        json={
            "role": "assistant",
            "first_name": "John",
            "last_name": "Doe",
            "username": "johnchat",
            "email": "john-chat@example.com",
            "password": "securepass",
            "system_id": blind_data["user"]["system_id"],
            "relationship": "son",
        },
    )
    assert assistant.status_code == 201
    return blind_data, assistant.get_json()["data"]


def test_send_and_read_chat(client):
    blind, assistant = _register_pair(client)
    headers = {"Authorization": f"Bearer {blind['token']}"}
    sent = client.post(
        "/api/messages/send",
        json={"target": "John", "type": "text", "body": "I am at the market"},
        headers=headers,
    )
    assert sent.status_code == 201
    spoken = sent.get_json()["data"]["spoken"]
    assert "John" in spoken
    assert "I have sent your message" in spoken

    assistant_headers = {"Authorization": f"Bearer {assistant['token']}"}
    unread = client.get("/api/messages/unread", headers=assistant_headers)
    assert unread.status_code == 200
    items = unread.get_json()["data"]["messages"]
    assert items[0]["from_name"] == "Ada"
    assert "market" in items[0]["message"]["body"]

    thread = client.get(f"/api/messages?with={blind['user']['id']}", headers=assistant_headers)
    assert thread.status_code == 200
    assert thread.get_json()["data"]["messages"][0]["body"] == "I am at the market"


def test_send_photo_and_location(client):
    blind, assistant = _register_pair(client)
    headers = {"Authorization": f"Bearer {blind['token']}"}
    image = Image.new("RGB", (32, 32), color="white")
    buffer = BytesIO()
    image.save(buffer, format="JPEG")
    buffer.seek(0)
    photo = client.post(
        "/api/messages",
        data={"target": "son", "type": "image", "file": (buffer, "scene.jpg")},
        content_type="multipart/form-data",
        headers=headers,
    )
    assert photo.status_code == 201
    assert "I have sent the picture" in photo.get_json()["data"]["spoken"]
    message_id = photo.get_json()["data"]["message"]["id"]

    assistant_headers = {"Authorization": f"Bearer {assistant['token']}"}
    media = client.get(f"/api/messages/media/{message_id}", headers=assistant_headers)
    assert media.status_code == 200

    location = client.post(
        "/api/messages",
        json={"target": "John", "type": "location", "latitude": 28.6, "longitude": 77.2},
        headers=headers,
    )
    assert location.status_code == 201
    assert location.get_json()["data"]["message"]["maps_url"]
    assert "I have sent your location" in location.get_json()["data"]["spoken"]


def test_unlinked_contact_cannot_chat(auth_client):
    auth_client.post(
        "/api/contacts",
        json={"name": "Neighbor", "phone": "+15550000000", "relationship": "friend"},
    )
    blocked = auth_client.post(
        "/api/messages",
        json={"target": "Neighbor", "type": "text", "body": "Hello"},
    )
    assert blocked.status_code == 404


def test_unknown_name_sends_to_all_contacts(client):
    blind, son = _register_pair(client)
    sister = client.post(
        "/api/auth/register",
        json={
            "role": "assistant",
            "first_name": "Maya",
            "last_name": "Doe",
            "username": "mayachat",
            "email": "maya-chat@example.com",
            "password": "securepass",
            "system_id": blind["user"]["system_id"],
            "relationship": "sister",
        },
    )
    assert sister.status_code == 201
    headers = {"Authorization": f"Bearer {blind['token']}"}
    sent = client.post(
        "/api/messages/send",
        json={"target": "neighbor", "type": "text", "body": "I need help"},
        headers=headers,
    )
    assert sent.status_code == 201
    spoken = sent.get_json()["data"]["spoken"]
    assert "John" in spoken
    assert "Maya" in spoken

    for token in (son["token"], sister.get_json()["data"]["token"]):
        unread = client.get("/api/messages/unread", headers={"Authorization": f"Bearer {token}"})
        assert unread.status_code == 200
        items = unread.get_json()["data"]["messages"]
        assert items
        assert "help" in items[0]["message"]["body"]


def test_named_contact_still_sends_to_one_person(client):
    blind, son = _register_pair(client)
    client.post(
        "/api/auth/register",
        json={
            "role": "assistant",
            "first_name": "Maya",
            "last_name": "Doe",
            "username": "mayachat2",
            "email": "maya-chat2@example.com",
            "password": "securepass",
            "system_id": blind["user"]["system_id"],
            "relationship": "sister",
        },
    )
    headers = {"Authorization": f"Bearer {blind['token']}"}
    sent = client.post(
        "/api/messages/send",
        json={"target": "son", "type": "text", "body": "Only for John"},
        headers=headers,
    )
    assert sent.status_code == 201
    spoken = sent.get_json()["data"]["spoken"]
    assert "John" in spoken
    assert "all of your contacts" not in spoken
