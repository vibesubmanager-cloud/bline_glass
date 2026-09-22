from app.utils.validation import ValidationError, validate_email, validate_password, validate_lat_lng


def test_email_validation():
    assert validate_email("Ada@Example.COM") == "ada@example.com"
    try:
        validate_email("not-an-email")
        assert False
    except ValidationError:
        pass


def test_password_min_length():
    try:
        validate_password("short")
        assert False
    except ValidationError:
        pass


def test_coordinates():
    lat, lng = validate_lat_lng("28.45", "77.48")
    assert round(lat, 2) == 28.45
    try:
        validate_lat_lng("999", "0")
        assert False
    except ValidationError:
        pass
