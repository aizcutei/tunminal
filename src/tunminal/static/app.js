// Tunminal Client Application
(function () {
  let token = "";
  let currentSessionId = null;
  let activeSocket = null;
  let term = null;
  let fitAddon = null;
  let isCtrlActive = false;
  let isAltActive = false;
  let reconnectTimer = null;
  let pingInterval = null;
  let sessionPollTimer = null;
  let toastTimer = null;

  // DOM Elements
  const statusEl = document.getElementById("connection-status");
  const tabsBar = document.getElementById("tabs-bar");
  const termContainer = document.getElementById("terminal-container");
  const mobileKeypad = document.getElementById("mobile-keypad");
  const newSessionModal = document.getElementById("new-session-modal");
  const sessionsModal = document.getElementById("sessions-modal");
  const textInputModal = document.getElementById("text-input-modal");
  const authModal = document.getElementById("auth-modal");
  const modCtrlBtn = document.getElementById("mod-ctrl");
  const modAltBtn = document.getElementById("mod-alt");
  const sessionsBadge = document.getElementById("sessions-badge");
  const toastEl = document.getElementById("toast");

  // 1. Authentication & Token Initialization
  function initAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    const queryToken = urlParams.get("token");
    if (queryToken) {
      token = queryToken;
      localStorage.setItem("tunminal_token", token);
      // Clean up token from browser URL address bar for cleanliness
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    } else {
      token = localStorage.getItem("tunminal_token") || "";
    }

    if (!token) {
      authModal.showModal();
    } else {
      startApp();
    }
  }

  document.getElementById("auth-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const inputToken = document.getElementById("auth-token-input").value.trim();
    if (inputToken) {
      token = inputToken;
      localStorage.setItem("tunminal_token", token);
      authModal.close();
      startApp();
    }
  });

  // 2. Main Application Flow
  async function startApp() {
    initTerminal();
    setupViewportHandler();
    setupKeypad();
    setupSessionsManager();
    await loadPresetsAndInfo();
    await refreshSessions();

    // Start background poll to keep session states and tabs updated
    if (sessionPollTimer) clearInterval(sessionPollTimer);
    sessionPollTimer = setInterval(refreshSessionsBackground, 8000);

    // Refresh when browser tab regains focus
    window.addEventListener("focus", () => {
      refreshSessionsBackground();
    });
  }

  // 3. Terminal Setup
  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 14,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#0a0c10",
        foreground: "#f0f6fc",
        cursor: "#58a6ff",
        cursorAccent: "#0a0c10",
        selectionBackground: "rgba(88, 166, 255, 0.3)",
      },
      scrollback: 5000,
      allowTransparency: false,
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);
    fitAddon.fit();

    // Send terminal user input to WebSocket
    term.onData((data) => {
      sendTerminalInput(data);
    });

    // Window resize handler
    window.addEventListener("resize", () => {
      if (fitAddon) {
        fitAddon.fit();
        notifyTerminalResize();
      }
    });
  }

  // Mobile Visual Viewport Adjustment (for on-screen soft keyboard)
  function setupViewportHandler() {
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        const app = document.getElementById("app");
        app.style.height = `${window.visualViewport.height}px`;
        if (fitAddon) {
          fitAddon.fit();
          notifyTerminalResize();
        }
      });
      window.visualViewport.addEventListener("scroll", () => {
        // Prevent unwanted viewport scrolling when keyboard opens
        window.scrollTo(0, 0);
      });
    }
  }

  function notifyTerminalResize() {
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN && term) {
      activeSocket.send(
        JSON.stringify({
          type: "resize",
          cols: term.cols,
          rows: term.rows,
        })
      );
    }
  }

  function sendTerminalInput(data) {
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(data);
    }
  }

  // 4. API Calls with Auth
  async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    options.headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(endpoint, options);
    if (res.status === 401) {
      authModal.showModal();
      throw new Error("Unauthorized");
    }
    return res;
  }

  async function loadPresetsAndInfo() {
    try {
      const res = await apiFetch("/api/info");
      const info = await res.json();
      const claudeBtn = document.getElementById("preset-claude");
      const codexBtn = document.getElementById("preset-codex");
      if (info.presets) {
        if (!info.presets.claude) {
          claudeBtn.style.opacity = "0.6";
          claudeBtn.title = "claude CLI not detected in PATH, but can still run if installed in environment";
        }
        if (!info.presets.codex) {
          codexBtn.style.opacity = "0.6";
          codexBtn.title = "codex CLI not detected in PATH, but can still run if installed in environment";
        }
      }
    } catch (e) {
      console.warn("Failed to fetch info:", e);
    }
  }

  // 5. Session Management & Reconnection
  async function refreshSessions() {
    try {
      const res = await apiFetch("/api/sessions");
      const sessions = await res.json();
      renderTabs(sessions);
      updateBadge(sessions.length);

      if (sessions.length > 0) {
        // Check saved session in localStorage to pick up old still running terminal!
        const savedSessionId = localStorage.getItem("tunminal_active_session");
        const sessionToPick =
          sessions.find((s) => s.id === currentSessionId) ||
          sessions.find((s) => s.id === savedSessionId) ||
          sessions.find((s) => s.alive) ||
          sessions[0];

        if (sessionToPick && sessionToPick.id !== currentSessionId) {
          const wasResumed = savedSessionId === sessionToPick.id;
          switchSession(sessionToPick.id);
          if (wasResumed) {
            showToast(`Resumed running terminal: ${sessionToPick.name} (PID ${sessionToPick.pid || "-"})`);
          }
        }
      } else {
        // Create initial default session
        await createNewSession("shell", "Terminal");
      }
    } catch (e) {
      console.error("Error loading sessions:", e);
    }
  }

  async function refreshSessionsBackground() {
    try {
      const res = await apiFetch("/api/sessions");
      const sessions = await res.json();
      renderTabs(sessions);
      updateBadge(sessions.length);
      if (sessionsModal && sessionsModal.open) {
        renderSessionsModalList(sessions);
      }
    } catch (e) {
      // Ignore background poll errors
    }
  }

  function updateBadge(count) {
    if (sessionsBadge) {
      sessionsBadge.textContent = count;
    }
  }

  function renderTabs(sessions) {
    tabsBar.innerHTML = "";
    sessions.forEach((s) => {
      const tab = document.createElement("div");
      tab.className = `tab-item ${s.id === currentSessionId ? "active" : ""}`;
      tab.dataset.id = s.id;
      tab.title = `Command: ${s.command || "shell"} | PID: ${s.pid || "-"} | Status: ${s.alive ? "Running in background" : "Exited"}`;
      tab.innerHTML = `
        <span class="status-dot ${s.alive ? "alive" : "dead"}"></span>
        <span>${escapeHtml(s.name || s.id)}</span>
        <span class="tab-close" title="Close / Terminate Session">✕</span>
      `;
      tab.addEventListener("click", (e) => {
        if (e.target.classList.contains("tab-close")) {
          e.stopPropagation();
          closeSession(s.id);
        } else {
          switchSession(s.id);
        }
      });
      tabsBar.appendChild(tab);
    });
  }

  async function createNewSession(command, name) {
    try {
      const res = await apiFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: command,
          name: name,
          cols: term ? term.cols : 80,
          rows: term ? term.rows : 24,
        }),
      });
      const session = await res.json();
      await refreshSessions();
      switchSession(session.id);
      showToast(`Started terminal: ${session.name}`);
    } catch (e) {
      console.error("Error creating session:", e);
    }
  }

  async function closeSession(sessionId) {
    if (!confirm("Are you sure you want to terminate this terminal session?")) return;
    try {
      await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (currentSessionId === sessionId) {
        currentSessionId = null;
        localStorage.removeItem("tunminal_active_session");
      }
      await refreshSessions();
    } catch (e) {
      console.error("Error closing session:", e);
    }
  }

  // 6. WebSocket Connection & Switching
  function switchSession(sessionId) {
    if (currentSessionId === sessionId && activeSocket) return;
    currentSessionId = sessionId;
    // Persist active session in localStorage so closing and reopening picks it up!
    localStorage.setItem("tunminal_active_session", sessionId);

    if (activeSocket) {
      activeSocket.close();
      activeSocket = null;
    }
    if (term) {
      term.reset();
    }

    // Update tab bar active class using dataset.id
    document.querySelectorAll(".tab-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.id === sessionId);
    });

    connectWebSocket(sessionId);
  }

  function connectWebSocket(sessionId) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }

    statusEl.className = "status-badge connecting";
    statusEl.title = "Connecting...";

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    activeSocket = ws;

    ws.onopen = () => {
      if (ws !== activeSocket) return;
      statusEl.className = "status-badge connected";
      statusEl.title = "Connected";

      // Ensure dimensions are synced and SIGWINCH is dispatched
      if (fitAddon) {
        fitAddon.fit();
      }
      notifyTerminalResize();

      // Keepalive ping every 15s to keep Cloudflare tunnel / mobile connection active
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      if (ws !== activeSocket) return;
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else if (typeof event.data === "string") {
        // Handle ping pong response
        if (event.data.includes('"pong"')) return;
        term.write(event.data);
      }
    };

    ws.onclose = (event) => {
      if (ws !== activeSocket) return;
      statusEl.className = "status-badge disconnected";
      statusEl.title = "Disconnected";

      if (event.code === 4401) {
        term.writeln("\r\n\x1b[31m[Authentication failed: invalid token]\x1b[0m");
        authModal.showModal();
        return;
      }

      // Reconnect with backoff
      reconnectTimer = setTimeout(() => {
        if (currentSessionId === sessionId) {
          connectWebSocket(sessionId);
        }
      }, 2500);
    };

    ws.onerror = () => {
      statusEl.className = "status-badge disconnected";
    };
  }

  // 7. Sessions Manager Dialog (Running Terminals Picker)
  function setupSessionsManager() {
    const btnSessionsList = document.getElementById("btn-sessions-list");
    const sessionsModalClose = document.getElementById("sessions-modal-close");
    const sessionsModalDone = document.getElementById("sessions-modal-done");
    const modalOpenNewBtn = document.getElementById("modal-open-new-btn");

    if (btnSessionsList) {
      btnSessionsList.addEventListener("click", async () => {
        await openSessionsModal();
      });
    }

    if (sessionsModalClose) {
      sessionsModalClose.addEventListener("click", () => sessionsModal.close());
    }
    if (sessionsModalDone) {
      sessionsModalDone.addEventListener("click", () => sessionsModal.close());
    }
    if (modalOpenNewBtn) {
      modalOpenNewBtn.addEventListener("click", () => {
        sessionsModal.close();
        newSessionModal.showModal();
      });
    }
  }

  async function openSessionsModal() {
    try {
      const res = await apiFetch("/api/sessions");
      const sessions = await res.json();
      renderSessionsModalList(sessions);
      sessionsModal.showModal();
    } catch (e) {
      console.error("Failed to load sessions for modal:", e);
    }
  }

  function renderSessionsModalList(sessions) {
    const container = document.getElementById("sessions-list-container");
    if (!container) return;
    container.innerHTML = "";

    if (sessions.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding: 24px; color: var(--text-secondary)">No running terminals found.</div>`;
      return;
    }

    sessions.forEach((s) => {
      const card = document.createElement("div");
      card.className = `session-card ${s.id === currentSessionId ? "current" : ""}`;

      const uptimeSec = Math.floor(Date.now() / 1000 - s.created_at);
      const uptimeStr = formatDuration(uptimeSec);

      card.innerHTML = `
        <div class="session-card-header">
          <div class="session-title-group">
            <span class="status-dot ${s.alive ? "alive" : "dead"}"></span>
            <span class="session-name">${escapeHtml(s.name)}</span>
            ${s.id === currentSessionId ? '<span class="session-current-badge">Current</span>' : ""}
          </div>
          <span style="font-size: 11px; font-weight: 500; color: ${s.alive ? "#2ea043" : "#da3633"}">
            ${s.alive ? "● Running in background" : "○ Exited"}
          </span>
        </div>
        <div class="session-card-details">
          <span>CMD: <code>${escapeHtml(s.command || "shell")}</code></span>
          <span>PID: <strong>${s.pid || "N/A"}</strong></span>
          <span>Uptime: <strong>${uptimeStr}</strong></span>
          <span>Clients: <strong>${s.clients}</strong></span>
        </div>
        <div class="session-card-actions">
          <button type="button" class="btn btn-sm btn-rename" data-action="rename">Rename</button>
          <button type="button" class="btn btn-sm btn-danger" data-action="delete">Terminate</button>
          <button type="button" class="btn btn-sm btn-resume" data-action="resume">
            ${s.id === currentSessionId ? "Active" : "Resume"}
          </button>
        </div>
      `;

      card.querySelector('[data-action="resume"]').addEventListener("click", () => {
        switchSession(s.id);
        sessionsModal.close();
        showToast(`Resumed terminal: ${s.name}`);
      });

      card.querySelector('[data-action="rename"]').addEventListener("click", async () => {
        const newName = prompt("Enter new name for this session:", s.name);
        if (newName && newName.trim() && newName.trim() !== s.name) {
          try {
            await apiFetch(`/api/sessions/${s.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: newName.trim() }),
            });
            await refreshSessions();
            await openSessionsModal();
          } catch (e) {
            alert("Failed to rename session: " + e.message);
          }
        }
      });

      card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
        if (confirm(`Terminate session "${s.name}" (PID ${s.pid})?`)) {
          await closeSession(s.id);
          await openSessionsModal();
        }
      });

      container.appendChild(card);
    });
  }

  // 8. Mobile Virtual Keypad & Shortcuts
  function setupKeypad() {
    modCtrlBtn.addEventListener("click", () => {
      isCtrlActive = !isCtrlActive;
      modCtrlBtn.classList.toggle("active", isCtrlActive);
    });

    modAltBtn.addEventListener("click", () => {
      isAltActive = !isAltActive;
      modAltBtn.classList.toggle("active", isAltActive);
    });

    document.querySelectorAll(".key-btn[data-key]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const key = btn.getAttribute("data-key");
        handleSpecialKey(key);
      });
    });

    document.querySelectorAll(".key-btn[data-shortcut]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const sc = btn.getAttribute("data-shortcut");
        if (sc === "ctrl-c") sendTerminalInput("\x03");
        else if (sc === "ctrl-d") sendTerminalInput("\x04");
        else if (sc === "ctrl-l") sendTerminalInput("\x0c");
      });
    });

    document.querySelectorAll(".key-btn[data-send]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const char = btn.getAttribute("data-send");
        sendTerminalInput(char);
      });
    });

    document.getElementById("btn-paste").addEventListener("click", async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          sendTerminalInput(text);
        }
      } catch (err) {
        textInputModal.showModal();
      }
    });

    document.getElementById("btn-input-modal").addEventListener("click", () => {
      document.getElementById("mobile-text-content").value = "";
      textInputModal.showModal();
    });

    document.getElementById("text-modal-cancel").addEventListener("click", () => {
      textInputModal.close();
    });

    document.getElementById("text-input-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const content = document.getElementById("mobile-text-content").value;
      if (content) {
        sendTerminalInput(content + "\r");
      }
      textInputModal.close();
    });

    document.getElementById("btn-toggle-keypad").addEventListener("click", () => {
      mobileKeypad.classList.toggle("hidden");
      if (fitAddon) {
        setTimeout(() => fitAddon.fit(), 100);
      }
    });

    document.getElementById("btn-new-tab").addEventListener("click", () => {
      newSessionModal.showModal();
    });

    document.getElementById("modal-cancel-btn").addEventListener("click", () => {
      newSessionModal.close();
    });

    document.getElementById("preset-claude").addEventListener("click", () => {
      createNewSession("claude", "Claude Code");
      newSessionModal.close();
    });

    document.getElementById("preset-codex").addEventListener("click", () => {
      createNewSession("codex", "Codex");
      newSessionModal.close();
    });

    document.getElementById("preset-shell").addEventListener("click", () => {
      createNewSession("shell", "Shell");
      newSessionModal.close();
    });

    document.getElementById("custom-session-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const cmd = document.getElementById("custom-cmd").value.trim() || null;
      const name = document.getElementById("custom-name").value.trim() || null;
      createNewSession(cmd, name);
      newSessionModal.close();
    });
  }

  function handleSpecialKey(key) {
    let seq = "";
    switch (key) {
      case "Escape":
        seq = "\x1b";
        break;
      case "Tab":
        seq = "\t";
        break;
      case "Enter":
        seq = "\r";
        break;
      case "ArrowUp":
        seq = "\x1b[A";
        break;
      case "ArrowDown":
        seq = "\x1b[B";
        break;
      case "ArrowRight":
        seq = "\x1b[C";
        break;
      case "ArrowLeft":
        seq = "\x1b[D";
        break;
    }

    if (seq) {
      sendTerminalInput(seq);
    }
  }

  // 9. Helpers
  function showToast(msg, duration = 3200) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add("hidden");
    }, duration);
  }

  function formatDuration(sec) {
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const hr = Math.floor(min / 60);
    return `${hr}h ${min % 60}m`;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  // Start app on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAuth);
  } else {
    initAuth();
  }
})();
