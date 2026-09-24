"""Structured application logging. Never log secrets or raw media."""

from __future__ import annotations

import logging
import sys
from datetime import datetime
from pathlib import Path

SENSITIVE_KEYS = {
    "password",
    "token",
    "authorization",
    "secret",
    "api_key",
    "apikey",
    "gemini_api_key",
    "maps_api_key",
    "cloudinary_api_secret",
    "groq_api_key",
    "daily_api_key",
    "stripe_secret",
    "stripe_webhook",
    "paypal_secret",
}

_TRACE_FILE = Path(__file__).resolve().parents[1] / "api-trace.log"


def setup_logging() -> logging.Logger:
    logger = logging.getLogger("vibe_eye")
    if logger.handlers:
        return logger
    logger.setLevel(logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
    )
    logger.addHandler(handler)
    logger.propagate = False
    return logger


logger = setup_logging()


def arrow(message: str) -> None:
    """Print a line that is easy to see in the Cursor terminal."""
    line = f">>> {message}"
    print(line, flush=True)
    try:
        with _TRACE_FILE.open("a", encoding="utf-8") as fh:
            fh.write(f"{datetime.now().isoformat(timespec='seconds')} {line}\n")
            fh.flush()
    except Exception:
        pass


def log_event(event: str, **fields) -> None:
    safe = {k: v for k, v in fields.items() if k.lower() not in SENSITIVE_KEYS}
    extra = " ".join(f"{k}={v}" for k, v in safe.items())
    logger.info("%s %s", event, extra)
    arrow(f"{event} {extra}".strip())


def log_error(event: str, error: Exception, **fields) -> None:
    safe = {k: v for k, v in fields.items() if k.lower() not in SENSITIVE_KEYS}
    extra = " ".join(f"{k}={v}" for k, v in safe.items())
    logger.exception("%s %s error=%s", event, extra, error)
    arrow(f"{event} {extra} error={error}".strip())
