import { getApiBase } from "./config.js";

const TOKEN_KEY = "AISIGHT_ADMIN_TOKEN";

function isLoginPage() {
  return location.pathname.includes("admin-login");
}

function token() {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

function setToken(value) {
  if (value) sessionStorage.setItem(TOKEN_KEY, value);
  else sessionStorage.removeItem(TOKEN_KEY);
}

function statusEl() {
  return document.getElementById("status");
}

function showStatus(message, ok = false) {
  const el = statusEl();
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("ok", Boolean(ok) && Boolean(message));
}

async function adminApi(path, { method = "GET", body, isForm = false } = {}) {
  const headers = {};
  if (token()) headers.Authorization = `Bearer ${token()}`;
  if (!isForm && body !== undefined) headers["Content-Type"] = "application/json";
  const url = `${getApiBase()}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the API. Wait a few seconds if Render is waking, then try again.");
  }
  const payload = await response.json().catch(() => null);
  if (response.status === 401) {
    setToken("");
    if (!isLoginPage()) location.replace("./admin-login.html");
  }
  if (!payload || !payload.success) {
    throw new Error(payload?.error?.message || "Request failed.");
  }
  return payload.data;
}

function usageLabel(eventType) {
  const map = {
    USER_LOGIN: "Signed in",
    USER_REGISTERED: "Created account",
    VISION_DESCRIBE: "Described a scene",
    VISION_READ: "Read a page",
    VISION_QUESTION: "Asked about a photo",
    MESSAGE_SENT: "Sent a message",
    EMERGENCY: "Emergency",
  };
  return map[eventType] || eventType.replace(/_/g, " ").toLowerCase();
}

function bindLogin() {
  const form = document.getElementById("login-form");
  if (!form) return;
  if (token()) {
    location.replace("./admin.html");
    return;
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showStatus("Signing in…");
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const result = await adminApi("/api/admin/login", { method: "POST", body: data });
      setToken(result.token);
      location.replace("./admin.html");
    } catch (error) {
      showStatus(error.message);
    }
  });
}

function peopleHtml(detail) {
  const user = detail.user || {};
  const parts = [];
  if (user.system_id) parts.push(`<p><strong>System ID:</strong> ${user.system_id}</p>`);
  if (detail.linked_blind) {
    parts.push(
      `<p><strong>Helps:</strong> ${detail.linked_blind.name} (${detail.linked_blind.system_id || "no ID"})</p>`
    );
  }
  if (detail.assistants?.length) {
    parts.push("<p><strong>Assistants</strong></p><ul>");
    for (const helper of detail.assistants) {
      parts.push(
        `<li>${helper.name} · @${helper.username || "—"} · ${helper.relationship_to_blind || "assistant"} · ${helper.phone || helper.email}</li>`
      );
    }
    parts.push("</ul>");
  }
  if (detail.contacts?.length) {
    parts.push("<p><strong>Contacts</strong></p><ul>");
    for (const contact of detail.contacts) {
      parts.push(
        `<li>${contact.name} · ${contact.relationship || "contact"} · ${contact.phone || "no phone"}${contact.is_emergency_contact ? " · emergency" : ""}</li>`
      );
    }
    parts.push("</ul>");
  }
  if (!detail.assistants?.length && !detail.contacts?.length && !detail.linked_blind) {
    parts.push("<p class='muted'>No linked people yet.</p>");
  }
  return parts.join("") || "<p class='muted'>No linked people yet.</p>";
}

function usageHtml(detail) {
  const counts = detail.usage_counts || {};
  const lines = Object.entries(counts).map(
    ([name, count]) => `<li>${usageLabel(name)}: ${count}</li>`
  );
  const recent = (detail.usage || [])
    .slice(0, 12)
    .map((item) => `<li>${usageLabel(item.event_type)} · ${item.created_at || ""}</li>`);
  return `
    <p><strong>Totals</strong></p>
    <ul>${lines.join("") || "<li class='muted'>No activity yet.</li>"}</ul>
    <p><strong>Recent</strong></p>
    <ul>${recent.join("") || "<li class='muted'>No activity yet.</li>"}</ul>
  `;
}

async function openThread(userId, peerId) {
  const box = document.getElementById("thread-box");
  box.innerHTML = "<p class='muted'>Loading messages…</p>";
  const data = await adminApi(`/api/admin/users/${userId}/messages?with=${encodeURIComponent(peerId)}`);
  box.innerHTML = (data.messages || [])
    .map((message) => {
      const outgoing = message.sender_id === userId;
      const body = message.body || (message.has_media ? "[photo or voice]" : "[empty]");
      return `<div class="bubble ${outgoing ? "out" : ""}"><strong>${outgoing ? "Them" : data.peer.name}:</strong> ${body}<div class="muted">${message.created_at || ""}</div></div>`;
    })
    .join("") || "<p class='muted'>No messages in this conversation.</p>";
}

async function showUser(userId) {
  showStatus("Loading user…");
  const detail = await adminApi(`/api/admin/users/${userId}`);
  const user = detail.user;
  document.getElementById("users-home").classList.add("hidden");
  document.getElementById("user-detail").classList.remove("hidden");
  document.getElementById("detail-title").textContent = `${user.name} · ${user.role}`;
  const form = document.getElementById("user-form");
  form.first_name.value = user.first_name || "";
  form.last_name.value = user.last_name || "";
  form.username.value = user.username || "";
  form.email.value = user.email || "";
  form.phone.value = user.phone || "";
  form.password.value = "";
  form.health_notes.value = user.health_notes || "";
  form.other_notes.value = user.other_notes || "";
  form.is_active.checked = user.is_active !== false;
  form.dataset.userId = user.id;
  document.getElementById("people-box").innerHTML = peopleHtml(detail);
  const threads = document.getElementById("threads-box");
  threads.innerHTML = (detail.conversations || [])
    .map(
      (item) =>
        `<div class="row-actions"><button class="btn ghost small" data-peer="${item.peer.id}" type="button">View messages with ${item.peer.name}</button><span class="muted">${item.last_message?.body || ""}</span></div>`
    )
    .join("") || "<p class='muted'>No messages yet.</p>";
  threads.querySelectorAll("button[data-peer]").forEach((button) => {
    button.onclick = () => openThread(user.id, button.dataset.peer).catch((error) => showStatus(error.message));
  });
  document.getElementById("thread-box").innerHTML = "";
  document.getElementById("usage-box").innerHTML = usageHtml(detail);
  showStatus("");
}

async function loadUsers() {
  const q = document.getElementById("user-search")?.value || "";
  const role = document.getElementById("user-role")?.value || "";
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (role) params.set("role", role);
  const data = await adminApi(`/api/admin/users?${params.toString()}`);
  const body = document.getElementById("users-table");
  body.innerHTML = (data.users || [])
    .map(
      (user) => `<tr>
        <td>${user.name}</td>
        <td>${user.username || ""}</td>
        <td><span class="chip">${user.role}</span></td>
        <td>${user.email}</td>
        <td>${user.phone || ""}</td>
        <td>${user.system_id || ""}</td>
        <td><button class="btn ghost small" data-id="${user.id}" type="button">View</button></td>
      </tr>`
    )
    .join("");
  body.querySelectorAll("button[data-id]").forEach((button) => {
    button.onclick = () => showUser(button.dataset.id).catch((error) => showStatus(error.message));
  });
}

let cachedKeys = { gemini: [], groq: [] };

function fillKeySelect(selectId, rows, emptyLabel) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const current = select.value;
  select.innerHTML = "";
  if (!rows.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.appendChild(option);
    return;
  }
  for (const item of rows) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.label} (${item.hint}${item.is_active ? "" : ", off"})`;
    select.appendChild(option);
  }
  if (current && [...select.options].some((item) => item.value === current)) {
    select.value = current;
  }
}

