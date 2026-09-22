"""Maps / routing provider abstraction.

Default provider: OpenRouteService (geocoding + pedestrian routing).
Swap providers by implementing MapsProvider and setting MAPS_PROVIDER.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

import requests

from app.utils.logging import log_error, log_event


class MapsServiceError(RuntimeError):
    def __init__(self, message: str, code: str = "MAPS_SERVICE_ERROR"):
        super().__init__(message)
        self.code = code


class MapsProvider(ABC):
    @abstractmethod
    def geocode(self, query: str, near: tuple[float, float] | None = None) -> list[dict]:
        raise NotImplementedError

    @abstractmethod
    def reverse_geocode(self, lat: float, lng: float) -> dict:
        raise NotImplementedError

    @abstractmethod
    def route(self, origin: tuple[float, float], destination: tuple[float, float]) -> dict:
        raise NotImplementedError


class OpenRouteServiceProvider(MapsProvider):
    BASE = "https://api.openrouteservice.org"

    def __init__(self, api_key: str, timeout: int = 20):
        self.api_key = api_key
        self.timeout = timeout

    def _headers(self) -> dict:
        return {"Authorization": self.api_key, "Content-Type": "application/json"}

    def geocode(self, query: str, near: tuple[float, float] | None = None) -> list[dict]:
        if not self.api_key:
            raise MapsServiceError("Maps API key is not configured.")
        params = {"api_key": self.api_key, "text": query, "size": 5}
        if near:
            params["focus.point.lat"] = near[0]
            params["focus.point.lon"] = near[1]
        try:
            response = requests.get(
                f"{self.BASE}/geocode/search",
                params=params,
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            log_error("MAPS_GEOCODE_ERROR", exc)
            raise MapsServiceError("I couldn't search for that destination.") from exc

        features = payload.get("features") or []
        results = []
        for feature in features:
            coords = (feature.get("geometry") or {}).get("coordinates") or [None, None]
            props = feature.get("properties") or {}
            lng, lat = coords[0], coords[1]
            if lat is None or lng is None:
                continue
            results.append(
                {
                    "name": props.get("label") or props.get("name") or query,
                    "lat": lat,
                    "lng": lng,
                    "layer": props.get("layer"),
                }
            )
        return results

    def reverse_geocode(self, lat: float, lng: float) -> dict:
        if not self.api_key:
            raise MapsServiceError("Maps API key is not configured.")
        try:
            response = requests.get(
                f"{self.BASE}/geocode/reverse",
                params={"api_key": self.api_key, "point.lat": lat, "point.lon": lng, "size": 1},
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            log_error("MAPS_REVERSE_ERROR", exc)
            raise MapsServiceError("I couldn't determine your current location name.") from exc
        features = payload.get("features") or []
        if not features:
            return {"name": None, "lat": lat, "lng": lng}
        props = features[0].get("properties") or {}
        return {"name": props.get("label") or props.get("name"), "lat": lat, "lng": lng}

    def route(self, origin: tuple[float, float], destination: tuple[float, float]) -> dict:
        if not self.api_key:
            raise MapsServiceError("Maps API key is not configured.")
        body = {
            "coordinates": [
                [origin[1], origin[0]],
                [destination[1], destination[0]],
            ],
            "instructions": True,
            "language": "en",
            "units": "m",
        }
        try:
            response = requests.post(
                f"{self.BASE}/v2/directions/foot-walking/geojson",
                headers=self._headers(),
                json=body,
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            log_error("MAPS_ROUTE_ERROR", exc)
            raise MapsServiceError("I couldn't calculate a walking route.") from exc
        return normalize_ors_route(payload, origin, destination)


OSM_USER_AGENT = "AI-Sight/1.0 (assistive navigation)"


def _format_step_distance(meters: float | None) -> str:
    if meters is None:
        return ""
    if meters < 10:
        return "a few meters"
    if meters < 1000:
        return f"{int(round(meters))} meters"
    km = meters / 1000
    if km < 10:
        return f"{km:.1f} kilometers"
    return f"{int(round(km))} kilometers"


def _osrm_instruction(step: dict) -> str:
    maneuver = step.get("maneuver") or {}
    kind = (maneuver.get("type") or "continue").replace("_", " ")
    modifier = (maneuver.get("modifier") or "").replace("_", " ").strip()
    name = (step.get("name") or "").strip()
    dist = _format_step_distance(step.get("distance"))
    onto = f" onto {name}" if name else ""
    on_name = f" on {name}" if name else ""
    if kind == "depart":
        return f"Start walking{on_name}."
    if kind == "arrive":
        return "You have arrived at your destination."
    if kind in {"turn", "end of road", "fork", "ramp", "off ramp", "on ramp"}:
        if "left" in modifier:
            action = "Turn left"
        elif "right" in modifier:
            action = "Turn right"
        elif "straight" in modifier or "uturn" in modifier:
            action = "Go straight" if "straight" in modifier else "Make a U-turn"
        else:
            action = f"Turn {modifier}" if modifier else "Turn"
        body = f"{action}{onto}."
        return f"In {dist}, {body[0].lower() + body[1:]}" if dist else body
    if kind in {"new name", "continue"}:
        body = f"Go straight{on_name}." if "straight" in modifier or not modifier else f"Continue{on_name}."
        return f"In {dist}, {body[0].lower() + body[1:]}" if dist else body
    if kind in {"roundabout", "rotary"}:
        body = f"Take the roundabout{onto}."
        return f"In {dist}, {body[0].lower() + body[1:]}" if dist else body
    if kind == "merge":
        body = f"Merge{onto}."
        return f"In {dist}, {body[0].lower() + body[1:]}" if dist else body
    body = f"{kind.title()} {modifier}{onto}.".strip()
    return f"In {dist}, {body[0].lower() + body[1:]}" if dist else body


class OsmProvider(MapsProvider):
    """Nominatim search + public OSRM walking routes. No API key required."""

    NOMINATIM = "https://nominatim.openstreetmap.org"
    OSRM = "https://router.project-osrm.org"

    def __init__(self, timeout: int = 20):
        self.timeout = timeout
        self._headers = {"User-Agent": OSM_USER_AGENT, "Accept": "application/json"}

    def geocode(self, query: str, near: tuple[float, float] | None = None) -> list[dict]:
        params: dict[str, Any] = {"q": query, "format": "jsonv2", "limit": 5, "addressdetails": 1}
        if near:
            lat, lng = near
            params["viewbox"] = f"{lng - 0.25},{lat + 0.25},{lng + 0.25},{lat - 0.25}"
            params["bounded"] = 0
        try:
            response = requests.get(
                f"{self.NOMINATIM}/search",
                params=params,
                headers=self._headers,
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            log_error("MAPS_GEOCODE_ERROR", exc)
            raise MapsServiceError("I couldn't search for that destination.") from exc
        results = []
        for item in payload or []:
            try:
                lat = float(item.get("lat"))
                lng = float(item.get("lon"))
            except (TypeError, ValueError):
                continue
            results.append(
                {
                    "name": item.get("display_name") or item.get("name") or query,
                    "lat": lat,
                    "lng": lng,
                    "layer": item.get("type"),
                }
            )
        return results

    def reverse_geocode(self, lat: float, lng: float) -> dict:
        try:
            response = requests.get(
                f"{self.NOMINATIM}/reverse",
                params={"lat": lat, "lon": lng, "format": "jsonv2"},
                headers=self._headers,
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json() or {}
        except Exception as exc:
            log_error("MAPS_REVERSE_ERROR", exc)
            raise MapsServiceError("I couldn't determine your current location name.") from exc
        return {"name": payload.get("display_name") or payload.get("name"), "lat": lat, "lng": lng}

    def route(self, origin: tuple[float, float], destination: tuple[float, float]) -> dict:
        coords = f"{origin[1]},{origin[0]};{destination[1]},{destination[0]}"
        try:
            response = requests.get(
                f"{self.OSRM}/route/v1/foot/{coords}",
                params={"overview": "full", "geometries": "geojson", "steps": "true"},
                headers=self._headers,
                timeout=self.timeout,
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            log_error("MAPS_ROUTE_ERROR", exc)
            raise MapsServiceError("I couldn't calculate a walking route.") from exc
        if payload.get("code") != "Ok" or not payload.get("routes"):
            raise MapsServiceError("No walking route was found.", "MAPS_NO_ROUTE")
        return normalize_osrm_route(payload, origin, destination)


def normalize_osrm_route(payload: dict, origin: tuple[float, float], destination: tuple[float, float]) -> dict:
    route = (payload.get("routes") or [None])[0]
    if not route:
        raise MapsServiceError("No walking route was found.", "MAPS_NO_ROUTE")
    geometry = route.get("geometry") or {}
    coords = geometry.get("coordinates") or []
    steps = []
    for leg in route.get("legs") or []:
        for step in leg.get("steps") or []:
            loc = (step.get("maneuver") or {}).get("location") or [None, None]
            lng, lat = loc[0], loc[1]
            steps.append(
                {
                    "instruction": _osrm_instruction(step),
                    "distance_m": step.get("distance"),
                    "duration_s": step.get("duration"),
                    "type": (step.get("maneuver") or {}).get("type"),
                    "lat": lat,
                    "lng": lng,
                }
            )
    polyline = [{"lat": latlng[1], "lng": latlng[0]} for latlng in coords]
    return {
        "provider": "osm",
        "origin": {"lat": origin[0], "lng": origin[1]},
        "destination": {"lat": destination[0], "lng": destination[1]},
        "distance_m": route.get("distance"),
        "duration_s": route.get("duration"),
        "steps": steps,
        "polyline": polyline[:800],
    }


def normalize_ors_route(payload: dict, origin: tuple[float, float], destination: tuple[float, float]) -> dict:
    features = payload.get("features") or []
    if not features:
        raise MapsServiceError("No walking route was found.", "MAPS_NO_ROUTE")
    feature = features[0]
    geometry = feature.get("geometry") or {}
    coords = geometry.get("coordinates") or []
    properties = feature.get("properties") or {}
    summary = properties.get("summary") or {}
    segments = properties.get("segments") or []
    steps = []
    for segment in segments:
        for step in segment.get("steps") or []:
            way_points = step.get("way_points") or [0, 0]
            idx = way_points[0] if way_points else 0
            point = coords[idx] if idx < len(coords) else None
            steps.append(
                {
                    "instruction": step.get("instruction") or "",
                    "distance_m": step.get("distance"),
                    "duration_s": step.get("duration"),
                    "type": step.get("type"),
                    "lat": point[1] if point else None,
                    "lng": point[0] if point else None,
                }
            )
    polyline = [{"lat": latlng[1], "lng": latlng[0]} for latlng in coords]
    return {
        "provider": "openrouteservice",
        "origin": {"lat": origin[0], "lng": origin[1]},
        "destination": {"lat": destination[0], "lng": destination[1]},
        "distance_m": summary.get("distance"),
        "duration_s": summary.get("duration"),
        "steps": steps,
        "polyline": polyline[:500],
    }


class NavigationService:
    def __init__(self, provider: MapsProvider):
        self.provider = provider

    def search(self, query: str, near: tuple[float, float] | None = None) -> list[dict]:
        log_event("NAVIGATION_SEARCH", query_len=len(query or ""))
        results = self.provider.geocode(query, near=near)
        if not results:
            raise MapsServiceError("I couldn't find that destination.", "DESTINATION_NOT_FOUND")
        return results

    def reverse(self, lat: float, lng: float) -> dict:
        return self.provider.reverse_geocode(lat, lng)

    def calculate_route(self, origin: tuple[float, float], destination: tuple[float, float]) -> dict:
        log_event("NAVIGATION_ROUTE")
        return self.provider.route(origin, destination)


def build_provider(name: str, api_key: str) -> MapsProvider:
    normalized = (name or "osm").lower()
    if normalized in {"openrouteservice", "ors"}:
        return OpenRouteServiceProvider(api_key)
    if normalized in {"osm", "openstreetmap", "osrm"}:
        return OsmProvider()
    raise MapsServiceError(f"Unknown maps provider: {name}")


def get_navigation_service() -> NavigationService:
    from flask import current_app

    key = current_app.config.get("MAPS_API_KEY", "") or ""
    name = current_app.config.get("MAPS_PROVIDER", "osm")
    if not key:
        name = "osm"
    return NavigationService(build_provider(name, key))
