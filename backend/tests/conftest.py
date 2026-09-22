import pytest

from app import create_app
from app.config import TestConfig
from app.extensions import db


@pytest.fixture()
def app():
    application = create_app(TestConfig)
    yield application
    with application.app_context():
        db.drop_all()


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def auth_client(client):
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
    return client
