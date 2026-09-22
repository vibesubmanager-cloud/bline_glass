from datetime import datetime, timezone

from flask import Blueprint, g, request

from app.extensions import db
from app.models.navigation import NavigationSession
from app.services.navigation_service import MapsServiceError, get_navigation_service
from app.services.response_engine import format_distance, speak_navigation_start
from app.services.usage_service import record_usage
from app.utils.logging import log_event
from app.utils.responses import fail, ok
from app.utils.security import login_required
from app.utils.validation import ValidationError, require_json, require_string, validate_lat_lng

navigation_bp = Blueprint("navigation", __name__)


def _maps_fail(exc: MapsServiceError):
    status = 404 if exc.code == "DESTINATION_NOT_FOUND" else 503
    return fail(exc.code, str(exc), status)


@navigation_bp.post("/search")
@login_required
def search():
    try:
        data = require_json(request.get_json(silent=True))
        query = require_string(data, "query", min_len=2, max_len=255)
        results = get_navigation_service().search(query)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except MapsServiceError as exc:
        return _maps_fail(exc)
    spoken = f"I found {len(results)} place{'s' if len(results) != 1 else ''}. The top result is {results[0]['name']}."
    return ok({"results": results, "spoken": spoken})


@navigation_bp.post("/start")
@login_required
def start_navigation():
    try:
        data = require_json(request.get_json(silent=True))
        query = require_string(data, "destination", min_len=2, max_len=255)
        origin_lat, origin_lng = validate_lat_lng(data.get("origin_lat"), data.get("origin_lng"))
        accuracy = data.get("accuracy")
        service = get_navigation_service()
        results = service.search(query, near=(origin_lat, origin_lng))
        chosen = results[0]
        if data.get("destination_lat") is not None:
            dest_lat, dest_lng = validate_lat_lng(data.get("destination_lat"), data.get("destination_lng"))
            chosen = {"name": data.get("destination_name") or query, "lat": dest_lat, "lng": dest_lng}
        route = service.calculate_route((origin_lat, origin_lng), (chosen["lat"], chosen["lng"]))
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except MapsServiceError as exc:
        return _maps_fail(exc)

    gps_warning = None
    try:
        if accuracy is not None and float(accuracy) > 50:
            gps_warning = "GPS accuracy is poor, so directions may be less precise."
    except (TypeError, ValueError):
        gps_warning = None

    session = NavigationSession(
        user_id=g.current_user.id,
        destination_query=query,
        destination_name=chosen.get("name") or query,
        destination_lat=chosen["lat"],
        destination_lng=chosen["lng"],
        origin_lat=origin_lat,
        origin_lng=origin_lng,
        status="active",
        route_summary={
            "distance_m": route.get("distance_m"),
            "duration_s": route.get("duration_s"),
            "step_count": len(route.get("steps") or []),
        },
    )
    db.session.add(session)
    db.session.commit()
    log_event("NAVIGATION_STARTED", session_id=session.id)
    record_usage("NAVIGATION_STARTED", g.current_user.id)

    first = (route.get("steps") or [{}])[0].get("instruction")
    spoken = speak_navigation_start(session.destination_name, first, route.get("distance_m"))
    if gps_warning:
        spoken = f"{gps_warning} {spoken}"
    return ok(
        {
            "session": session.public_dict(),
            "route": route,
            "gps_warning": gps_warning,
            "spoken": spoken,
        }
    )


@navigation_bp.post("/recalculate")
@login_required
def recalculate():
    try:
        data = require_json(request.get_json(silent=True))
        session_id = require_string(data, "session_id")
        origin_lat, origin_lng = validate_lat_lng(data.get("origin_lat"), data.get("origin_lng"))
        session = NavigationSession.query.filter_by(id=session_id, user_id=g.current_user.id).first()
        if not session or session.status != "active":
            return fail("NAV_SESSION_NOT_FOUND", "No active navigation session.", 404)
        route = get_navigation_service().calculate_route(
            (origin_lat, origin_lng),
            (session.destination_lat, session.destination_lng),
        )
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except MapsServiceError as exc:
        return _maps_fail(exc)
    session.origin_lat = origin_lat
    session.origin_lng = origin_lng
    session.route_summary = {
        "distance_m": route.get("distance_m"),
        "duration_s": route.get("duration_s"),
        "step_count": len(route.get("steps") or []),
    }
    db.session.commit()
    first = (route.get("steps") or [{}])[0].get("instruction")
    spoken = f"Route updated. {first}" if first else "Route updated."
    return ok({"session": session.public_dict(), "route": route, "spoken": spoken})


@navigation_bp.get("/status")
@login_required
def status():
    session = (
        NavigationSession.query.filter_by(user_id=g.current_user.id, status="active")
        .order_by(NavigationSession.started_at.desc())
        .first()
    )
    if not session:
        return ok({"session": None, "spoken": "You are not navigating right now."})
    remaining = None
    if session.route_summary:
        remaining = session.route_summary.get("distance_m")
    spoken = f"Navigating to {session.destination_name}."
    if remaining:
        spoken += f" About {format_distance(remaining)} remaining."
    return ok({"session": session.public_dict(), "spoken": spoken})


@navigation_bp.post("/where")
@login_required
def where_am_i():
    try:
        data = require_json(request.get_json(silent=True))
        lat, lng = validate_lat_lng(data.get("lat"), data.get("lng"))
        place = get_navigation_service().reverse(lat, lng)
    except ValidationError as exc:
        return fail(exc.code, exc.message, 400)
    except MapsServiceError as exc:
        return _maps_fail(exc)
    name = place.get("name")
    spoken = f"You are near {name}." if name else "I have your coordinates, but I could not name this place."
    return ok({"place": place, "spoken": spoken})


@navigation_bp.post("/stop")
@login_required
def stop():
    data = request.get_json(silent=True) or {}
    session_id = data.get("session_id")
    query = NavigationSession.query.filter_by(user_id=g.current_user.id, status="active")
    if session_id:
        query = query.filter_by(id=session_id)
    sessions = query.all()
    for session in sessions:
        session.status = "cancelled"
        session.ended_at = datetime.now(timezone.utc)
    db.session.commit()
    log_event("NAVIGATION_STOPPED", user_id=g.current_user.id)
    return ok({"stopped": len(sessions), "spoken": "Navigation stopped."})
