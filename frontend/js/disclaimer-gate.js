(function () {
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      try {
        sessionStorage.setItem("NYOTA_LEFT_APP", "1");
      } catch (error) {
        /* session storage is optional */
      }
    }
  });
  var KEY = "NYOTA_DISCLAIMER_AGREED_AT";
  var agreed = "";
  try {
    agreed = localStorage.getItem(KEY) || "";
  } catch (error) {
    agreed = "";
  }
  if (agreed) return;
  var path = String(location.pathname || "").replace(/\\/g, "/");
  if (/disclaimer\.html$/i.test(path)) return;
  var inPages = /\/pages\//i.test(path);
  location.replace(inPages ? "./disclaimer.html" : "./pages/disclaimer.html");
})();
