from app.services.response_engine import speak_detections, speak_read_result, format_distance


def test_speak_detections_natural_language():
    spoken = speak_detections(
        [
            {"label": "person", "confidence": 0.94, "position": "center"},
            {"label": "bicycle", "confidence": 0.89, "position": "right"},
            {"label": "car", "confidence": 0.92, "position": "left"},
        ]
    )
    assert "0.94" not in spoken
    assert "person" in spoken
    assert "bicycle" in spoken
    assert "car" in spoken


def test_speak_detections_empty():
    assert "do not see" in speak_detections([])


def test_query_object_missing():
    spoken = speak_detections([{"label": "chair", "confidence": 0.9, "position": "center"}], query_object="car")
    assert "do not see car" in spoken


def test_speak_detections_combines_counts():
    spoken = speak_detections(
        [
            {"label": "bottle", "confidence": 0.9, "position": "left"},
            {"label": "bottle", "confidence": 0.8, "position": "right"},
            {"label": "chair", "confidence": 0.9, "position": "center"},
            {"label": "chair", "confidence": 0.7, "position": "left"},
        ]
    )
    assert spoken == "You see two bottles and two chairs."


def test_read_empty():
    assert "could not read" in speak_read_result("")


def test_distance_format():
    assert "150 meters" in format_distance(150)
