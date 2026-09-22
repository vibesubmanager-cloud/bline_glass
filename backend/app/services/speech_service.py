"""Server-side speech helpers.

Text-to-speech and microphone capture run in the browser. This module holds
shared spoken-copy used by APIs so the frontend is not the only source of truth.
"""

from app.services.response_engine import speak_error

HELP_TEXT = (
    "Hold the screen to speak. Double tap for object detection. "
    "Say send a message, send a photo, or send a map to share with your contacts. "
    "Say what is in front of me to hear a description, or read this to hear the page facing the camera."
)

__all__ = ["speak_error", "HELP_TEXT"]
