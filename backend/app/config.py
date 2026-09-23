"""Application configuration loaded exclusively from environment variables."""

from __future__ import annotations

import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

_BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(_BACKEND_DIR / ".env")
load_dotenv()


def _split_origins(value: str) -> list[str]:
    return [item.strip().rstrip("/") for item in value.split(",") if item.strip()]


class Config:
    SECRET_KEY = os.getenv("SECRET_KEY", "dev-only-change-me")
    FLASK_ENV = os.getenv("FLASK_ENV", "production")
    DEBUG = FLASK_ENV == "development"

    raw_db = os.getenv("DATABASE_URL", "sqlite:///vibe_eye.db")
    if raw_db.startswith("postgres://"):
        raw_db = raw_db.replace("postgres://", "postgresql://", 1)
    raw_db = raw_db.replace("&channel_binding=require", "").replace("channel_binding=require&", "")
    raw_db = raw_db.replace("channel_binding=require", "")
    if raw_db.endswith("?") or raw_db.endswith("&"):
        raw_db = raw_db[:-1]
    if raw_db.startswith("postgresql") and "sslmode=" not in raw_db:
        joiner = "&" if "?" in raw_db else "?"
        raw_db = f"{raw_db}{joiner}sslmode=require"
    SQLALCHEMY_DATABASE_URI = raw_db
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_ENGINE_OPTIONS = {
        "pool_pre_ping": True,
        "pool_recycle": 280,
        "pool_timeout": 30,
    }
    if SQLALCHEMY_DATABASE_URI.startswith("postgresql"):
        SQLALCHEMY_ENGINE_OPTIONS["connect_args"] = {"connect_timeout": 15, "sslmode": "require"}

    FRONTEND_ORIGINS = _split_origins(
        os.getenv(
            "FRONTEND_ORIGINS",
            "http://localhost:5500,http://127.0.0.1:5500,http://localhost:8080",
        )
    )

    GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
    GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")
    GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
    GROQ_MODEL = os.getenv("GROQ_MODEL", "qwen/qwen3.8-27b")
    ADMIN_USERNAME = os.getenv("ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

    CLOUDINARY_CLOUD_NAME = os.getenv("CLOUDINARY_CLOUD_NAME", "")
    CLOUDINARY_API_KEY = os.getenv("CLOUDINARY_API_KEY", "")
    CLOUDINARY_API_SECRET = os.getenv("CLOUDINARY_API_SECRET", "")

    MAPS_PROVIDER = os.getenv("MAPS_PROVIDER", "osm")
    MAPS_API_KEY = os.getenv("MAPS_API_KEY", "")

    YOLO_MODEL = os.getenv("YOLO_MODEL", "yolov8n.pt")
    YOLO_CONFIDENCE = float(os.getenv("YOLO_CONFIDENCE", "0.35"))

    TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
    TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
    TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "")

    SMTP_HOST = os.getenv("SMTP_HOST", "")
    SMTP_PORT = int(os.getenv("SMTP_PORT") or 587)
    SMTP_USER = os.getenv("SMTP_USER", "")
    SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
    SMTP_FROM = os.getenv("SMTP_FROM", "")

    JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", SECRET_KEY)
    JWT_EXPIRES = timedelta(hours=int(os.getenv("JWT_EXPIRES_HOURS", "24")))

    TURN_URL = os.getenv("TURN_URL", "")
    TURN_USERNAME = os.getenv("TURN_USERNAME", "")
    TURN_PASSWORD = os.getenv("TURN_PASSWORD", "")
    DAILY_API_KEY = os.getenv("DAILY_API_KEY", "")

    MAX_CONTENT_LENGTH = 6 * 1024 * 1024
    REQUEST_TIMEOUT_SECONDS = int(os.getenv("REQUEST_TIMEOUT_SECONDS", "30"))

    @property
    def is_production(self) -> bool:
        return self.FLASK_ENV == "production"


class TestConfig(Config):
    FLASK_ENV = "testing"
    TESTING = True
    SQLALCHEMY_DATABASE_URI = "sqlite://"
    SECRET_KEY = "test-secret"
    JWT_SECRET_KEY = "test-secret"
    FRONTEND_ORIGINS = ["http://localhost"]
    GEMINI_API_KEY = ""
    GROQ_API_KEY = ""
    MAPS_API_KEY = ""
    ADMIN_USERNAME = "admin"
    ADMIN_PASSWORD = "AdminSight1!"
    RATELIMIT_ENABLED = False
    SQLALCHEMY_ENGINE_OPTIONS = {"pool_pre_ping": True}
