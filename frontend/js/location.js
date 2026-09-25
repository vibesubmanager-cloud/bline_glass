/** Phone GPS for Safari, Chrome, home-screen PWA, and later App Store / Play Store wraps. */

export function isStandaloneApp() {
  return Boolean(window.navigator.standalone) || window.matchMedia("(display-mode: standalone)").matches;
}

export function isNativeWrap() {
  try {
    return Boolean(window.Capacitor?.isNativePlatform?.() || window.Capacitor?.Plugins?.Geolocation);
  } catch {
    return false;
  }
}

function capacitorGeo() {
  return window.Capacitor?.Plugins?.Geolocation || null;
}

function fail(code, message, cause) {
  return Object.assign(new Error(message), { code, cause });
}

function permissionHelp(kind) {
  const home = isStandaloneApp();
  if (kind === "denied") {
    if (home) {
      return "This home screen app has its own location switch. On iPhone: Settings, scroll down to vibeEye, tap Location, choose While Using the App, then open the app again.";
    }
    return "On iPhone: Settings → Privacy & Security → Location Services must be On. Then Settings → Safari → Location → Allow. If you added this to the home screen, use Settings → vibeEye → Location instead of Safari.";
  }
  if (kind === "timeout") {
    return "GPS timed out. Keep Location Services on, stand near a window, and tap Allow location again.";
  }
  return "I could not read GPS yet. Turn on Location Services and Precise Location, then tap Allow location again.";
}

function fromWebError(err) {
  const code = err?.code;
  if (code === 1) return fail("GPS_DENIED", permissionHelp("denied"), err);
  if (code === 3) return fail("GPS_UNAVAILABLE", permissionHelp("timeout"), err);
  return fail("GPS_UNAVAILABLE", permissionHelp("unavailable"), err);
}

function asPosition(coords) {
  return {
    coords: {
      latitude: Number(coords.latitude),
      longitude: Number(coords.longitude),
      accuracy: Number(coords.accuracy || 0),
    },
  };
}

async function fromCapacitor() {
  const Geo = capacitorGeo();
  if (!Geo) return null;
  if (Geo.requestPermissions) {
    const perm = await Geo.requestPermissions();
    const state = perm?.location || perm?.coarseLocation;
    if (state && state !== "granted" && state !== "prompt") {
      throw fail("GPS_DENIED", permissionHelp("denied"));
    }
  }
  const pos = await Geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 25000 });
  return asPosition(pos.coords);
}

function webOnce(options) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(fail("GPS_UNAVAILABLE", "This browser cannot read GPS."));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

function webWatchOnce(options, waitMs) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(fail("GPS_UNAVAILABLE", "This browser cannot read GPS."));
      return;
    }
    let settled = false;
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        if (settled) return;
        settled = true;
        navigator.geolocation.clearWatch(watchId);
        resolve(pos);
      },
      (err) => {
        if (settled) return;
        if (err?.code === 3) return;
        settled = true;
        navigator.geolocation.clearWatch(watchId);
        reject(err);
      },
      options
    );
    setTimeout(() => {
      if (settled) return;
      settled = true;
      navigator.geolocation.clearWatch(watchId);
      reject(Object.assign(new Error("timeout"), { code: 3 }));
    }, waitMs);
  });
}

export async function getCurrentPosition() {
  if (!isNativeWrap() && !window.isSecureContext) {
    throw fail(
      "INSECURE_CONTEXT",
      "Open the https Safari address, then Add to Home Screen from that https page. Location does not work on http."
    );
  }
  try {
    const native = await fromCapacitor();
    if (native) return native;
  } catch (error) {
    if (isNativeWrap()) throw fromWebError(error);
  }
  const attempts = [
    () => webOnce({ enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }),
    () => webWatchOnce({ enableHighAccuracy: false, timeout: 20000, maximumAge: 15000 }, 12000),
    () => webOnce({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }),
    () => webWatchOnce({ enableHighAccuracy: true, timeout: 25000, maximumAge: 0 }, 22000),
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
    }
  }
  throw fromWebError(lastError);
}

export function requestLocationAccess() {
  return getCurrentPosition();
}

export async function locationPermissionState() {
  try {
    const Geo = capacitorGeo();
    if (Geo?.checkPermissions) {
      const perm = await Geo.checkPermissions();
      return perm?.location || "unknown";
    }
    if (navigator.permissions?.query) {
      const status = await navigator.permissions.query({ name: "geolocation" });
      return status.state;
    }
  } catch {
    /* iPhone often hides this */
  }
  return "unknown";
}

export function watchPosition(onPos, onErr) {
  const Geo = capacitorGeo();
  if (Geo?.watchPosition) {
    const handle = Geo.watchPosition({ enableHighAccuracy: true }, (pos, err) => {
      if (err) onErr?.(err);
      else if (pos?.coords) onPos(asPosition(pos.coords));
    });
    return {
      clear() {
        Promise.resolve(handle).then((id) => Geo.clearWatch?.({ id })).catch(() => undefined);
      },
    };
  }
  if (!navigator.geolocation) {
    onErr?.(fail("GPS_UNAVAILABLE", "This browser cannot read GPS."));
    return { clear() {} };
  }
  const id = navigator.geolocation.watchPosition(
    onPos,
    (err) => onErr?.(fromWebError(err)),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }
  );
  return {
    clear() {
      navigator.geolocation.clearWatch(id);
    },
  };
}
