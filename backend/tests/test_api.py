import io

from PIL import Image

from app.services.yolo_service import Detection, ObjectDetector, YOLOService


class FakeDetector(ObjectDetector):
    def detect(self, image, confidence=0.35):
        return [Detection(label="person", confidence=0.94, bbox=[10, 10, 50, 80], position="center")]


def test_contacts_crud(auth_client):
    created = auth_client.post(
        "/api/contacts",
        json={"name": "John", "phone": "+15557654321", "relationship": "brother", "is_emergency_contact": True},
    )
    assert created.status_code == 201
    contact_id = created.get_json()["data"]["contact"]["id"]

    listed = auth_client.get("/api/contacts")
    assert listed.get_json()["data"]["contacts"][0]["name"] == "John"

    updated = auth_client.put(f"/api/contacts/{contact_id}", json={"name": "Jonathan"})
    assert updated.get_json()["data"]["contact"]["name"] == "Jonathan"

    deleted = auth_client.delete(f"/api/contacts/{contact_id}")
    assert deleted.status_code == 200


def test_detection_route_with_fake_detector(app, auth_client, monkeypatch):
    service = YOLOService(detector=FakeDetector())
    monkeypatch.setattr("app.routes.detection.get_yolo_service", lambda: service)
    image = Image.new("RGB", (64, 64), color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG")
    buffer.seek(0)
    response = auth_client.post(
        "/api/detection",
        data={"image": (buffer, "frame.jpg")},
        content_type="multipart/form-data",
    )
    assert response.status_code == 200
    body = response.get_json()
    assert body["success"] is True
    assert body["data"]["count"] == 1
    assert "person" in body["data"]["spoken"]
    assert "0.94" not in body["data"]["spoken"]


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.get_json()["data"]["status"] == "ok"
    assert "groq_configured" in response.get_json()["data"]
    assert "gemini_configured" in response.get_json()["data"]


def test_groq_key_probe(auth_client):
    response = auth_client.post("/api/health/groq", json={"text": "How are you doing?"})
    assert response.status_code == 200
    payload = response.get_json()["data"]
    assert payload["ok"] is False
    assert "missing" in payload["reply"].lower()


def test_gemini_key_probe_needs_photo(auth_client):
    response = auth_client.post("/api/health/gemini")
    assert response.status_code == 400


def test_intent_parse_endpoint(auth_client):
    response = auth_client.post("/api/intent/parse", json={"text": "Read this"})
    assert response.get_json()["data"]["intent"] == "READ"


def test_intent_calling_settings(auth_client):
    response = auth_client.post("/api/intent/parse", json={"text": "Open calling settings"})
    assert response.get_json()["data"]["intent"] == "CALLING_SETTINGS"


def test_calling_configured_setting(auth_client):
    saved = auth_client.put("/api/auth/settings", json={"calling_configured": True})
    assert saved.status_code == 200
    assert saved.get_json()["data"]["settings"]["calling_configured"] is True
    me = auth_client.get("/api/auth/me")
    assert me.get_json()["data"]["settings"]["calling_configured"] is True


def test_emergency_without_contacts(auth_client):
    response = auth_client.post("/api/emergency/activate", json={})
    assert response.status_code == 400
    assert response.get_json()["error"]["code"] == "NO_EMERGENCY_CONTACT"


def test_share_location_to_brother(auth_client):
    auth_client.post(
        "/api/contacts",
        json={"name": "Ravi", "phone": "5551234567", "relationship": "brother", "is_emergency_contact": True},
    )
    response = auth_client.post(
        "/api/contacts/share-location",
        json={"target": "my brother", "latitude": 28.47, "longitude": 77.48, "destination": "Jagat Farm"},
    )
    assert response.status_code == 200
    payload = response.get_json()["data"]
    assert payload["contact"]["name"] == "Ravi"
    assert "Jagat Farm" in payload["message"]
    assert "maps.google.com" in payload["maps_url"]


def test_share_location_unknown_name_goes_to_all(auth_client):
    auth_client.post(
        "/api/contacts",
        json={"name": "Ravi", "phone": "5551234567", "relationship": "brother", "is_emergency_contact": True},
    )
    auth_client.post(
        "/api/contacts",
        json={"name": "Priya", "phone": "5559876543", "relationship": "sister"},
    )
    response = auth_client.post(
        "/api/contacts/share-location",
        json={"target": "somebody", "latitude": 28.47, "longitude": 77.48},
    )
    assert response.status_code == 200
    payload = response.get_json()["data"]
    assert len(payload["contacts"]) == 2
    assert "Ravi" in payload["spoken"]
    assert "Priya" in payload["spoken"]
    assert "I have sent your location" in payload["spoken"]


def test_navigation_search_without_key_uses_osm(auth_client, monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return [{"display_name": "Sharda University, Greater Noida", "lat": "28.473", "lon": "77.482", "type": "university"}]

    monkeypatch.setattr("app.services.navigation_service.requests.get", lambda *args, **kwargs: FakeResponse())
    response = auth_client.post("/api/navigation/search", json={"query": "Sharda University"})
    assert response.status_code == 200
    payload = response.get_json()["data"]
    assert payload["results"][0]["name"].startswith("Sharda University")


def test_call_unknown_contact(auth_client):
    response = auth_client.post("/api/calls/start", json={"target": "Nobody"})
    assert response.status_code == 404


def test_call_jitsi_unique_rooms_without_api_key(client):
    first = client.post(
        "/api/auth/register",
        json={"name": "Ada", "email": "ada-call@example.com", "password": "securepass", "phone": "+15551110001"},
    )
    second = client.post(
        "/api/auth/register",
        json={"name": "Ben", "email": "ben-call@example.com", "password": "securepass", "phone": "+15551110002"},
    )
    token_a = first.get_json()["data"]["token"]
    token_b = second.get_json()["data"]["token"]
    user_b = second.get_json()["data"]["user"]["id"]

    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token_a}"
    created = client.post(
        "/api/contacts",
        json={"name": "Ben", "phone": "+15551110002", "relationship": "brother"},
    )
    assert created.status_code == 201

    started = client.post("/api/calls/start", json={"target": "Ben", "media": "video"})
    assert started.status_code == 200
    payload = started.get_json()["data"]
    call = payload["call"]
    jitsi = payload["jitsi"]
    blob = str(payload)
    assert call["call_type"] == "video"
    assert call["callee_id"] == user_b
    assert jitsi["domain"] == "meet.jit.si"
    assert jitsi["room"].startswith("aidobot-call-")
    assert jitsi["room"] != "aidobot"
    assert len(jitsi["room"]) > 20
    assert jitsi["video"] is True
    assert "daily" not in payload
    assert "token" not in (jitsi or {})
    assert "api_key" not in blob.lower()

    second_call = client.post("/api/calls/start", json={"target": "Ben", "media": "audio"})
    other_room = second_call.get_json()["data"]["jitsi"]["room"]
    assert other_room.startswith("aidobot-call-")
    assert other_room != jitsi["room"]

    client.post(
        "/api/calls/signal",
        json={
            "target_user_id": user_b,
            "call_id": call["id"],
            "signal_type": "ring",
            "media": "video",
        },
    )

    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token_b}"
    polled = client.get("/api/calls/poll")
    signals = polled.get_json()["data"]["signals"]
    assert any(item.get("signal_type") == "ring" for item in signals)
    assert all("token" not in (item or {}) for item in signals)
    assert all("jitsi" not in (item or {}) for item in signals)

    accepted = client.post("/api/calls/accept", json={"call_id": call["id"]})
    assert accepted.status_code == 200
    callee_jitsi = accepted.get_json()["data"]["jitsi"]
    assert callee_jitsi["room"] == jitsi["room"]
    assert callee_jitsi["domain"] == "meet.jit.si"