function showSection(name) {
  document.querySelectorAll(".nav-btn").forEach((item) => {
    item.classList.toggle("active", item.dataset.section === name);
  });
  document.getElementById("section-users").classList.toggle("hidden", name !== "users");
  document.getElementById("section-keys").classList.toggle("hidden", name !== "keys");
  document.getElementById("section-test").classList.toggle("hidden", name !== "test");
  if (name === "keys" || name === "test") {
    return loadKeys().catch((error) => showStatus(error.message));
  }
}

function keyRow(item) {
  const working = item.last_ok_at && !item.last_error ? "Working" : item.last_error || "Not tested";
  return `<div class="key-row">
    <div>
      <strong>${item.label}</strong>
      <div><code>${item.hint}</code> · ${item.is_active ? "active" : "off"}</div>
      <div class="muted">${working}</div>
    </div>
    <div class="row-actions">
      <button class="btn ghost small" data-act="test" data-id="${item.id}" data-provider="${item.provider}" type="button">Test</button>
      <button class="btn ghost small" data-act="toggle" data-id="${item.id}" data-active="${item.is_active ? "1" : "0"}" type="button">${item.is_active ? "Turn off" : "Turn on"}</button>
      <button class="btn danger small" data-act="delete" data-id="${item.id}" type="button">Remove</button>
    </div>
  </div>`;
}

async function loadKeys() {
  const data = await adminApi("/api/admin/keys");
  cachedKeys = data.keys || { gemini: [], groq: [] };
  document.querySelectorAll("[data-provider]").forEach((card) => {
    const provider = card.dataset.provider;
    const list = card.querySelector(".key-list");
    if (!list) return;
    const rows = cachedKeys[provider] || [];
    list.innerHTML = rows.map(keyRow).join("") || "<p class='muted'>No keys yet.</p>";
    list.querySelectorAll("button[data-act]").forEach((button) => {
      button.onclick = () => handleKeyAction(button).catch((error) => showStatus(error.message));
    });
  });
  fillKeySelect("gemini-test-key", cachedKeys.gemini || [], "Save a Gemini key first");
  fillKeySelect("text-test-key", cachedKeys.groq || [], "Save a Groq key first");
}

