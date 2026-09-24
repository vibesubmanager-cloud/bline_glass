"""Flask application factory."""

from __future__ import annotations

import importlib
import os
import threading

from dotenv import load_dotenv
from flask import Flask, request
from pathlib import Path

from app.config import Config
from app.extensions import cors, db, limiter, migrate, socketio
from app.utils.logging import log_event, setup_logging
from app.utils.responses import fail

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
load_dotenv()


def create_app(config_object: type[Config] | None = None) -> Flask:
    setup_logging()
    flask_app = Flask(__name__)
    config = config_object or Config
    flask_app.config.from_object(config)
    flask_app.config["PROPAGATE_EXCEPTIONS"] = False
    flask_app.config["TRAP_HTTP_EXCEPTIONS"] = True

    db.init_app(flask_app)
    migrate.init_app(flask_app, db)
    limiter.init_app(flask_app)
    if flask_app.config.get("TESTING") or flask_app.config.get("RATELIMIT_ENABLED") is False:
        limiter.enabled = False
    cors.init_app(
        flask_app,
        origins=config.FRONTEND_ORIGINS or "*",
        allow_headers=["Content-Type", "Authorization"],
        methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    )
    # Threading mode keeps YOLO/PyTorch compatible on Render. One worker is required
    # for in-memory WebRTC signaling.
    socketio.init_app(flask_app, cors_allowed_origins="*", async_mode="threading")

    from app.models import (  # noqa: F401
        ApiKey,
        CallSession,
        Contact,
        EmergencyEvent,
        Message,
        NavigationSession,
        UsageLog,
        User,
        UserSettings,
    )
    from app.routes.admin import admin_bp
    from app.routes.auth import auth_bp
    from app.routes.calls import calls_bp
    from app.routes.contacts import contacts_bp
    from app.routes.detection import detection_bp
    from app.routes.emergency import emergency_bp
    from app.routes.frontend import frontend_bp
    from app.routes.health import health_bp
    from app.routes.intent import intent_bp
    from app.routes.messages import messages_bp
    from app.routes.navigation import navigation_bp
    from app.routes.vision import vision_bp
    from app.routes.voice import voice_bp

    importlib.import_module("app.sockets")

    flask_app.register_blueprint(health_bp, url_prefix="/api")
    flask_app.register_blueprint(auth_bp, url_prefix="/api/auth")
    flask_app.register_blueprint(admin_bp, url_prefix="/api/admin")
    flask_app.register_blueprint(intent_bp, url_prefix="/api/intent")
    flask_app.register_blueprint(vision_bp, url_prefix="/api/vision")
    flask_app.register_blueprint(voice_bp, url_prefix="/api/voice")
    flask_app.register_blueprint(detection_bp, url_prefix="/api/detection")
    flask_app.register_blueprint(navigation_bp, url_prefix="/api/navigation")
    flask_app.register_blueprint(contacts_bp, url_prefix="/api/contacts")
    flask_app.register_blueprint(messages_bp, url_prefix="/api/messages")
    flask_app.register_blueprint(calls_bp, url_prefix="/api/calls")
    flask_app.register_blueprint(emergency_bp, url_prefix="/api/emergency")
    flask_app.register_blueprint(frontend_bp)

    @flask_app.before_request
    def log_request():
        from app.utils.logging import arrow

        has_auth = "yes" if request.headers.get("Authorization") else "no"
        arrow(f"{request.method} {request.path} auth={has_auth} ip={request.remote_addr}")

    @flask_app.after_request
    def add_client_hints(response):
        from app.utils.logging import arrow

        arrow(f"{request.method} {request.path} -> {response.status_code}")
        response.headers["Permissions-Policy"] = "geolocation=*, camera=(self), microphone=(self)"
        path = request.path.lower()
        if path.endswith((".html", ".js", ".css")) or path in {"/", ""}:
            response.headers["Cache-Control"] = "no-store, max-age=0"
        return response

    @flask_app.errorhandler(413)
    def too_large(_e):
        return fail("IMAGE_TOO_LARGE", "Image is too large. Maximum size is 20 MB.", 413)

    @flask_app.errorhandler(429)
    def rate_limited(_e):
        return fail("RATE_LIMITED", "Too many requests. Please wait a moment.", 429)

    @flask_app.errorhandler(404)
    def not_found(_e):
        if request.path.startswith("/api"):
            return fail("NOT_FOUND", "That endpoint does not exist.", 404)
        return fail("NOT_FOUND", "That page does not exist.", 404)

    @flask_app.errorhandler(500)
    def server_error(_e):
        return fail("SERVER_ERROR", "Something went wrong. Please try again.", 500)

    @flask_app.errorhandler(Exception)
    def unhandled_error(error):
        if request.path.startswith("/api"):
            from app.utils.logging import arrow

            arrow(f"CRASH {request.path} {type(error).__name__}: {error}")
            log_event("UNHANDLED_API_ERROR", path=request.path, error=type(error).__name__, detail=str(error)[:180])
            return fail("SERVER_ERROR", str(error) or "I couldn't complete that request. Please try again.", 500)
        raise error

    def _boot_database():
        db.create_all()
        for step in (
            _ensure_settings_columns,
            _ensure_user_columns,
            _ensure_contact_columns,
            _ensure_message_table,
            _ensure_api_key_table,
            _ensure_call_columns,
        ):
            try:
                step()
            except Exception as extra:
                db.session.rollback()
                log_event("DB_BOOT_ERROR", step=step.__name__, error=str(extra)[:220])
        from app.routes.admin import seed_admin_user
        from app.services.key_store import seed_env_keys

        seed_admin_user()
        seed_env_keys()

    def _warmup():
        with flask_app.app_context():
            try:
                _boot_database()
            except Exception as extra:
                db.session.rollback()
                log_event("DB_BOOT_ERROR", error=str(extra)[:220])
            try:
                from app.services.tts_service import warmup_tts

                warmup_tts()
            except Exception as extra:
                log_event("TTS_WARMUP_ERROR", error=str(extra)[:180])
            if str(flask_app.config.get("YOLO_WARMUP") or os.getenv("YOLO_WARMUP") or "0") == "1":
                try:
                    from app.services.yolo_service import get_yolo_service

                    get_yolo_service().warmup()
                except Exception as extra:
                    log_event("YOLO_WARMUP_ERROR", error=str(extra)[:180])

    if flask_app.config.get("TESTING"):
        with flask_app.app_context():
            _boot_database()
    else:
        threading.Thread(target=_warmup, name="aisight-warmup", daemon=True).start()

    return flask_app


