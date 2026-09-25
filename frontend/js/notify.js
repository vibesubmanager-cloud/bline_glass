import { loadUnread } from "./messages.js";

const heard = new Set();

function bannerEl() {
  let el = document.getElementById("notify-banner");
  if (el) return el;
  el = document.createElement("div");
  el.id = "notify-banner";
  el.className = "notify-banner hidden";
  el.setAttribute("role", "status");
  document.body.appendChild(el);
  return el;
}

function showBanner(text, href) {
  const el = bannerEl();
  el.innerHTML = href ? `<a href="${href}">${text}</a>` : text;
  el.classList.remove("hidden");
}

export async function startMessageNotices({ speak, href = "./contacts.html" } = {}) {
  const tick = async () => {
    try {
      const data = await loadUnread();
      for (const item of data.messages || []) {
        const id = item.message?.id;
        if (!id || heard.has(id)) continue;
        heard.add(id);
        const text = item.spoken || `New message from ${item.from_name || "your group"}.`;
        showBanner(text, href);
        try {
          if (window.Notification && Notification.permission === "granted") {
            new Notification("AI Sight", { body: text, tag: id });
          }
        } catch {
          /* ignore */
        }
        if (speak) {
          try {
            await speak(text);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* keep the page usable */
    }
  };
  try {
    if (window.Notification && Notification.permission === "default") {
      Notification.requestPermission().catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
  tick();
  setInterval(tick, 5000);
}
