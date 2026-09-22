from app.routes.auth import auth_bp
from app.routes.admin import admin_bp
from app.routes.vision import vision_bp
from app.routes.detection import detection_bp
from app.routes.navigation import navigation_bp
from app.routes.contacts import contacts_bp
from app.routes.calls import calls_bp
from app.routes.emergency import emergency_bp
from app.routes.messages import messages_bp
from app.routes.intent import intent_bp
from app.routes.health import health_bp

__all__ = [
    "auth_bp",
    "admin_bp",
    "vision_bp",
    "detection_bp",
    "navigation_bp",
    "contacts_bp",
    "messages_bp",
    "calls_bp",
    "emergency_bp",
    "intent_bp",
    "health_bp",
]
