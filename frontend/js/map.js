/** Street map for live walking directions. Uses Leaflet when loaded. */

let map;
let routeLine;
let userMarker;
let destMarker;
let lastFitKey = "";

function leafletReady() {
  return Boolean(window.L);
}

function flattenLatLngs(latlngs) {
  const out = [];
  (latlngs || []).forEach((item) => {
    if (Array.isArray(item)) out.push(...flattenLatLngs(item));
    else if (item) out.push(item);
  });
  return out;
}

export function ensureNavMap() {
  const el = document.getElementById("nav-map");
  if (!el || !leafletReady()) return null;
  if (map) {
    setTimeout(() => map.invalidateSize(), 80);
    return map;
  }
  map = window.L.map(el, {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    tap: false,
    boxZoom: false,
    keyboard: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
  });
  window.L
    .tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
      maxZoom: 20,
    })
    .addTo(map);
  map.setView([28.6139, 77.209], 13);
  setTimeout(() => map.invalidateSize(), 80);
  return map;
}

export function fitNavMap() {
  const instance = map;
  if (!instance || !window.L) return;
  const pts = [];
  if (routeLine) pts.push(...flattenLatLngs(routeLine.getLatLngs()));
  if (userMarker) pts.push(userMarker.getLatLng());
  if (destMarker) pts.push(destMarker.getLatLng());
  if (!pts.length) return;
  if (pts.length === 1) {
    instance.setView(pts[0], 15);
    return;
  }
  instance.fitBounds(window.L.latLngBounds(pts), {
    padding: [48, 48],
    maxZoom: 15,
    animate: true,
  });
  setTimeout(() => instance.invalidateSize(), 80);
}

export function updateNavMap({ polyline, user, destination } = {}) {
  const instance = ensureNavMap();
  const canvas = document.getElementById("route-canvas");
  if (!instance) {
    canvas?.classList.remove("hidden");
    return false;
  }
  canvas?.classList.add("hidden");
  const L = window.L;
  const points = (polyline || []).filter((p) => p.lat != null && p.lng != null);
  if (routeLine) {
    routeLine.remove();
    routeLine = null;
  }
  if (points.length) {
    routeLine = L.polyline(
      points.map((p) => [p.lat, p.lng]),
      { color: "#5b4dff", weight: 6, opacity: 0.95 }
    ).addTo(instance);
  }
  if (user?.lat != null) {
    if (!userMarker) {
      userMarker = L.circleMarker([user.lat, user.lng], {
        radius: 9,
        color: "#ffffff",
        weight: 2,
        fillColor: "#1a73e8",
        fillOpacity: 1,
      }).addTo(instance);
    } else {
      userMarker.setLatLng([user.lat, user.lng]);
    }
  }
  if (destination?.lat != null) {
    if (!destMarker) {
      destMarker = L.circleMarker([destination.lat, destination.lng], {
        radius: 8,
        color: "#ffffff",
        weight: 2,
        fillColor: "#ea4335",
        fillOpacity: 1,
      }).addTo(instance);
    } else {
      destMarker.setLatLng([destination.lat, destination.lng]);
    }
  }
  const round = (n) => (n == null ? "" : Number(n).toFixed(3));
  const fitKey = [round(user?.lat), round(user?.lng), round(destination?.lat), round(destination?.lng), points.length].join(":");
  if (fitKey !== lastFitKey && (points.length || (user && destination))) {
    lastFitKey = fitKey;
    fitNavMap();
  }
  setTimeout(() => instance.invalidateSize(), 80);
  return true;
}

export function clearNavMap() {
  lastFitKey = "";
  if (routeLine) {
    routeLine.remove();
    routeLine = null;
  }
  if (userMarker) {
    userMarker.remove();
    userMarker = null;
  }
  if (destMarker) {
    destMarker.remove();
    destMarker = null;
  }
}
