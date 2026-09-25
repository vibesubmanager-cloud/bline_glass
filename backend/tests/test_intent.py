from app.services.intent_service import parse_intent, understand_command


def test_emergency_intent():
    parsed = parse_intent("Emergency")
    assert parsed["intent"] == "EMERGENCY"


def test_navigation_slot():
    parsed = parse_intent("Take me to Sharda University")
    assert parsed["intent"] == "NAVIGATE"
    assert parsed["slots"]["destination"] == "Sharda University"


def test_send_location_intent():
    parsed = parse_intent("Can you send this location to my brother")
    assert parsed["intent"] == "SEND_LOCATION"
    assert "brother" in parsed["slots"]["target"]


def test_send_the_location_to_brother():
    parsed = parse_intent("send the location to my brother please")
    assert parsed["intent"] == "SEND_LOCATION"
    assert parsed["slots"]["target"] == "brother"


def test_send_map_without_name_goes_to_all():
    parsed = parse_intent("send this map to somebody")
    assert parsed["intent"] == "SEND_LOCATION"
    assert "target" not in parsed["slots"]


def test_send_picture_without_name():
    parsed = parse_intent("send a picture")
    assert parsed["intent"] == "SEND_PHOTO"
    assert "target" not in parsed["slots"]


def test_photo_keyword_sends_photo():
    parsed = parse_intent("photo")
    assert parsed["intent"] == "SEND_PHOTO"


def test_front_of_me_is_describe():
    parsed = parse_intent("What is in front of me?")
    assert parsed["intent"] == "DESCRIBE"


def test_can_you_describe_in_front():
    parsed = parse_intent("Can you describe what is in front of me?")
    assert parsed["intent"] == "DESCRIBE"


def test_i_cant_see_in_front():
    parsed = parse_intent("I can't see what is in front of me")
    assert parsed["intent"] == "DESCRIBE"


def test_describe_the_view():
    parsed = parse_intent("please describe the view")
    assert parsed["intent"] == "DESCRIBE"


def test_read():
    parsed = parse_intent("Read this")
    assert parsed["intent"] == "READ"


def test_read_this_for_me():
    parsed = parse_intent("Can you read this for me")
    assert parsed["intent"] == "READ"


def test_describe():
    parsed = parse_intent("What do you see?")
    assert parsed["intent"] == "DESCRIBE"


def test_send_message_intent():
    parsed = parse_intent("Send a message to my brother I want to eat")
    assert parsed["intent"] == "SEND_MESSAGE"
    assert parsed["slots"]["target"] == "brother"
    assert "eat" in parsed["slots"]["body"]


def test_message_keyword_sends_rest_as_body():
    parsed = parse_intent("send a message I am okay")
    assert parsed["intent"] == "SEND_MESSAGE"
    assert parsed["slots"]["body"].lower() == "i am okay"
    assert "target" not in parsed["slots"]


def test_send_photo_intent():
    parsed = parse_intent("Picture this place and send it to my son")
    assert parsed["intent"] == "SEND_PHOTO"
    assert "son" in parsed["slots"]["target"]


def test_want_to_send_voice_note():
    parsed = parse_intent("I want to send a voice note")
    assert parsed["intent"] == "SEND_VOICE_NOTE"


def test_want_you_to_send_a_message():
    parsed = parse_intent("I want you to send a message")
    assert parsed["intent"] == "SEND_MESSAGE"
    assert "target" not in parsed["slots"]


def test_delete_contact_intent():
    parsed = parse_intent("Delete my brother")
    assert parsed["intent"] == "DELETE_CONTACT"
    assert "brother" in parsed["slots"]["target"]


def test_unknown():
    parsed = parse_intent("hello there")
    assert parsed["intent"] == "UNKNOWN"


def test_natural_take_image_and_send():
    parsed = parse_intent("I want to take an image and send it to anyone in my contact")
    assert parsed["intent"] == "SEND_PHOTO"


def test_keywords_not_groq(app):
    with app.app_context():
        parsed = understand_command("send this picture")
    assert parsed["intent"] == "SEND_PHOTO"
    assert parsed["source"] == "rules"


def test_tell_me_what_is_there_describes(app):
    with app.app_context():
        parsed = understand_command("tell me what is there")
    assert parsed["intent"] == "DESCRIBE"
    assert parsed["source"] == "rules"


def test_send_photo_to_contacts_is_broadcast(app):
    with app.app_context():
        parsed = understand_command("I want to take an image and send it to anyone in my contact")
    assert parsed["intent"] == "SEND_PHOTO"
    assert parsed["slots"].get("broadcast") is True
    assert parsed["source"] == "rules"


def test_hello_is_instant_small_talk(app):
    with app.app_context():
        parsed = understand_command("hello, how are you doing?")
    assert parsed["intent"] == "REPLY"
    assert "doing good" in parsed["spoken"].lower()


def test_message_how_are_you_is_not_small_talk(app):
    with app.app_context():
        parsed = understand_command("send a message how are you doing")
    assert parsed["intent"] == "SEND_MESSAGE"
    assert "how are you" in parsed["slots"]["body"].lower()


def test_my_contacts_is_broadcast():
    from types import SimpleNamespace

    from app.services.share_location_service import find_matching_contact, is_broadcast_target

    assert is_broadcast_target("my contacts")
    assert is_broadcast_target("contacts")
    assert is_broadcast_target("anyone in my contact")
    people = [
        SimpleNamespace(name="John Doe", relationship="son"),
        SimpleNamespace(name="Con", relationship="friend"),
    ]
    assert find_matching_contact(people, "my contacts") is None
    assert find_matching_contact(people, "contacts") is None
    assert find_matching_contact(people, "John").name == "John Doe"


def test_describe_in_front_of_you():
    parsed = parse_intent("What do you see in front of you right now?")
    assert parsed["intent"] == "DESCRIBE"


def test_describe_what_you_see_right_now():
    parsed = parse_intent("Describe what you see right now")
    assert parsed["intent"] == "DESCRIBE"


def test_read_what_you_see_is_describe():
    parsed = parse_intent("Can you read what you see in front of you right now?")
    assert parsed["intent"] == "DESCRIBE"


def test_sos_is_full_emergency():
    assert parse_intent("SOS")["intent"] == "EMERGENCY"
    assert parse_intent("emergency")["intent"] == "EMERGENCY"


def test_emergency_send_message():
    parsed = parse_intent("emergency send a message I fell")
    assert parsed["intent"] == "EMERGENCY_SEND_MESSAGE"


def test_emergency_send_photo():
    assert parse_intent("emergency send a photo")["intent"] == "EMERGENCY_SEND_PHOTO"


def test_emergency_send_map():
    assert parse_intent("emergency send a map")["intent"] == "EMERGENCY_SEND_LOCATION"
