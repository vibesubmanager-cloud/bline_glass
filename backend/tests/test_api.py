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


def test_call_http_signaling_and_media_mailbox(client):
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
    call = started.get_json()["data"]["call"]
    ice = started.get_json()["data"]["ice_servers"]
    assert call["call_type"] == "video"
    assert call["callee_id"] == user_b
    assert any(str(item.get("urls", "")).startswith("stun:") for item in ice)
    assert not any("openrelay" in str(item.get("urls", "")).lower() for item in ice)

    offer = client.post(
        "/api/calls/signal",
        json={
            "target_user_id": user_b,
            "call_id": call["id"],
            "signal_type": "offer",
            "media": "video",
            "payload": {"type": "offer", "sdp": "v=0"},
        },
    )
    assert offer.status_code == 200

    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token_b}"
    polled = client.get("/api/calls/poll")
    signals = polled.get_json()["data"]["signals"]
    assert any(item.get("signal_type") == "offer" for item in signals)

    answer = client.post(
        "/api/calls/signal",
        json={
            "target_user_id": first.get_json()["data"]["user"]["id"],
            "call_id": call["id"],
            "signal_type": "answer",
            "media": "video",
            "payload": {"type": "answer", "sdp": "v=0"},
        },
    )
    assert answer.status_code == 200

    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token_a}"
    caller_poll = client.get("/api/calls/poll")
    assert any(item.get("signal_type") == "answer" for item in caller_poll.get_json()["data"]["signals"])

    posted = client.post("/api/calls/media", json={"call_id": call["id"], "kind": "video", "data": "abc123"})
    assert posted.status_code == 200
    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token_b}"
    taken = client.get(f"/api/calls/media?call_id={call['id']}")
    assert taken.get_json()["data"]["video"] == "abc123"

