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
})();
