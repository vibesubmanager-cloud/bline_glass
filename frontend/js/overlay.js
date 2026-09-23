/** Visual overlays for the camera UI. Does not replace detection, voice, or navigation logic. */

export function $(id) {
  return document.getElementById(id);
}

export function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle("hidden", hidden);
}

export function setListeningUI(active) {
  setHidden($("listen-overlay"), !active);
  $("mic-pill")?.classList.toggle("is-on", active);
  document.body.classList.toggle("is-listening", active);
}

export function setAiStatus(text) {
  const el = $("ai-overlay");
  if (!el) return;
  if (!text) {
    setHidden(el, true);
    return;
  }
  el.textContent = text;
  setHidden(el, false);
}

export function setLive(on) {
  $("live-pill")?.classList.toggle("is-on", on);
}

export function setGps(on) {
  $("gps-pill")?.classList.toggle("is-on", on);
}

export function setOnline(_on) {
  /* NET pill was replaced by the object-detection HUD. */
}

export function setDetectHud(state) {
  const pill = $("detect-pill");
  const label = $("detect-pill-label");
  if (!pill) return;
  pill.classList.toggle("is-loading", state === "loading");
  pill.classList.toggle("is-on", state === "live" || state === "ready");
  pill.classList.toggle("is-ready", state === "ready");
  if (label) {
    if (state === "loading") label.textContent = "LOAD";
    else if (state === "live") label.textContent = "DET";
    else label.textContent = "DET";
  }
}

export function drawDetections(canvas, video, detections, sourceSize) {
  if (!canvas || !video) return;
  const ctx = canvas.getContext("2d");
  const width = video.clientWidth || 0;
  const height = video.clientHeight || 0;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  if (!detections?.length || !video.videoWidth) return;
  const srcW = sourceSize?.width || video.videoWidth;
  const srcH = sourceSize?.height || video.videoHeight;
  const scaleX = width / srcW;
  const scaleY = height / srcH;
  const seen = new Set();
  detections
    .filter((item) => (item.confidence || 0) >= 0.28)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 6)
    .forEach((item) => {
      const key = item.label;
      if (seen.has(key) && seen.size >= 4) return;
      seen.add(key);
      const [x1, y1, x2, y2] = item.bbox || [];
      const x = x1 * scaleX;
      const y = y1 * scaleY;
      const w = (x2 - x1) * scaleX;
      const h = (y2 - y1) * scaleY;
      ctx.strokeStyle = "rgba(90, 220, 255, 0.95)";
      ctx.lineWidth = 2;
      ctx.shadowColor = "rgba(90, 220, 255, 0.6)";
      ctx.shadowBlur = 8;
      roundRect(ctx, x, y, w, h, 10);
      ctx.stroke();
      const label = item.label.replace(/_/g, " ");
      ctx.shadowBlur = 0;
      ctx.font = "600 14px Inter, Segoe UI, sans-serif";
      const pad = 10;
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = "rgba(6, 12, 22, 0.78)";
      roundRect(ctx, x, Math.max(0, y - 24), textW + pad * 2, 22, 8);
      ctx.fill();
      ctx.fillStyle = "#e8fbff";
      ctx.fillText(label, x + pad, Math.max(16, y - 8));
    });
}

export function clearDetections(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

export function drawRoute(canvas, polyline, user, destination) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth || 320;
  const height = canvas.clientHeight || 140;
  canvas.width = width;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  const points = (polyline || []).filter((p) => p.lat != null);
  if (!points.length) return;
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  if (user) {
    lats.push(user.lat);
    lngs.push(user.lng);
  }
  if (destination) {
    lats.push(destination.lat);
    lngs.push(destination.lng);
  }
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const pad = 18;
  const toXY = (p) => {
    const x = pad + ((p.lng - minLng) / (maxLng - minLng || 1)) * (width - pad * 2);
    const y = pad + (1 - (p.lat - minLat) / (maxLat - minLat || 1)) * (height - pad * 2);
    return [x, y];
  };
  ctx.strokeStyle = "rgba(124, 92, 255, 0.95)";
  ctx.lineWidth = 4;
  ctx.lineJoin = "round";
  ctx.beginPath();
  points.forEach((p, i) => {
    const [x, y] = toXY(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  if (user) {
    const [x, y] = toXY(user);
    ctx.fillStyle = "#5adcff";
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  if (destination) {
    const [x, y] = toXY(destination);
    ctx.fillStyle = "#ff5d8f";
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}

let mapVisible = true;

export function isMapVisible() {
  return mapVisible;
}

export function setMapVisible(visible) {
  mapVisible = Boolean(visible);
  const navigating = document.body.classList.contains("nav-active");
  setHidden($("nav-panel"), !(mapVisible && navigating));
  document.body.classList.toggle("map-closed", navigating && !mapVisible);
}

export function setNavPanel(active, info = {}) {
  document.body.classList.toggle("nav-active", active);
  if (!active) mapVisible = true;
  setHidden($("nav-panel"), !(active && mapVisible));
  document.body.classList.toggle("map-closed", active && !mapVisible);
  if ($("nav-instruction")) $("nav-instruction").textContent = info.instruction || "Follow the route.";
  if ($("nav-meta")) $("nav-meta").textContent = info.meta || "";
  if (active && mapVisible) {
    const mapEl = $("nav-map");
    if (mapEl) mapEl.classList.remove("hidden");
  }
}

export function setCallUI(active, text = "") {
  const overlay = $("call-overlay");
  setHidden(overlay, !active);
  if ($("call-status-text")) $("call-status-text").textContent = text;
  const banner = $("call-banner");
  if (banner) {
    banner.textContent = text;
    banner.classList.toggle("active", Boolean(text) && !overlay);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}
