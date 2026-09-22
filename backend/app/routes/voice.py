from flask import Blueprint, g, request, send_file
from io import BytesIO

from app.services.tts_service import synthesize_wav
from app.utils.logging import log_event
from app.utils.responses import fail
from app.utils.security import login_required

voice_bp = Blueprint("voice", __name__)


@voice_bp.post("/speak")
@login_required
def speak():
    data = request.get_json(silent=True) or {}
    text = data.get("text") if isinstance(data.get("text"), str) else ""
    wav = synthesize_wav(text)
    if not wav:
        return fail("SPEECH_UNAVAILABLE", "I couldn't speak that right now.", 503)
    log_event("TTS_PLAY", user_id=g.current_user.id, chars=len(text.strip()))
    return send_file(BytesIO(wav), mimetype="audio/wav", download_name="speak.wav")