async function handleKeyAction(button) {
  const id = button.dataset.id;
  const act = button.dataset.act;
  if (act === "test") {
    await showSection("test");
    const selectId = button.dataset.provider === "groq" ? "text-test-key" : "gemini-test-key";
    const select = document.getElementById(selectId);
    if (select) select.value = id;
    showStatus(button.dataset.provider === "groq" ? "Send hi below to test this key." : "Upload a photo below to test this Gemini key.");
    return;
  }
  if (act === "toggle") {
    await adminApi(`/api/admin/keys/${id}`, {
      method: "PUT",
      body: { is_active: button.dataset.active !== "1" },
    });
    await loadKeys();
    return;
  }
  if (act === "delete" && confirm("Remove this API key?")) {
    await adminApi(`/api/admin/keys/${id}`, { method: "DELETE" });
    await loadKeys();
  }
}

function bindDashboard() {
  if (isLoginPage()) return;
  if (!token()) {
    location.replace("./admin-login.html");
    return;
  }
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.onclick = () => showSection(button.dataset.section);
  });
  document.getElementById("sign-out").onclick = () => {
    setToken("");
    location.replace("./admin-login.html");
  };
  document.getElementById("refresh-users").onclick = () => loadUsers().catch((error) => showStatus(error.message));
  document.getElementById("user-search").onkeydown = (event) => {
    if (event.key === "Enter") loadUsers().catch((error) => showStatus(error.message));
  };
  document.getElementById("user-role").onchange = () => loadUsers().catch((error) => showStatus(error.message));
  document.getElementById("back-users").onclick = () => {
    document.getElementById("user-detail").classList.add("hidden");
    document.getElementById("users-home").classList.remove("hidden");
    loadUsers().catch((error) => showStatus(error.message));
  };
  document.getElementById("user-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form).entries());
    body.is_active = form.is_active.checked;
    if (!body.password) delete body.password;
    showStatus("Saving…");
    try {
      await adminApi(`/api/admin/users/${form.dataset.userId}`, { method: "PUT", body });
      await showUser(form.dataset.userId);
      showStatus("Account saved.", true);
    } catch (error) {
      showStatus(error.message);
    }
  };
  document.querySelectorAll(".key-form").forEach((form) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      const provider = form.closest("[data-provider]").dataset.provider;
      const body = Object.fromEntries(new FormData(form).entries());
      body.provider = provider;
      showStatus("Saving key…");
      try {
        await adminApi("/api/admin/keys", { method: "POST", body });
        form.reset();
        await loadKeys();
        showStatus("API key saved. Only the last four characters are shown.", true);
      } catch (error) {
        showStatus(error.message);
      }
    };
  });
  const preview = document.getElementById("gemini-test-preview");
  document.getElementById("gemini-test-image").onchange = (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      preview.classList.add("hidden");
      preview.removeAttribute("src");
      return;
    }
    preview.src = URL.createObjectURL(file);
    preview.classList.remove("hidden");
  };
  document.getElementById("gemini-test-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const keyId = document.getElementById("gemini-test-key").value;
    const file = document.getElementById("gemini-test-image").files[0];
    const reply = document.getElementById("gemini-test-reply");
    if (!keyId) {
      showStatus("Save a Gemini key first, then test it.");
      return;
    }
    if (!file) {
      showStatus("Choose a photo to test Gemini.");
      return;
    }
    const payload = new FormData();
    payload.append("image", file);
    const question = (form.text.value || "").trim();
    if (question) payload.append("text", question);
    reply.textContent = "Testing Gemini with this photo…";
    showStatus("Testing Gemini…");
    try {
      const result = await adminApi(`/api/admin/keys/${keyId}/test`, { method: "POST", body: payload, isForm: true });
      reply.textContent = result.reply || (result.ok ? "Gemini answered." : "Gemini did not answer.");
      showStatus(result.ok ? `Gemini replied in ${result.ms || "?"} ms.` : result.reply, result.ok);
      await loadKeys();
    } catch (error) {
      reply.textContent = error.message;
      showStatus(error.message);
    }
  };
  document.getElementById("text-test-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const keyId = document.getElementById("text-test-key").value;
    const reply = document.getElementById("text-test-reply");
    if (!keyId) {
      showStatus("Save a Groq key first, then test it.");
      return;
    }
    reply.textContent = "Testing reply…";
    showStatus("Testing text reply…");
    try {
      const result = await adminApi(`/api/admin/keys/${keyId}/test`, {
        method: "POST",
        body: { text: form.text.value || "hi" },
      });
      reply.textContent = result.reply || (result.ok ? "It replied." : "No reply.");
      showStatus(result.ok ? `Reply came back in ${result.ms || "?"} ms.` : result.reply, result.ok);
      await loadKeys();
    } catch (error) {
      reply.textContent = error.message;
      showStatus(error.message);
    }
  };
  loadUsers().catch((error) => showStatus(error.message));
}

bindLogin();
bindDashboard();
