(function () {
  function readRaw(key) {
    try {
      return localStorage.getItem(key) || sessionStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function tokenExpired(token) {
    var part = String(token || "").split(".")[1];
    if (!part) return true;
    try {
      var json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
      if (!json || !json.exp) return false;
      return Date.now() >= Number(json.exp) * 1000 - 5000;
    } catch (error) {
      return true;
    }
  }

  function clearStoredSession() {
    ["VIBE_EYE_TOKEN", "VIBE_EYE_USER", "VIBE_EYE_SETTINGS", "VIBE_EYE_LINKED_BLIND", "AISIGHT_DEVICE_READY", "AISIGHT_GPS_OK"].forEach(function (key) {
      try {
        localStorage.removeItem(key);
        sessionStorage.removeItem(key);
      } catch (error) {
        /* storage can be blocked */
      }
    });
    try {
      sessionStorage.removeItem("NYOTA_PRIVACY_REQUIRED");
    } catch (error) {
      /* session storage is optional */
    }
  }

  var path = String(location.pathname || "");
  if (!/\/admin/i.test(path)) {
    var token = readRaw("VIBE_EYE_TOKEN");
    if (token && tokenExpired(token)) {
      var role = "blind";
      try {
        role = (JSON.parse(readRaw("VIBE_EYE_USER") || "{}") || {}).role === "assistant" ? "assistant" : "blind";
      } catch (error) {
        role = "blind";
      }
      clearStoredSession();
      try {
        sessionStorage.setItem("NYOTA_JUST_SIGNED_OUT", "1");
      } catch (error) {
        /* session storage is optional */
      }
      if (!/\/(?:login|register|register-assistant|welcome|how-to-use)\.html$/i.test(path)) {
        location.replace("./login.html?role=" + role);
      }
    }
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      try {
        sessionStorage.setItem("NYOTA_LEFT_APP", "1");
      } catch (error) {
        /* session storage is optional */
      }
    }
  });
})();
