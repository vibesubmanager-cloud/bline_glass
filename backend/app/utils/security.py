"""Password hashing, JWT helpers, and request authentication."""

from __future__ import annotations

from functools import wraps
from typing import Callable

import bcrypt
import jwt
from flask import current_app, g, request

from app.extensions import db
from app.utils.responses import fail


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def create_token(user_id: str) -> str:
    import datetime

    payload = {
        "sub": user_id,
        "iat": datetime.datetime.now(datetime.timezone.utc),
        "exp": datetime.datetime.now(datetime.timezone.utc)
        + current_app.config["JWT_EXPIRES"],
    }
    return jwt.encode(payload, current_app.config["JWT_SECRET_KEY"], algorithm="HS256")


def decode_token(token: str) -> dict | None:
    try:
        return jwt.decode(token, current_app.config["JWT_SECRET_KEY"], algorithms=["HS256"])
    except jwt.PyJWTError:
        return None


def _extract_token() -> str | None:
    header = request.headers.get("Authorization", "")
    if header.startswith("Bearer "):
        return header[7:].strip()
    return None


def login_required(fn: Callable):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = _extract_token()
        if not token:
            return fail("AUTH_REQUIRED", "Please sign in to continue.", 401)
        payload = decode_token(token)
        if not payload or not payload.get("sub"):
            return fail("AUTH_INVALID", "Your session is invalid. Please sign in again.", 401)
        from app.models.user import User

        user = db.session.get(User, payload["sub"])
        if not user or not user.is_active:
            return fail("AUTH_INVALID", "Your account is unavailable. Please sign in again.", 401)
        g.current_user = user
        return fn(*args, **kwargs)

    return wrapper


def admin_required(fn: Callable):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        token = _extract_token()
        if not token:
            return fail("AUTH_REQUIRED", "Please sign in to continue.", 401)
        payload = decode_token(token)
        if not payload or not payload.get("sub"):
            return fail("AUTH_INVALID", "Your session is invalid. Please sign in again.", 401)
        from app.models.user import User

        user = db.session.get(User, payload["sub"])
        if not user or not user.is_active:
            return fail("AUTH_INVALID", "Your account is unavailable. Please sign in again.", 401)
        if user.role != "admin":
            return fail("ADMIN_REQUIRED", "This page is only for admins.", 403)
        g.current_user = user
        return fn(*args, **kwargs)

    return wrapper
