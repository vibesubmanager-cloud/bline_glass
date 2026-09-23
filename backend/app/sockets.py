"""WebRTC signaling over Socket.IO. Media never transits the server."""

from flask import request
from flask_socketio import emit, join_room, leave_room

from app.extensions import db, socketio
from app.utils.logging import log_event
from app.utils.security import decode_token
from app.services.calling_service import persist_signal
from app.models.user import User


def _user_from_token(token: str):
    payload = decode_token(token or "")
    if not payload:
        return None
    return db.session.get(User, payload.get("sub"))


@socketio.on("connect")
def on_connect(auth):
    token = (auth or {}).get("token") if isinstance(auth, dict) else None
    user = _user_from_token(token)
    if not user:
        return False
    join_room(f"user:{user.id}")
    emit("connected", {"user_id": user.id})
    log_event("SOCKET_CONNECTED", user_id=user.id)


@socketio.on("disconnect")
def on_disconnect():
    log_event("SOCKET_DISCONNECTED", sid=request.sid)


@socketio.on("call-signal")
def on_signal(data):
    token = (data or {}).get("token")
    user = _user_from_token(token)
    if not user:
        return
    target_id = (data or {}).get("target_user_id")
    if not target_id:
        return
    payload = {
        "from_user_id": user.id,
        "from_name": user.name,
        "call_id": data.get("call_id"),
        "signal_type": data.get("signal_type"),
        "payload": data.get("payload"),
        "media": data.get("media") or "audio",
    }
    persist_signal(target_id, payload)
    emit("call-signal", payload, room=f"user:{target_id}")
    log_event("CALL_SIGNAL", from_user=user.id, to_user=target_id, kind=data.get("signal_type"))