def _ensure_settings_columns() -> None:
    from sqlalchemy import inspect, text

    inspector = inspect(db.engine)
    if "user_settings" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("user_settings")}
    if "walking_directions" not in columns:
        db.session.execute(text("ALTER TABLE user_settings ADD COLUMN walking_directions BOOLEAN DEFAULT FALSE"))
    if "calling_configured" not in columns:
        db.session.execute(text("ALTER TABLE user_settings ADD COLUMN calling_configured BOOLEAN DEFAULT FALSE"))
    db.session.commit()


def _ensure_user_columns() -> None:
    from sqlalchemy import inspect, text

    from app.models.user import User
    from app.services.identity_service import ensure_user_identity

    inspector = inspect(db.engine)
    if "users" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("users")}
    additions = {
        "first_name": "VARCHAR(80)",
        "last_name": "VARCHAR(80)",
        "username": "VARCHAR(64)",
        "role": "VARCHAR(16) DEFAULT 'blind'",
        "system_id": "VARCHAR(16)",
        "health_notes": "TEXT",
        "other_notes": "TEXT",
        "linked_blind_user_id": "VARCHAR(36)",
        "relationship_to_blind": "VARCHAR(80)",
    }
    for name, definition in additions.items():
        if name not in columns:
            db.session.execute(text(f"ALTER TABLE users ADD COLUMN {name} {definition}"))
    db.session.commit()
    for user in User.query.all():
        ensure_user_identity(user)
    db.session.commit()


def _ensure_contact_columns() -> None:
    from sqlalchemy import inspect, text

    inspector = inspect(db.engine)
    if "contacts" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("contacts")}
    if "linked_user_id" not in columns:
        db.session.execute(text("ALTER TABLE contacts ADD COLUMN linked_user_id VARCHAR(36)"))
        db.session.commit()


def _ensure_message_table() -> None:
    from sqlalchemy import inspect

    from app.models.message import Message

    inspector = inspect(db.engine)
    if "messages" not in inspector.get_table_names():
        Message.__table__.create(bind=db.engine, checkfirst=True)


def _ensure_api_key_table() -> None:
    from sqlalchemy import inspect

    from app.models.api_key import ApiKey

    inspector = inspect(db.engine)
    if "api_keys" not in inspector.get_table_names():
        ApiKey.__table__.create(bind=db.engine, checkfirst=True)


def _ensure_call_columns() -> None:
    from sqlalchemy import inspect, text

    inspector = inspect(db.engine)
    if "call_sessions" not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns("call_sessions")}
    if "daily_room_name" not in columns:
        db.session.execute(text("ALTER TABLE call_sessions ADD COLUMN daily_room_name VARCHAR(128)"))
    if "daily_room_url" not in columns:
        db.session.execute(text("ALTER TABLE call_sessions ADD COLUMN daily_room_url VARCHAR(255)"))
    if "jitsi_room_name" not in columns:
        db.session.execute(text("ALTER TABLE call_sessions ADD COLUMN jitsi_room_name VARCHAR(128)"))
    db.session.commit()
