import { api } from "./api.js";
import { getToken, pages } from "./config.js";
import { voice } from "./voice.js?v=56";

if (!getToken()) location.href = pages().welcome;

const cards = document.getElementById("plan-cards");
const status = document.getElementById("plans-status");
const banner = document.getElementById("plans-banner");
const lede = document.getElementById("plans-lede");

function featureRow(text, ok) {
  return `<li class="${ok ? "is-on" : "is-off"}"><span>${ok ? "✓" : "–"}</span>${text}</li>`;
}

function payLabel(data) {
  if (data.payment_provider === "stripe" && data.payment_ready) return "Pay with Stripe";
  if (data.payment_provider === "paypal" && data.payment_ready) return "Pay with PayPal";
  return "Start Premium";
}

function render(data) {
  const enabled = Boolean(data.subscriptions_enabled);
  const current = data.user_plan || "free";
  if (!enabled) {
    banner.classList.remove("hidden");
    banner.textContent = "Subscriptions are off. Every feature is free for everyone.";
    lede.textContent = "The admin has turned subscriptions off. Describe, Read, detection, calls, and messages are all included.";
  } else {
    banner.classList.add("hidden");
    banner.textContent = "";
    lede.textContent = "Stay free for detection, calls, and messages. Unlock Describe and Read with Premium.";
  }

  cards.innerHTML = (data.plans || [])
    .map((plan) => {
      const isPremium = plan.id === "premium";
      const isCurrent = current === plan.id;
      let action = "";
      if (enabled && isPremium && current !== "premium") {
        const label = payLabel(data);
        action = `<button class="btn plan-cta" data-act="subscribe" type="button">${label} · ${plan.price_label}</button>`;
      } else if (enabled && isPremium && current === "premium") {
        action = `<button class="btn" data-act="cancel" type="button">Back to Free</button>`;
      } else if (!isPremium) {
        action = `<p class="plan-note">${enabled ? "Included with every account" : "Included"}</p>`;
      }
      const badge = isCurrent ? `<span class="plan-badge">${enabled ? "Your plan" : "Included"}</span>` : "";
      return `<article class="plan-card ${isPremium ? "is-premium" : "is-free"} ${isCurrent ? "is-current" : ""}">
        ${badge}
        <p class="plan-name">${plan.name}</p>
        <p class="plan-price">${enabled || !isPremium ? plan.price_label : "Free right now"}</p>
        <p class="plan-tag">${plan.tagline}</p>
        <ul class="plan-features">
          ${plan.features.map((item) => featureRow(item, true)).join("")}
        </ul>
        ${action}
      </article>`;
    })
    .join("");

  cards.querySelectorAll("button[data-act]").forEach((button) => {
    button.onclick = () => handleAction(button.dataset.act);
  });
}

async function handleAction(act) {
  status.textContent = act === "subscribe" ? "Starting payment…" : "Switching to Free…";
  try {
    if (act === "subscribe") {
      const data = await api("/api/billing/subscribe", {
        method: "POST",
        body: { return_url: pages().plans },
      });
      if (data.checkout_url) {
        status.textContent = data.spoken || "Opening payment…";
        await voice.unlock({ fromGesture: true });
        await voice.speak(data.spoken || "Opening payment.");
        location.href = data.checkout_url;
        return;
      }
      render(data);
      status.textContent = data.spoken || "Premium is on.";
      await voice.unlock({ fromGesture: true });
      await voice.speak(status.textContent);
      return;
    }
    const data = await api("/api/billing/cancel", { method: "POST", body: {} });
    render(data);
    const spoken = data.spoken || "You are on the free plan.";
    status.textContent = spoken;
    await voice.unlock({ fromGesture: true });
    await voice.speak(spoken);
  } catch (error) {
    status.textContent = error.message || "I could not update your plan.";
    await voice.speak(status.textContent);
  }
}

async function confirmReturn() {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get("session_id");
  const paypalId = params.get("subscription_id");
  const billing = params.get("billing");
  if (billing === "cancel") {
    history.replaceState({}, "", location.pathname);
    status.textContent = "Payment cancelled. You are still on Free.";
    await voice.speak(status.textContent);
    return false;
  }
  if (sessionId) {
    const data = await api("/api/billing/confirm", {
      method: "POST",
      body: { provider: "stripe", session_id: sessionId },
    });
    history.replaceState({}, "", location.pathname);
    return data;
  }
  if (billing === "paypal" || paypalId) {
    const data = await api("/api/billing/confirm", {
      method: "POST",
      body: { provider: "paypal", subscription_id: paypalId || "" },
    });
    history.replaceState({}, "", location.pathname);
    return data;
  }
  return null;
}

try {
  let data = await api("/api/billing/plans");
  try {
    const confirmed = await confirmReturn();
    if (confirmed) data = confirmed;
  } catch (error) {
    status.textContent = error.message || "I could not confirm that payment.";
  }
  render(data);
  const intro = data.spoken
    ? data.spoken
    : data.subscriptions_enabled
      ? data.user_plan === "premium"
        ? "You are on Premium. Describe and Read are included."
        : `Free includes object detection, video calls, and messages. Premium is ${data.price_label} for Describe and Read.`
      : "Subscriptions are off. Every feature is free.";
  status.textContent = intro;
  voice.unlock();
  voice.speak(intro);
} catch (error) {
  status.textContent = error.message || "I could not load plans.";
}
