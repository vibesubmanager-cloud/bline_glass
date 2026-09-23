import { api } from "./api.js";
import { voice } from "./voice.js?v=51";
import { appState, STATES } from "./state.js";
import { getCurrentPosition, requestLocationAccess, locationPermissionState, watchPosition } from "./location.js";

export { getCurrentPosition, requestLocationAccess, locationPermissionState };

const OFF_ROUTE_METERS = 45;
const ANNOUNCE_METERS = 35;

function toRad(value) {
  return (value * Math.PI) / 180;
}

export function distanceMeters(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function formatDistance(meters) {
  if (meters == null || Number.isNaN(meters)) return null;
  if (meters < 10) return "a few meters";
  if (meters < 1000) return `${Math.round(meters)} meters`;
  const km = meters / 1000;
  return km < 10 ? `${km.toFixed(1)} kilometers` : `${Math.round(km)} kilometers`;
}

class NavigationController {
  constructor() {
    this._watch = null;
    this.session = null;
    this.route = null;
    this.stepIndex = 0;
    this.lastInstruction = "";
    this.lastAnnouncedStep = -1;
  }

  get active() {
    return Boolean(this.session);
  }

  nextInstruction() {
    const step = this.route?.steps?.[this.stepIndex];
    return step?.instruction || this.lastInstruction || "I don't have a next instruction yet.";
  }

  remainingDistance(position) {
    const dest = this.session ? { lat: this.session.destination_lat, lng: this.session.destination_lng } : null;
    if (!position || !dest) return null;
    return distanceMeters(position, dest);
  }

  briefStatus() {
    if (!this.session) return "You are not navigating right now.";
    const name = this.session.destination_name || "your destination";
    const remaining = this.remainingDistance(this._lastHere);
    const next = this.nextInstruction();
    const parts = [`The map is taking you to ${name}.`];
    if (remaining != null) parts.push(`About ${formatDistance(remaining)} remaining.`);
    if (next) parts.push(`Next, ${next.replace(/^In /, "in ")}`);
    return parts.join(" ");
  }

  async start(destination) {
    await voice.speak("Calculating route.");
    const pos = await getCurrentPosition();
    const data = await api("/api/navigation/start", {
      method: "POST",
      timeout: 25000,
      body: {
        destination,
        origin_lat: pos.coords.latitude,
        origin_lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      },
    });
    this.session = data.session;
    this.route = data.route;
    this.stepIndex = 0;
    this.lastInstruction = data.spoken;
    this.lastAnnouncedStep = 0;
    this._lastHere = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    appState.set(STATES.NAVIGATING);
    this.watch();
    this.emitChange();
    return data.spoken;
  }

  watch() {
    this.stopWatch();
    this._watch = watchPosition(
      (pos) => this.onPosition(pos).catch(() => undefined),
      () => undefined
    );
  }

  async onPosition(pos) {
    if (!this.route || !this.session) return;
    const here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (pos.coords.accuracy > 50 && !this._warnedAccuracy) {
      this._warnedAccuracy = true;
      await voice.speak("GPS accuracy is poor, so directions may be less precise.");
    }
    const dest = { lat: this.session.destination_lat, lng: this.session.destination_lng };
    if (distanceMeters(here, dest) < 18) {
      await this.arrive();
      return;
    }
    const steps = this.route.steps || [];
    const current = steps[this.stepIndex];
    if (current?.lat != null) {
      const toStep = distanceMeters(here, { lat: current.lat, lng: current.lng });
      if (toStep < ANNOUNCE_METERS && this.lastAnnouncedStep !== this.stepIndex) {
        this.lastAnnouncedStep = this.stepIndex;
        this.lastInstruction = current.instruction;
        await voice.speak(current.instruction);
      }
      if (toStep < 12 && this.stepIndex < steps.length - 1) {
        this.stepIndex += 1;
      }
    }
    const nearest = steps.reduce((best, step, idx) => {
      if (step.lat == null) return best;
      const d = distanceMeters(here, { lat: step.lat, lng: step.lng });
      return d < best.distance ? { idx, distance: d } : best;
    }, { idx: this.stepIndex, distance: Infinity });
    if (nearest.distance > OFF_ROUTE_METERS) {
      await this.recalculate(here);
    }
    this._lastHere = here;
    this.emitChange();
  }

  emitChange() {
    if (typeof this.onChange === "function") {
      const dest = this.session
        ? { lat: this.session.destination_lat, lng: this.session.destination_lng, name: this.session.destination_name }
        : null;
      this.onChange({
        active: this.active,
        session: this.session,
        route: this.route,
        instruction: this.nextInstruction(),
        user: this._lastHere || null,
        destination: dest,
      });
    }
  }

  async recalculate(here) {
    if (!this.session) return;
    const data = await api("/api/navigation/recalculate", {
      method: "POST",
      body: {
        session_id: this.session.id,
        origin_lat: here.lat,
        origin_lng: here.lng,
      },
    });
    this.route = data.route;
    this.session = data.session;
    this.stepIndex = 0;
    this.lastInstruction = data.spoken;
    this.emitChange();
    await voice.speak(data.spoken);
  }

  async arrive() {
    await voice.speak("You have arrived. Your destination is nearby.");
    await this.stop(false);
  }

  async stop(announce = true) {
    this.stopWatch();
    if (this.session) {
      try {
        await api("/api/navigation/stop", { method: "POST", body: { session_id: this.session.id } });
      } catch {
        /* still stop locally */
      }
    }
    this.session = null;
    this.route = null;
    appState.set(STATES.IDLE);
    this.emitChange();
    if (announce) await voice.speak("Navigation stopped.");
  }

  stopWatch() {
    this._watch?.clear?.();
    this._watch = null;
  }

  async whereAmI() {
    const pos = await getCurrentPosition();
    const data = await api("/api/navigation/where", {
      method: "POST",
      body: { lat: pos.coords.latitude, lng: pos.coords.longitude },
    });
    return data.spoken;
  }
}

export const navigation = new NavigationController();
