"""Turn short phrases into iPhone-friendly PCM WAV audio."""

from __future__ import annotations

import audioop
import hashlib
import os
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path

from app.utils.logging import log_error, log_event

_CACHE = Path(tempfile.gettempdir()) / "aisight-tts"
_LOCK = threading.Lock()
SAFT_22KHZ_16BIT_MONO = 22
WARM_PHRASES = (
    "Object detection started. I will say what I see.",
    "Object detection stopped.",
    "I did not detect any objects I recognize in this view.",
    "Okay. Looking in front of you.",
    "Okay. Reading the page in front of the camera.",
    "Hold the screen to speak. Double tap for object detection.",
)


def _cache_path(text: str) -> Path:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    _CACHE.mkdir(parents=True, exist_ok=True)
    return _CACHE / f"{digest}.wav"


def _normalize_wav(path: Path) -> bool:
    try:
        with wave.open(str(path), "rb") as src:
            channels = src.getnchannels()
            width = src.getsampwidth()
            rate = src.getframerate()
            frames = src.readframes(src.getnframes())
        if channels == 2:
            frames = audioop.tomono(frames, width, 0.5, 0.5)
            channels = 1
        if width != 2:
            frames = audioop.lin2lin(frames, width, 2)
            width = 2
        if rate != 22050:
            frames, _ = audioop.ratecv(frames, 2, 1, rate, 22050, None)
            rate = 22050
        with wave.open(str(path), "wb") as dst:
            dst.setnchannels(1)
            dst.setsampwidth(2)
            dst.setframerate(22050)
            dst.writeframes(frames)
        return path.stat().st_size > 1000
    except Exception as exc:
        log_error("TTS_WAV_NORMALIZE_ERROR", exc)
        return path.exists() and path.stat().st_size > 44


def _synthesize_sapi(text: str, path: Path) -> bool:
    if os.name != "nt":
        return False
    try:
        import pythoncom
        import win32com.client
    except ImportError:
        return False
    pythoncom.CoInitialize()
    try:
        speaker = win32com.client.Dispatch("SAPI.SpVoice")
        stream = win32com.client.Dispatch("SAPI.SpFileStream")
        audio_format = win32com.client.Dispatch("SAPI.SpAudioFormat")
        audio_format.Type = SAFT_22KHZ_16BIT_MONO
        stream.Format = audio_format
        stream.Open(str(path), 3)
        speaker.AudioOutputStream = stream
        try:
            speaker.Rate = 1
        except Exception:
            pass
        speaker.Speak(text)
        stream.Close()
        return _normalize_wav(path)
    except Exception as exc:
        log_error("TTS_SAPI_ERROR", exc)
        return False
    finally:
        pythoncom.CoUninitialize()


def _synthesize_windows(text: str, path: Path) -> bool:
    if os.name != "nt":
        return False
    import base64

    payload = base64.b64encode(text.encode("utf-8")).decode("ascii")
    wav = str(path).replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Speech;"
        f"$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload}'));"
        "$speak = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$speak.Rate = 1;"
        f"$speak.SetOutputToWaveFile('{wav}');"
        "$speak.Speak($text);"
        "$speak.Dispose();"
    )
    try:
        completed = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            check=False,
            timeout=10,
            capture_output=True,
        )
        if completed.returncode != 0:
            return False
        return _normalize_wav(path)
    except Exception as exc:
        log_error("TTS_WINDOWS_ERROR", exc)
        return False


def _synthesize_one(text: str, path: Path) -> bool:
    if path.exists() and path.stat().st_size > 1000:
        return True
    return _synthesize_sapi(text, path) or _synthesize_windows(text, path)


def synthesize_wav(text: str) -> bytes | None:
    cleaned = " ".join((text or "").split())[:800]
    if not cleaned:
        return None
    path = _cache_path(cleaned)
    if path.exists() and path.stat().st_size > 1000:
        return path.read_bytes()
    with _LOCK:
        if path.exists() and path.stat().st_size > 1000:
            return path.read_bytes()
        started = time.perf_counter()
        log_event("TTS_SYNTH", chars=len(cleaned))
        if not _synthesize_one(cleaned, path):
            return None
        log_event("TTS_SYNTH_DONE", chars=len(cleaned), ms=int((time.perf_counter() - started) * 1000))
        return path.read_bytes()


def warmup_tts() -> None:
    for phrase in WARM_PHRASES:
        try:
            synthesize_wav(phrase)
        except Exception as exc:
            log_error("TTS_WARMUP_ERROR", exc)
