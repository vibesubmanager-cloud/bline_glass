export const STATES = {
  IDLE: "IDLE",
  LISTENING: "LISTENING",
  PROCESSING: "PROCESSING",
  SPEAKING: "SPEAKING",
  NAVIGATING: "NAVIGATING",
  CALLING: "CALLING",
  DETECTING: "DETECTING",
  ERROR: "ERROR",
};

class AppState {
  constructor() {
    this.value = STATES.IDLE;
    this.listeners = new Set();
    this.lastSpoken = "";
    this.busyController = null;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(next) {
    this.value = next;
    this.listeners.forEach((fn) => fn(next));
  }

  canStartRequest() {
    return [STATES.IDLE, STATES.SPEAKING, STATES.NAVIGATING, STATES.DETECTING, STATES.ERROR].includes(this.value);
  }

  beginRequest() {
    if (this.busyController) this.busyController.abort();
    this.busyController = new AbortController();
    this.set(STATES.PROCESSING);
    return this.busyController.signal;
  }
}

export const appState = new AppState();
