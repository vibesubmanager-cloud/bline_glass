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
_EDGE_BLOCKED = False
SAFT_22KHZ_16BIT_MONO = 22
WARM_PHRASES = (
    "Object detection started. I will say what I see.",
    "Object detection stopped.",
    "I did not detect any objects I recognize in this view.",
    "Okay. Looking in front of you.",
    "Okay. Reading the page in front of the camera.",
    "Hold the screen to speak. Double tap for object detection.",
)


def _cache_path(text: str, suffix: str = ".wav") -> Path:
    digest = hashlib.sha1(text.encode("utf-8")).hexdigest()
    _CACHE.mkdir(parents=True, exist_ok=True)
    return _CACHE / f"{digest}{suffix}"


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


def _synthesize_edge(text: str, path: Path) -> bool:
    """Microsoft online voices. Cloud hosts are often blocked with HTTP 403."""
    global _EDGE_BLOCKED
    if _EDGE_BLOCKED:
        return False
    try:
        import asyncio
        import edge_tts
    except ImportError:
        return False
    voice = os.getenv("TTS_VOICE", "en-US-JennyNeural")

    async def _save() -> None:
        communicate = edge_tts.Communicate(text, voice)
        await communicate.save(str(path))

    try:
        try:
            asyncio.run(_save())
        except RuntimeError:
            done = threading.Event()
            error: list[BaseException] = []

            def _runner() -> None:
                try:
                    asyncio.run(_save())
                except BaseException as exc:  # noqa: BLE001
                    error.append(exc)
                finally:
                    done.set()

            threading.Thread(target=_runner, daemon=True).start()
            if not done.wait(20):
                return False
            if error:
                raise error[0]
        return path.exists() and path.stat().st_size > 500
    except Exception as ext:
        if "403" in str(ext):
            _EDGE_BLOCKED = True
            log_event("TTS_EDGE_DISABLED", reason="microsoft_blocked")
        else:
            log_error("TTS_EDGE_ERROR", ext)
        return False


def _synthesize_gtts(text: str, path: Path) -> bool:
    try:
        from gtts import gTTS
    except ImportError:
        return False
    try:
        gTTS(text=text, lang="en", slow=False).save(str(path))
        return path.exists() and path.stat().st_size > 500
    except Exception as ext:
        log_event("TTS_GTTS_ERROR", error=type(ext).__name__)
        return False


def _synthesize_one(text: str, wav_path: Path, mp3_path: Path) -> str | None:
    if wav_path.exists() and wav_path.stat().st_size > 1000:
        return "audio/wav"
    if mp3_path.exists() and mp3_path.stat().st_size > 500:
        return "audio/mpeg"
    if _synthesize_sapi(text, wav_path) or _synthesize_windows(text, wav_path):
        return "audio/wav"
    if _synthesize_gtts(text, mp3_path):
        return "audio/mpeg"
    if _synthesize_edge(text, mp3_path):
        return "audio/mpeg"
    return None


def synthesize_audio(text: str) -> tuple[bytes, str] | None:
    cleaned = " ".join((text or "").split())[:800]
    if not cleaned:
        return None
    wav_path = _cache_path(cleaned, ".wav")
    mp3_path = _cache_path(cleaned, ".mp3")
    if wav_path.exists() and wav_path.stat().st_size > 1000:
        return wav_path.read_bytes(), "audio/wav"
    if mp3_path.exists() and mp3_path.stat().st_size > 500:
        return mp3_path.read_bytes(), "audio/mpeg"
    with _LOCK:
        if wav_path.exists() and wav_path.stat().st_size > 1000:
            return wav_path.read_bytes(), "audio/wav"
        if mp3_path.exists() and mp3_path.stat().st_size > 500:
            return mp3_path.read_bytes(), "audio/mpeg"
        started = time.perf_counter()
        log_event("TTS_SYNTH", chars=len(cleaned))
        kind = _synthesize_one(cleaned, wav_path, mp3_path)
        if kind == "audio/wav":
            payload = wav_path.read_bytes()
        elif kind == "audio/mpeg":
            payload = mp3_path.read_bytes()
        else:
            return None
        log_event("TTS_SYNTH_DONE", chars=len(cleaned), ms=int((time.perf_counter() - started) * 1000), kind=kind)
        return payload, kind


def synthesize_wav(text: str) -> bytes | None:
    result = synthesize_audio(text)
    if not result:
        return None
    payload, kind = result
    return payload if kind == "audio/wav" else payload


def warmup_tts() -> None:
    try:
        synthesize_audio(WARM_PHRASES[0])
    except Exception as exc:
        log_error("TTS_WARMUP_ERROR", exc)
