from flask import Blueprint, g, request

from app.models.contact import Contact
from app.models.user import User
from app.services.intent_service import understand_command
from app.services.share_location_service import find_matching_contact
from app.services.speech_service import HELP_TEXT
from app.utils.responses import fail, ok
from app.utils.security import login_required

intent_bp = Blueprint("intent", __name__)


def _contact_summaries(user: User) -> list[dict]:
    rows = Contact.query.filter_by(user_id=user.id).order_by(Contact.name.asc()).all()
    items = []
    for contact in rows:
        items.append(
            {
                "id": contact.id,
                "name": contact.name,
                "relationship": contact.relationship,
            }
        )
    return items


@intent_bp.post("/parse")
@login_required
def parse():
    data = request.get_json(silent=True) or {}
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        return fail("VALIDATION_ERROR", "text is required.", 400)
    contacts = _contact_summaries(g.current_user)
    parsed = understand_command(text, contacts)
    slots = dict(parsed.get("slots") or {})
    target = slots.get("target") or ""
    if parsed["intent"] == "DELETE_CONTACT" and target:
        match = find_matching_contact(
            Contact.query.filter_by(user_id=g.current_user.id).all(),
            target,
        )
        if match:
            slots["contact_id"] = match.id
            slots["target"] = match.name
        parsed["needs_confirm"] = True
    parsed["slots"] = slots
    if parsed["intent"] == "HELP" and not parsed.get("spoken"):
        parsed["spoken"] = HELP_TEXT
    elif parsed["intent"] in {"UNKNOWN", "REPLY"} and not parsed.get("spoken"):
        parsed["spoken"] = (
            "Say send a message, send a photo, send a map, "
            "what is in front of me, or read this."
        )
    return ok(parsed)
