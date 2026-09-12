// Tunminal Client Application
(function () {
  let token = "";
  let currentSessionId = null;
  let activeSocket = null;
  let term = null;
  let fitAddon = null;
  let isCtrlActive = false;
  let isAltActive = false;
  let sessionPollTimer = null;
  let toastTimer = null;
  let activeSessions = [];
  let streamIdleTimer = null;
  const utf8Decoder = new TextDecoder("utf-8", { fatal: false });

  // View Mode & Theme State
  let currentViewMode = localStorage.getItem("tunminal_view_mode") || "terminal";
  let currentTheme = localStorage.getItem("tunminal_theme") || "tunminal-dark";
  let currentFontSize = parseInt(
    localStorage.getItem("tunminal_font_size") || (window.innerWidth < 768 ? "12" : "14"),
    10
  );

  // DOM Elements
  const statusEl = document.getElementById("connection-status");
  const latencyBadge = document.getElementById("latency-badge");
  const btnMenuDrawer = document.getElementById("btn-menu-drawer");
  const headerActiveSession = document.getElementById("header-active-session");
  const sessionTitleText = document.getElementById("session-title-text");
  const sessionStatusDot = document.getElementById("session-status-dot");
  const btnBellToggle = document.getElementById("btn-bell-toggle");
  const btnFilesModal = document.getElementById("btn-files-modal");
  const filesModal = document.getElementById("files-modal");
  const fileDropOverlay = document.getElementById("file-drop-overlay");
  const tabsBar = document.getElementById("tabs-bar");
  const termContainer = document.getElementById("terminal-container");
  const guiContainer = document.getElementById("gui-container");
  const guiChatMessages = document.getElementById("gui-chat-messages");
  const guiPromptInput = document.getElementById("gui-prompt-input");
  const mobileKeypad = document.getElementById("mobile-keypad");
  const newSessionModal = document.getElementById("new-session-modal");
  const sessionsModal = document.getElementById("sessions-modal");
  const themeModal = document.getElementById("theme-modal");
  const textInputModal = document.getElementById("text-input-modal");
  const authModal = document.getElementById("auth-modal");
  const modCtrlBtn = document.getElementById("mod-ctrl");
  const modAltBtn = document.getElementById("mod-alt");
  const sessionsBadge = document.getElementById("sessions-badge");
  const toastEl = document.getElementById("toast");
  const btnModeTerminal = document.getElementById("btn-mode-terminal");
  const btnModeGui = document.getElementById("btn-mode-gui");

  let appStarted = false;

  // 1. Authentication & Token Initialization
  async function initAuth() {
    const urlParams = new URLSearchParams(window.location.search);
    const queryToken = urlParams.get("token");
    if (queryToken) {
      token = queryToken.trim();
      localStorage.setItem("tunminal_token", token);
      const cleanUrl = window.location.pathname;
      window.history.replaceState({}, document.title, cleanUrl);
    } else {
      token = (localStorage.getItem("tunminal_token") || "").trim();
    }

    if (!token) {
      authModal.showModal();
      return;
    }

    // Validate stored token against the server before attempting WebSocket connections
    try {
      const checkRes = await fetch("/api/info", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (checkRes.status === 401) {
        localStorage.removeItem("tunminal_token");
        token = "";
        authModal.showModal();
        return;
      }
    } catch (e) {
      // Server may be starting up, proceed with startApp
    }

    startApp();
  }

  function handleAuthFailure(reason = "Authentication required or token expired") {
    reconnectController.reset();
    heartbeatController.stop();
    ptyCoalescer.reset();
    if (activeSocket) {
      activeSocket.onclose = null;
      activeSocket.close();
      activeSocket = null;
    }
    localStorage.removeItem("tunminal_token");
    token = "";
    statusEl.className = "status-badge disconnected";
    statusEl.title = "Unauthorized";

    if (term) {
      term.writeln(`\r\n\x1b[31m[${reason}. Please enter token.]\x1b[0m\r\n`);
    }
    if (!authModal.open) {
      authModal.showModal();
    }
    showToast(reason);
  }

  document.getElementById("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const inputToken = document.getElementById("auth-token-input").value.trim();
    if (inputToken) {
      token = inputToken;
      localStorage.setItem("tunminal_token", token);
      authModal.close();
      await startApp();
    }
  });

  // 2. Main Application Flow
  async function startApp() {
    if (!appStarted) {
      appStarted = true;
      initThemes();
      initTerminal();
      setupBellAndNotifications();
      setupFileTransfer();
      setupViewMode();
      setupViewportHandler();
      setupKeypad();
      setupSessionsManager();
      setupGuiComposer();
      setupNetworkWakeListeners();
    }
    await loadPresetsAndInfo();
    await refreshSessions();

    if (sessionPollTimer) clearInterval(sessionPollTimer);
    sessionPollTimer = setInterval(refreshSessionsBackground, 8000);

    window.addEventListener("focus", () => {
      refreshSessionsBackground();
    });
  }

  // 3. Terminal & Theme Setup
  const FALLBACK_THEMES = {
    "tunminal-dark": {
      name: "Tunminal Dark",
      previewBg: "#0a0c10",
      previewFg: "#58a6ff",
      theme: {
        background: "#0a0c10",
        foreground: "#f0f6fc",
        cursor: "#58a6ff",
        cursorAccent: "#0a0c10",
        selectionBackground: "rgba(88, 166, 255, 0.3)",
        black: "#484f58",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39c5cf",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",
        brightWhite: "#f0f6fc",
      },
    },
    dracula: {
      name: "Dracula",
      previewBg: "#282a36",
      previewFg: "#bd93f9",
      theme: {
        background: "#282a36",
        foreground: "#f8f8f2",
        cursor: "#f8f8f2",
        cursorAccent: "#282a36",
        selectionBackground: "rgba(68, 71, 90, 0.6)",
        black: "#21222c",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#f8f8f2",
        brightBlack: "#6272a4",
        brightRed: "#ff6e6e",
        brightGreen: "#69ff94",
        brightYellow: "#ffffa5",
        brightBlue: "#d6acff",
        brightMagenta: "#ff92df",
        brightCyan: "#a4ffff",
        brightWhite: "#ffffff",
      },
    },
    "tokyo-night": {
      name: "Tokyo Night",
      previewBg: "#1a1b26",
      previewFg: "#7aa2f7",
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        cursorAccent: "#1a1b26",
        selectionBackground: "rgba(51, 70, 122, 0.5)",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    },
    "one-dark": {
      name: "One Dark",
      previewBg: "#282c34",
      previewFg: "#61afef",
      theme: {
        background: "#282c34",
        foreground: "#abb2bf",
        cursor: "#528bff",
        cursorAccent: "#282c34",
        selectionBackground: "rgba(62, 68, 81, 0.6)",
        black: "#1e2127",
        red: "#e06c75",
        green: "#98c379",
        yellow: "#d19a66",
        blue: "#61afef",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#abb2bf",
        brightBlack: "#5c6370",
        brightRed: "#e06c75",
        brightGreen: "#98c379",
        brightYellow: "#d19a66",
        brightBlue: "#61afef",
        brightMagenta: "#c678dd",
        brightCyan: "#56b6c2",
        brightWhite: "#ffffff",
      },
    },
    nord: {
      name: "Nord",
      previewBg: "#2e3440",
      previewFg: "#88c0d0",
      theme: {
        background: "#2e3440",
        foreground: "#d8dee9",
        cursor: "#d8dee9",
        cursorAccent: "#2e3440",
        selectionBackground: "rgba(67, 76, 94, 0.6)",
        black: "#3b4252",
        red: "#bf616a",
        green: "#a3be8c",
        yellow: "#ebcb8b",
        blue: "#81a1c1",
        magenta: "#b48ead",
        cyan: "#88c0d0",
        white: "#e5e9f0",
        brightBlack: "#4c566a",
        brightRed: "#bf616a",
        brightGreen: "#a3be8c",
        brightYellow: "#ebcb8b",
        brightBlue: "#81a1c1",
        brightMagenta: "#b48ead",
        brightCyan: "#8fbcbb",
        brightWhite: "#eceff4",
      },
    },
    monokai: {
      name: "Monokai Pro",
      previewBg: "#272822",
      previewFg: "#a6e22e",
      theme: {
        background: "#272822",
        foreground: "#f8f8f2",
        cursor: "#f8f8f0",
        cursorAccent: "#272822",
        selectionBackground: "rgba(73, 72, 62, 0.8)",
        black: "#272822",
        red: "#f92672",
        green: "#a6e22e",
        yellow: "#f4bf75",
        blue: "#66d9ef",
        magenta: "#ae81ff",
        cyan: "#a1efe4",
        white: "#f8f8f2",
        brightBlack: "#75715e",
        brightRed: "#f92672",
        brightGreen: "#a6e22e",
        brightYellow: "#f4bf75",
        brightBlue: "#66d9ef",
        brightMagenta: "#ae81ff",
        brightCyan: "#a1efe4",
        brightWhite: "#f9f8f5",
      },
    },
    "solarized-dark": {
      name: "Solarized Dark",
      previewBg: "#002b36",
      previewFg: "#268bd2",
      theme: {
        background: "#002b36",
        foreground: "#839496",
        cursor: "#839496",
        cursorAccent: "#002b36",
        selectionBackground: "rgba(7, 54, 66, 0.8)",
        black: "#073642",
        red: "#dc322f",
        green: "#859900",
        yellow: "#b58900",
        blue: "#268bd2",
        magenta: "#d33682",
        cyan: "#2aa198",
        white: "#eee8d5",
        brightBlack: "#586e75",
        brightRed: "#cb4b16",
        brightGreen: "#586e75",
        brightYellow: "#657b83",
        brightBlue: "#839496",
        brightMagenta: "#6c71c4",
        brightCyan: "#93a1a1",
        brightWhite: "#fdf6e3",
      },
    },
    "github-light": {
      name: "GitHub Light",
      previewBg: "#ffffff",
      previewFg: "#0969da",
      theme: {
        background: "#ffffff",
        foreground: "#24292f",
        cursor: "#0969da",
        cursorAccent: "#ffffff",
        selectionBackground: "rgba(9, 105, 218, 0.2)",
        black: "#24292f",
        red: "#cf222e",
        green: "#116329",
        yellow: "#4d2d00",
        blue: "#0969da",
        magenta: "#8250df",
        cyan: "#1b7c83",
        white: "#6e7781",
        brightBlack: "#57606a",
        brightRed: "#a40e26",
        brightGreen: "#1a7f37",
        brightYellow: "#633c01",
        brightBlue: "#218bff",
        brightMagenta: "#a475f9",
        brightCyan: "#3192aa",
        brightWhite: "#8c959f",
      },
    },
  };

  // Ensure window.TERMINAL_THEMES is guaranteed to exist
  if (!window.TERMINAL_THEMES) {
    window.TERMINAL_THEMES = FALLBACK_THEMES;
  }

  function getThemeConfig(themeId) {
    const themes = window.TERMINAL_THEMES || FALLBACK_THEMES;
    if (themes && themes[themeId]) {
      return themes[themeId].theme;
    }
    return FALLBACK_THEMES["tunminal-dark"].theme;
  }

  function initThemes() {
    const btnThemeModal = document.getElementById("btn-theme-modal");
    const themeModalClose = document.getElementById("theme-modal-close");
    const themeModalDone = document.getElementById("theme-modal-done");

    // Pre-render themes immediately and initialize font size controls
    renderThemesGrid();
    setupFontSizeControls();

    if (btnThemeModal) {
      btnThemeModal.addEventListener("click", () => {
        renderThemesGrid();
        updateFontSizeDisplay();
        themeModal.showModal();
      });
    }

    if (themeModalClose) {
      themeModalClose.addEventListener("click", () => themeModal.close());
    }
    if (themeModalDone) {
      themeModalDone.addEventListener("click", () => themeModal.close());
    }
  }

  function renderThemesGrid() {
    const themesGrid = document.getElementById("themes-grid");
    const themes = window.TERMINAL_THEMES || FALLBACK_THEMES;
    if (!themesGrid || !themes) return;
    themesGrid.innerHTML = "";

    Object.entries(themes).forEach(([id, t]) => {
      const card = document.createElement("div");
      card.className = `theme-card ${id === currentTheme ? "active" : ""}`;
      card.innerHTML = `
        <div class="theme-card-preview" style="background-color: ${t.previewBg}">
          <span style="color: ${t.previewFg}; font-weight: 700; font-family: monospace;">>_ tunminal</span>
          <div class="theme-swatches">
            <span class="swatch-dot" style="background-color: ${t.theme.red}"></span>
            <span class="swatch-dot" style="background-color: ${t.theme.green}"></span>
            <span class="swatch-dot" style="background-color: ${t.theme.yellow}"></span>
            <span class="swatch-dot" style="background-color: ${t.theme.blue}"></span>
            <span class="swatch-dot" style="background-color: ${t.theme.cyan}"></span>
          </div>
        </div>
        <div class="theme-name">${escapeHtml(t.name)}</div>
      `;

      card.addEventListener("click", () => {
        applyTheme(id);
        renderThemesGrid();
      });

      themesGrid.appendChild(card);
    });
  }

  function applyTheme(themeId) {
    const themes = window.TERMINAL_THEMES || FALLBACK_THEMES;
    if (!themes || !themes[themeId]) return;
    currentTheme = themeId;
    localStorage.setItem("tunminal_theme", themeId);
    if (term) {
      term.options.theme = themes[themeId].theme;
    }
    showToast(`Applied theme: ${themes[themeId].name}`);
  }

  function setFontSize(newSize) {
    newSize = Math.max(9, Math.min(26, newSize));
    currentFontSize = newSize;
    localStorage.setItem("tunminal_font_size", newSize);
    if (term) {
      term.options.fontSize = newSize;
      if (fitAddon && currentViewMode === "terminal") {
        fitAddon.fit();
        notifyTerminalResize();
      }
    }
    updateFontSizeDisplay();
    showToast(`Font size: ${newSize}px`);
  }

  function updateFontSizeDisplay() {
    const display = document.getElementById("font-size-display");
    if (display) {
      display.textContent = `${currentFontSize} px`;
    }
    document.querySelectorAll(".btn-preset").forEach((btn) => {
      const sz = parseInt(btn.dataset.size, 10);
      btn.classList.toggle("active", sz === currentFontSize);
    });
  }

  function updateHeaderSessionTitle(session) {
    if (!sessionTitleText) return;
    if (session) {
      sessionTitleText.textContent = session.name || session.command || "Terminal";
      if (sessionStatusDot) {
        sessionStatusDot.style.color = session.alive ? "var(--status-connected)" : "var(--status-disconnected)";
      }
    } else {
      sessionTitleText.textContent = "Tunminal";
    }
  }

  function setupFontSizeControls() {
    const btnDec = document.getElementById("btn-font-decrease");
    const btnInc = document.getElementById("btn-font-increase");
    if (btnDec) {
      btnDec.addEventListener("click", () => setFontSize(currentFontSize - 1));
    }
    if (btnInc) {
      btnInc.addEventListener("click", () => setFontSize(currentFontSize + 1));
    }

    document.querySelectorAll(".btn-preset").forEach((btn) => {
      btn.addEventListener("click", () => {
        const sz = parseInt(btn.dataset.size, 10);
        if (sz) setFontSize(sz);
      });
    });

    const fontDecKeypad = document.getElementById("btn-font-dec-keypad");
    if (fontDecKeypad) {
      fontDecKeypad.addEventListener("click", () => setFontSize(currentFontSize - 1));
    }
    const fontIncKeypad = document.getElementById("btn-font-inc-keypad");
    if (fontIncKeypad) {
      fontIncKeypad.addEventListener("click", () => setFontSize(currentFontSize + 1));
    }

    updateFontSizeDisplay();
  }

  function initTerminal() {
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: currentFontSize,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: getThemeConfig(currentTheme),
      scrollback: 5000,
      allowTransparency: false,
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termContainer);
    fitAddon.fit();

    // Suppress OSC color queries (10=fg, 11=bg, 12=cursor, 4=palette) so xterm doesn't
    // report terminal colors back to stdin, which leaks as literal text in Windows ConPTY / Codex.
    term.registerOscHandler(10, (data) => (data && data.startsWith("?") ? true : false));
    term.registerOscHandler(11, (data) => (data && data.startsWith("?") ? true : false));
    term.registerOscHandler(12, (data) => (data && data.startsWith("?") ? true : false));
    term.registerOscHandler(4, (data) => (data && data.includes("?") ? true : false));

    term.onData((data) => {
      // Guard: strip any OSC color query response sequences that xterm might emit
      if (data && data.includes(";rgb:")) {
        data = data.replace(/(?:\x1B\]|\])(?:10|11|12|4);rgb:[0-9a-fA-F/]+(?:\x1B\\|\x07|\\)?/g, "");
        if (!data) return;
      }
      sendTerminalInput(data);
    });

    term.onBell(() => {
      playBellSound();
    });

    window.addEventListener("resize", () => {
      if (currentViewMode === "terminal" && fitAddon) {
        fitAddon.fit();
        notifyTerminalResize();
      }
    });
  }

  // 4. View Mode Switching & Agent Filtering
  function isAiAgentSession(session) {
    if (!session) return false;
    const cmd = (session.command || "").toLowerCase();
    const name = (session.name || "").toLowerCase();
    return (
      cmd.includes("claude") ||
      cmd.includes("codex") ||
      name.includes("claude") ||
      name.includes("codex")
    );
  }

  function getActiveSession() {
    return activeSessions.find((s) => s.id === currentSessionId) || null;
  }

  function updateViewModeVisibility() {
    const session = getActiveSession();
    const isAgent = isAiAgentSession(session);
    const viewModeToggle = document.getElementById("view-mode-toggle");

    if (viewModeToggle) {
      if (isAgent) {
        viewModeToggle.classList.remove("hidden");
        updateGuiAgentHeader(session);
        const preferredMode = localStorage.getItem("tunminal_view_mode") || "terminal";
        setViewMode(preferredMode, false);
      } else {
        viewModeToggle.classList.add("hidden");
        // Non-AI sessions (shells, python, etc.) are locked strictly to Terminal mode
        setViewMode("terminal", false);
      }
    }
  }

  function updateGuiAgentHeader(session) {
    const avatarEl = document.getElementById("gui-agent-avatar");
    const titleEl = document.getElementById("gui-agent-title");
    if (!session) return;
    const name = (session.name || session.command || "").toLowerCase();
    const isCodex = name.includes("codex");
    if (avatarEl) {
      avatarEl.innerHTML = isCodex ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-bolt"></i>';
      avatarEl.className = `gui-agent-avatar ${isCodex ? "avatar-codex" : "avatar-claude"}`;
    }
    if (titleEl) {
      titleEl.textContent = isCodex ? "OpenAI Codex" : "Claude Code";
    }
  }

  function setupViewMode() {
    if (btnModeTerminal) {
      btnModeTerminal.addEventListener("click", () => setViewMode("terminal"));
    }
    if (btnModeGui) {
      btnModeGui.addEventListener("click", () => setViewMode("gui"));
    }
    updateViewModeVisibility();
  }

  function setViewMode(mode, showNotice = true) {
    const session = getActiveSession();
    // Safety check: if session is not AI agent, cannot switch to GUI
    if (mode === "gui" && !isAiAgentSession(session)) {
      mode = "terminal";
    }

    currentViewMode = mode;
    if (isAiAgentSession(session)) {
      localStorage.setItem("tunminal_view_mode", mode);
    }

    if (btnModeTerminal && btnModeGui) {
      btnModeTerminal.classList.toggle("active", mode === "terminal");
      btnModeGui.classList.toggle("active", mode === "gui");
    }

    if (mode === "terminal") {
      termContainer.classList.remove("hidden");
      mobileKeypad.classList.remove("hidden");
      guiContainer.classList.add("hidden");
      if (fitAddon) {
        setTimeout(() => {
          fitAddon.fit();
          term.focus();
        }, 50);
      }
      if (showNotice) showToast("Switched to Raw Terminal mode");
    } else {
      termContainer.classList.add("hidden");
      mobileKeypad.classList.add("hidden");
      guiContainer.classList.remove("hidden");
      if (guiParser.messages.length === 0 && !guiParser.currentAssistantContent) {
        guiParser.renderWelcomeOrMessages();
      } else if (guiParser.currentAssistantContent && !guiParser.currentAssistantCard) {
        guiParser.updateAssistantCard(true);
      }
      if (guiPromptInput) {
        guiPromptInput.focus();
      }
      scrollGuiToBottom(true);
      if (showNotice) showToast("Switched to Modern Web GUI mode");
    }
  }

  function setupViewportHandler() {
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => {
        const app = document.getElementById("app");
        app.style.height = `${window.visualViewport.height}px`;
        if (currentViewMode === "terminal" && fitAddon) {
          fitAddon.fit();
          notifyTerminalResize();
        } else if (currentViewMode === "gui") {
          scrollGuiToBottom();
        }
      });
      window.visualViewport.addEventListener("scroll", () => {
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
    if (!data) return;
    if (typeof data === "string" && data.includes(";rgb:")) {
      data = data.replace(/(?:\x1B\]|\])(?:10|11|12|4);rgb:[0-9a-fA-F/]+(?:\x1B\\|\x07|\\)?/g, "");
      if (!data) return;
    }
    if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
      activeSocket.send(data);
    }
  }

  function sendPrompt(text) {
    if (!text || !text.trim()) return;
    sendTerminalInput(`${text.trim()}\r`);
    guiParser.addUserMessage(text);
  }

  // 5. High-Performance Full GUI Stream Parser & Cleaner
  // Order matters: match complete OSC (Operating System Commands), complete CSI sequences,
  // 2-character escape codes, and C1 controls without range ambiguity.
  const ANSI_REGEX = /(?:\x1B\][^\x07\x1b]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\_]|[\x80-\x9A\x9C-\x9F])/g;

  let ansiCarryOver = "";

  function stripAnsi(str) {
    if (!str) return "";
    if (ansiCarryOver) {
      str = ansiCarryOver + str;
      ansiCarryOver = "";
    }
    // Check if the chunk ends with an incomplete escape sequence that might continue in the next chunk
    // e.g. \x1b or \x1b[ or \x1b[38;2; without a terminating character [@-~] or OSC without \x07/\x1b\
    const trailingEsc = str.match(/\x1B(?:\][^\x07\x1b]*|\[[0-?]*[ -/]*|[@-Z\\_])?$/);
    if (trailingEsc && trailingEsc.index !== undefined && trailingEsc.index < str.length) {
      const candidate = trailingEsc[0];
      const isComplete = /^(?:\x1B\][^\x07\x1b]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-Z\\_]|[\x80-\x9A\x9C-\x9F])$/.test(candidate);
      if (!isComplete) {
        ansiCarryOver = candidate;
        str = str.slice(0, trailingEsc.index);
      }
    }
    return str ? str.replace(ANSI_REGEX, "") : "";
  }

  function setAgentWorkingState(working) {
    const statusEl = document.getElementById("gui-agent-status");
    if (!statusEl) return;
    if (working) {
      statusEl.className = "gui-agent-status working";
      statusEl.textContent = "● Working...";
    } else {
      statusEl.className = "gui-agent-status ready";
      statusEl.textContent = "● Ready";
    }
  }

  function setAgentStatusText(text, isWorking = true) {
    const statusEl = document.getElementById("gui-agent-status");
    if (!statusEl) return;
    statusEl.className = `gui-agent-status ${isWorking ? "working" : "ready"}`;
    statusEl.textContent = text;
  }

  function checkInteractiveApproval(text) {
    const approvalBar = document.getElementById("gui-approval-bar");
    const promptTextEl = document.getElementById("approval-prompt-text");
    if (!approvalBar) return;

    // Detect [y/n], (y/n), Allow command, etc.
    const isApproval = /\[(y\/n|Y\/n)\]|\((y\/n|Y\/n)\)|Allow\s+(Bash\s+)?command|Proceed\s+with/i.test(text);
    if (isApproval) {
      const clean = text.replace(/[\r\n]+/g, " ").trim();
      const snippet = clean.length > 70 ? clean.slice(0, 70) + "..." : clean;
      if (promptTextEl) {
        promptTextEl.textContent = snippet || "Action requires confirmation [y/n]";
      }
      approvalBar.classList.remove("hidden");
    }
  }

  function hideApprovalBar() {
    const approvalBar = document.getElementById("gui-approval-bar");
    if (approvalBar) {
      approvalBar.classList.add("hidden");
    }
  }

  const guiParser = {
    messages: [],
    currentAssistantCard: null,
    currentBodyEl: null,
    currentAssistantContent: "",

    // Streaming batching & frame throttling
    pendingChunk: "",
    renderRafId: null,
    lastRenderTime: 0,
    renderIntervalMs: 50, // Throttle to ~20 FPS max for DOM rendering

    reset() {
      if (this.renderRafId) {
        cancelAnimationFrame(this.renderRafId);
        clearTimeout(this.renderRafId);
        this.renderRafId = null;
      }
      if (streamIdleTimer) {
        clearTimeout(streamIdleTimer);
        streamIdleTimer = null;
      }
      this.pendingChunk = "";
      ansiCarryOver = "";
      this.messages = [];
      this.currentAssistantCard = null;
      this.currentBodyEl = null;
      this.currentAssistantContent = "";
      hideApprovalBar();
      setAgentWorkingState(false);
      this.renderWelcomeOrMessages();
    },

    renderWelcomeOrMessages() {
      if (!guiChatMessages) return;
      guiChatMessages.innerHTML = "";
      if (this.messages.length === 0) {
        this.renderWelcomeHero();
      } else {
        this.messages.forEach((msg) => {
          if (msg.sender === "user") {
            this.renderUserCard(msg);
          } else {
            this.renderStaticAssistantCard(msg);
          }
        });
      }
    },

    renderWelcomeHero() {
      if (!guiChatMessages) return;
      const session = getActiveSession();
      const isCodex = session && (session.name || session.command || "").toLowerCase().includes("codex");
      const agentName = isCodex ? "Codex" : "Claude Code";
      const icon = isCodex ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-bolt"></i>';

      const hero = document.createElement("div");
      hero.className = "gui-welcome-hero";
      hero.innerHTML = `
        <div class="welcome-icon-box ${isCodex ? "codex-icon" : ""}">
          ${icon}
        </div>
        <h2 class="welcome-title">Welcome to ${agentName}</h2>
        <p class="welcome-desc">
          Your local AI pair programming assistant is ready. Send a message, run tasks, or pick a starter prompt below.
        </p>
        <div class="welcome-suggestions">
          <div class="suggestion-card" data-prompt="Explain the architecture and main components of this codebase">
            <strong><i class="fa-regular fa-folder-open"></i> Architecture Overview</strong>
            <span>Explain project structure and main files</span>
          </div>
          <div class="suggestion-card" data-prompt="Run existing project tests and explain any failures">
            <strong><i class="fa-solid fa-flask-vial"></i> Run Test Suite</strong>
            <span>Run tests and analyze issues</span>
          </div>
          <div class="suggestion-card" data-prompt="Review git status and summarize recent code changes">
            <strong><i class="fa-solid fa-magnifying-glass"></i> Git Diff & Status</strong>
            <span>Summarize uncommitted modifications</span>
          </div>
          <div class="suggestion-card" data-prompt="Suggest code optimizations and potential refactoring">
            <strong><i class="fa-solid fa-bolt-lightning"></i> Code Optimization</strong>
            <span>Find performance improvements</span>
          </div>
        </div>
      `;

      hero.querySelectorAll(".suggestion-card").forEach((card) => {
        card.addEventListener("click", () => {
          const prompt = card.getAttribute("data-prompt");
          if (prompt) {
            sendPrompt(prompt);
          }
        });
      });

      guiChatMessages.appendChild(hero);
    },

    addUserMessage(text) {
      // Flush any pending stream buffer and finalize prior assistant response
      this.flushPending(true);
      this.finalizeAssistantMessage();

      const hero = guiChatMessages.querySelector(".gui-welcome-hero");
      if (hero) hero.remove();

      const msg = {
        id: Date.now(),
        sender: "user",
        text: text.trim(),
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      this.messages.push(msg);
      this.renderUserCard(msg);
      scrollGuiToBottom(true);
      setAgentWorkingState(true);
    },

    appendStream(chunkText) {
      const clean = stripAnsi(chunkText);
      if (!clean) return;

      checkInteractiveApproval(clean);

      // Helper: Filter orphaned SGR codes, starfield dots, and Codex startup banners
      function isTerminalNoiseLine(trimmed) {
        if (!trimmed) return true;

        // 1. Orphaned ANSI SGR / CSI escape remnants (e.g. 123;123;48;2;41;41;41m . , 1H, ;48;2;...)
        if (
          /^(?:;|\d|;)+m\s*[\.·\s]*$/.test(trimmed) ||
          /^\d+;\d+;.*m/.test(trimmed) ||
          /^;?\d+;2;\d+;\d+/.test(trimmed) ||
          /^;?\d+;\d+;\d+;\d+/.test(trimmed) ||
          /^\d*H\s*$/.test(trimmed) ||
          /^[\d;]+[a-zA-Z]\s*[\.·\s]*$/.test(trimmed) ||
          /[0-9;]+m\s*[\.·\s]*$/.test(trimmed)
        ) {
          return true;
        }

        // 2. Starfield idle dots / periods / bullets: e.g. " . ", " . . ", " . . . ."
        if (/^[\s.·•*~-]+$/.test(trimmed) || /^[.\s·•*]{2,}$/.test(trimmed)) {
          return true;
        }

        // 3. Codex startup banner & box curves & environment info:
        // e.g. "╭─── || ~\Documents\tunmial\tunminal ├─── ╭ ╭ ╭ ╭"
        // "╭ gpt-6-astra default · ~\Documents\tunmial\tunminal ╭ ╭"
        if (
          /^[╭╰├┌└│─═━┃┏┓┗┛╔╗╚╝\s|─-]{1,8}$/.test(trimmed) ||
          /(?:gpt-[a-z0-9_-]+|default ·|high ·|low ·|~\\Documents|\\Documents\\|\/Documents\/)/i.test(trimmed) ||
          /^│\s*(>_\s*OpenAI Codex|model:|directory:)/i.test(trimmed) ||
          /^Tip:\s/i.test(trimmed) ||
          /^>_\s*OpenAI Codex/i.test(trimmed) ||
          (/^[╭╰├┌└│─═━┃┏┓┗┛╔╗╚╝]/.test(trimmed) && (trimmed.includes("tunminal") || trimmed.includes("||") || trimmed.includes("model") || trimmed.includes("Codex")))
        ) {
          return true;
        }

        return false;
      }

      // Process lines handling carriage return (\r) overwrites & transient spinners
      const rawLines = clean.split("\n");
      let meaningfulContent = "";
      let hasReadyPrompt = false;

      for (let i = 0; i < rawLines.length; i++) {
        let line = rawLines[i];

        // \r carriage return handling: keep only the latest rewrite segment
        if (line.includes("\r")) {
          const parts = line.split("\r").filter((p) => p.length > 0);
          line = parts.length > 0 ? parts[parts.length - 1] : "";
        }

        const trimmed = line.trim();
        if (!trimmed) continue;

        // 1. Detect interactive prompt lines (Claude Code or Codex)
        if (
          /›\s*(Ask Codex|What would you like)/i.test(trimmed) ||
          /^\?\s+.*\s*›\s*$/.test(trimmed) ||
          /›\s*$/.test(trimmed) ||
          /^\?\s+for shortcuts/i.test(trimmed)
        ) {
          hasReadyPrompt = true;
          continue; // Do NOT append raw prompt redraw into chat text
        }

        // 2. Discard terminal noise (orphaned SGR remnants, starfield dots, startup banners)
        if (isTerminalNoiseLine(trimmed)) {
          continue;
        }

        // 3. Detect and filter Braille animation frames (Codex idle dots/spinners: [\u2800-\u28FF])
        const brailleMatches = trimmed.match(/[\u2800-\u28FF]/g);
        const brailleCount = brailleMatches ? brailleMatches.length : 0;
        const nonSpaceLen = trimmed.replace(/\s/g, "").length;
        if (brailleCount > 0 && (brailleCount / nonSpaceLen >= 0.25 || /^[\u2800-\u28FF]/.test(trimmed))) {
          continue; // Discard transient idle starfield/spinner animation
        }

        // 4. Detect standard CLI spinner frames with optional indentation: e.g. ⠋ Thinking..., ◐ Working...
        const spinnerMatch = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒◜◝◞◟]\s*(.*)/.exec(trimmed);
        if (spinnerMatch) {
          const statusText = spinnerMatch[1] ? spinnerMatch[1].trim() : "Working...";
          setAgentStatusText(`● ${statusText}`, true);
          continue; // Do NOT append transient spinner frame into permanent chat text
        }

        // 5. Detect transient thinking / progress timer updates: e.g. "● Thinking... (2s)" or "● Running command..."
        if (/^●\s*(Thinking|Working|Running|Waiting|Searching|Generating).*\(\d+(\.\d+)?s\)/i.test(trimmed)) {
          setAgentStatusText(trimmed, true);
          continue;
        }

        // 6. Filter decorative and box drawing frames (including full Unicode Box Drawing \u2500-\u257F)
        if (/^[\u2500-\u257F\s╭╰├┌└│─═━┃┏┓┗┛╔╗╚╝]+$/.test(trimmed) && trimmed.length > 2) {
          continue;
        }

        meaningfulContent += line + "\n";
      }

      if (meaningfulContent) {
        // Only remove welcome hero when genuine conversation content arrives
        if (this.messages.length > 0 || !hasReadyPrompt) {
          const hero = guiChatMessages.querySelector(".gui-welcome-hero");
          if (hero) hero.remove();

          this.pendingChunk += meaningfulContent;
          setAgentWorkingState(true);

          // If in Terminal mode, don't trigger DOM re-renders; accumulate quietly
          if (currentViewMode === "gui") {
            this.scheduleRender();
          }
        }
      }

      // If interactive ready prompt was detected, finalize assistant turn immediately
      if (hasReadyPrompt) {
        if (streamIdleTimer) {
          clearTimeout(streamIdleTimer);
          streamIdleTimer = null;
        }
        // If user hasn't sent any message yet, this was just the startup prompt screen!
        if (this.messages.length === 0) {
          this.pendingChunk = "";
          this.currentAssistantContent = "";
          this.currentAssistantCard = null;
          this.currentBodyEl = null;
          this.renderWelcomeOrMessages();
          setAgentWorkingState(false);
          return;
        }
        this.flushPending(false);
        this.finalizeAssistantMessage();
        setAgentWorkingState(false);
        return;
      }

      // Fallback: If output goes idle for 1.8s, agent turn has completed -> seal card into static DOM
      if (streamIdleTimer) clearTimeout(streamIdleTimer);
      streamIdleTimer = setTimeout(() => {
        if (this.messages.length === 0) {
          this.pendingChunk = "";
          this.currentAssistantContent = "";
          this.currentAssistantCard = null;
          this.currentBodyEl = null;
          this.renderWelcomeOrMessages();
          setAgentWorkingState(false);
          return;
        }
        this.flushPending(false);
        this.finalizeAssistantMessage();
        setAgentWorkingState(false);
      }, 1800);
    },

    scheduleRender() {
      if (this.renderRafId) return;

      const now = performance.now();
      const elapsed = now - this.lastRenderTime;

      if (elapsed >= this.renderIntervalMs) {
        this.renderRafId = requestAnimationFrame(() => {
          this.renderRafId = null;
          this.lastRenderTime = performance.now();
          this.flushPending(false);
        });
      } else {
        const delay = this.renderIntervalMs - elapsed;
        this.renderRafId = setTimeout(() => {
          this.renderRafId = null;
          this.lastRenderTime = performance.now();
          this.flushPending(false);
        }, delay);
      }
    },

    flushPending(forceScroll = false) {
      if (!this.pendingChunk) {
        if (forceScroll) scrollGuiToBottom(true);
        return;
      }
      this.currentAssistantContent += this.pendingChunk;
      this.pendingChunk = "";
      if (currentViewMode === "gui") {
        this.updateAssistantCard(forceScroll);
      }
    },

    updateAssistantCard(forceScroll = false) {
      if (!this.currentAssistantCard) {
        const session = getActiveSession();
        const isCodex = session && (session.name || session.command || "").toLowerCase().includes("codex");
        const author = isCodex ? "OpenAI Codex" : "Claude Code";
        const avatarIcon = isCodex ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-bolt"></i>';
        const avatarClass = isCodex ? "avatar-codex" : "avatar-claude";

        const card = document.createElement("div");
        card.className = "msg-card msg-assistant";
        card.innerHTML = `
          <div class="msg-header">
            <div class="msg-avatar ${avatarClass}">${avatarIcon}</div>
            <span class="msg-author">${escapeHtml(author)}</span>
            <span class="msg-time">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
          <div class="msg-body"></div>
        `;
        guiChatMessages.appendChild(card);
        this.currentAssistantCard = card;
        this.currentBodyEl = card.querySelector(".msg-body");
      }

      if (this.currentBodyEl) {
        this.currentBodyEl.innerHTML = renderFormattedMarkdown(this.currentAssistantContent);
      }
      scrollGuiToBottom(forceScroll);
    },

    finalizeAssistantMessage() {
      if (this.renderRafId) {
        cancelAnimationFrame(this.renderRafId);
        clearTimeout(this.renderRafId);
        this.renderRafId = null;
      }
      if (this.pendingChunk) {
        this.currentAssistantContent += this.pendingChunk;
        this.pendingChunk = "";
        if (this.currentBodyEl) {
          this.currentBodyEl.innerHTML = renderFormattedMarkdown(this.currentAssistantContent);
        }
      }

      if (this.currentAssistantCard && this.currentAssistantContent.trim()) {
        this.messages.push({
          id: Date.now(),
          sender: "assistant",
          text: this.currentAssistantContent.trim(),
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        });
      }
      // Seal active card as permanent static DOM element; future assistant turns start a new card
      this.currentAssistantCard = null;
      this.currentBodyEl = null;
      this.currentAssistantContent = "";
    },

    renderUserCard(msg) {
      const card = document.createElement("div");
      card.className = "msg-card msg-user";
      card.innerHTML = `
        <div class="msg-header">
          <div class="msg-avatar avatar-user"><i class="fa-solid fa-user"></i></div>
          <span class="msg-author">You</span>
          <span class="msg-time">${msg.time}</span>
        </div>
        <div class="msg-body">${escapeHtml(msg.text).replace(/\n/g, "<br>")}</div>
      `;
      guiChatMessages.appendChild(card);
    },

    renderStaticAssistantCard(msg) {
      const session = getActiveSession();
      const isCodex = session && (session.name || session.command || "").toLowerCase().includes("codex");
      const author = isCodex ? "OpenAI Codex" : "Claude Code";
      const avatarIcon = isCodex ? '<i class="fa-solid fa-robot"></i>' : '<i class="fa-solid fa-bolt"></i>';
      const avatarClass = isCodex ? "avatar-codex" : "avatar-claude";

      const card = document.createElement("div");
      card.className = "msg-card msg-assistant";
      card.innerHTML = `
        <div class="msg-header">
          <div class="msg-avatar ${avatarClass}">${avatarIcon}</div>
          <span class="msg-author">${escapeHtml(author)}</span>
          <span class="msg-time">${msg.time}</span>
        </div>
        <div class="msg-body">${renderFormattedMarkdown(msg.text)}</div>
      `;
      guiChatMessages.appendChild(card);
    },
  };

  function renderFormattedMarkdown(text) {
    if (!text) return "";

    // 1. Extract code blocks (including unclosed streaming blocks) to protect newlines from <br>
    const codeBlocks = [];
    let processed = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)(?:```|$)/g, (match, lang, code) => {
      const placeholder = `__TUNMINAL_CODE_${codeBlocks.length}__`;
      const language = lang || "code";
      codeBlocks.push({
        language,
        code,
      });
      return placeholder;
    });

    let html = escapeHtml(processed);

    // 2. Tool executions (lines starting with ● or ❯)
    html = html.replace(/^[●❯]\s*(.*)$/gm, '<div class="gui-tool-card"><i class="fa-solid fa-screwdriver-wrench"></i> <span>$1</span></div>');

    // 3. Bold **text**
    html = html.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");

    // 4. Inline code `code`
    html = html.replace(/`([^`]+)`/g, '<code style="background:#21262d; padding:2px 5px; border-radius:4px; font-family:monospace; color:#79c0ff;">$1</code>');

    // 5. Headers #, ##, ###
    html = html.replace(/^### (.*$)/gim, '<h4 style="margin:10px 0 4px; color:#58a6ff; font-weight:700;">$1</h4>');
    html = html.replace(/^## (.*$)/gim, '<h3 style="margin:12px 0 6px; color:#79c0ff; font-weight:700;">$1</h3>');
    html = html.replace(/^# (.*$)/gim, '<h2 style="margin:14px 0 8px; color:#e6edf3; font-weight:700;">$1</h2>');

    // 6. Newlines to <br> outside code blocks
    html = html.replace(/\n/g, "<br>");

    // 7. Re-insert code blocks with clean formatting and copy button
    for (let i = 0; i < codeBlocks.length; i++) {
      const { language, code } = codeBlocks[i];
      const blockHtml = `
        <div class="gui-code-block">
          <div class="gui-code-header">
            <span>${escapeHtml(language)}</span>
            <button type="button" class="btn-copy-code" data-code="${encodeURIComponent(code)}"><i class="fa-regular fa-copy"></i> Copy</button>
          </div>
          <pre class="gui-code-content"><code>${escapeHtml(code)}</code></pre>
        </div>
      `;
      html = html.replace(`__TUNMINAL_CODE_${i}__`, blockHtml);
    }

    return html;
  }

  function scrollGuiToBottom(force = false) {
    if (!guiChatMessages) return;
    if (force) {
      guiChatMessages.scrollTop = guiChatMessages.scrollHeight;
      return;
    }
    // Smart scroll: only auto-scroll if user is pinned near the bottom (within 120px)
    const distanceFromBottom =
      guiChatMessages.scrollHeight - guiChatMessages.scrollTop - guiChatMessages.clientHeight;
    if (distanceFromBottom < 120) {
      guiChatMessages.scrollTop = guiChatMessages.scrollHeight;
    }
  }

  // 6. GUI Composer Form & Actions
  function setupGuiComposer() {
    const composerForm = document.getElementById("gui-composer-form");
    const btnStop = document.getElementById("gui-btn-stop");
    const btnClear = document.getElementById("gui-btn-clear");
    const btnToTerm = document.getElementById("gui-btn-to-term");
    const btnApproveYes = document.getElementById("btn-approve-yes");
    const btnApproveNo = document.getElementById("btn-approve-no");

    if (guiPromptInput) {
      // Auto-expand textarea height
      guiPromptInput.addEventListener("input", () => {
        guiPromptInput.style.height = "auto";
        guiPromptInput.style.height = `${Math.min(guiPromptInput.scrollHeight, 140)}px`;
      });

      // Enter to send, Shift+Enter for new line
      guiPromptInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          submitGuiPrompt();
        }
      });
    }

    if (composerForm) {
      composerForm.addEventListener("submit", (e) => {
        e.preventDefault();
        submitGuiPrompt();
      });
    }

    if (btnStop) {
      btnStop.addEventListener("click", () => {
        sendTerminalInput("\x03"); // Send Ctrl+C
        showToast("Sent Cancel / Interrupt (^C)");
        hideApprovalBar();
        setAgentWorkingState(false);
        guiParser.finalizeAssistantMessage();
      });
    }

    if (btnClear) {
      btnClear.addEventListener("click", () => {
        guiParser.reset();
        showToast("Cleared GUI chat history");
      });
    }

    if (btnToTerm) {
      btnToTerm.addEventListener("click", () => {
        setViewMode("terminal");
      });
    }

    if (btnApproveYes) {
      btnApproveYes.addEventListener("click", () => {
        sendTerminalInput("y\r");
        hideApprovalBar();
        guiParser.addUserMessage("y (Approved)");
        showToast("Approved (y)");
      });
    }

    if (btnApproveNo) {
      btnApproveNo.addEventListener("click", () => {
        sendTerminalInput("n\r");
        hideApprovalBar();
        guiParser.addUserMessage("n (Denied)");
        showToast("Denied (n)");
      });
    }

    // Quick action chips
    document.querySelectorAll(".chip-btn").forEach((chip) => {
      chip.addEventListener("click", () => {
        const cmd = chip.getAttribute("data-chip");
        if (cmd) {
          sendTerminalInput(`${cmd}\r`);
          if (cmd === "y" || cmd === "n") {
            hideApprovalBar();
          }
          guiParser.addUserMessage(cmd);
          showToast(`Sent: ${cmd}`);
        }
      });
    });

    // Delegated copy button listener for all GUI code blocks (prevents re-binding overhead)
    if (guiChatMessages) {
      guiChatMessages.addEventListener("click", async (e) => {
        const btn = e.target.closest(".btn-copy-code");
        if (!btn) return;
        const code = decodeURIComponent(btn.getAttribute("data-code") || "");
        try {
          await navigator.clipboard.writeText(code);
          const origText = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => (btn.textContent = origText), 2000);
        } catch (err) {
          btn.textContent = "Failed";
        }
      });
    }
  }

  function submitGuiPrompt() {
    if (!guiPromptInput) return;
    const text = guiPromptInput.value.trim();
    if (!text) return;

    // Send input into active terminal session PTY
    sendTerminalInput(`${text}\r`);
    guiParser.addUserMessage(text);

    // Reset input
    guiPromptInput.value = "";
    guiPromptInput.style.height = "auto";
  }

  // 7. API Calls with Auth
  async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    options.headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(endpoint, options);
    if (res.status === 401) {
      handleAuthFailure("Authentication required: Token is invalid or expired");
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

  // 8. Session Management & Reconnection
  async function refreshSessions() {
    try {
      const res = await apiFetch("/api/sessions");
      const sessions = await res.json();
      activeSessions = sessions;
      renderTabs(sessions);
      updateBadge(sessions.length);
      updateViewModeVisibility();

      if (sessions.length > 0) {
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
      activeSessions = sessions;
      renderTabs(sessions);
      updateBadge(sessions.length);
      updateViewModeVisibility();
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
        <span class="tab-close" title="Close / Terminate Session"><i class="fa-solid fa-xmark"></i></span>
      `;
      tab.addEventListener("click", (e) => {
        const closeBtn = e.target.closest(".tab-close");
        if (closeBtn) {
          e.stopPropagation();
          closeSession(s.id);
        } else {
          switchSession(s.id);
        }
      });
      tabsBar.appendChild(tab);
    });
    updateHeaderSessionTitle(getActiveSession());
  }

  async function createNewSession(command, name, cwd = null) {
    try {
      const payload = {
        command: command,
        name: name,
        cols: term ? term.cols : 80,
        rows: term ? term.rows : 24,
      };
      if (cwd) payload.cwd = cwd;
      const res = await apiFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

  // 9. WebSocket Connection & Switching (Optimized with vibe-term connectivity patterns)
  const ptyCoalescer = {
    chunks: [],
    totalBytes: 0,
    timer: null,
    delayMs: 4,
    maxBytes: 32768,

    push(u8) {
      this.chunks.push(u8);
      this.totalBytes += u8.byteLength;
      if (this.totalBytes >= this.maxBytes) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.delayMs);
      }
    },

    flush() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.chunks.length === 0) return;

      let merged;
      if (this.chunks.length === 1) {
        merged = this.chunks[0];
      } else {
        merged = new Uint8Array(this.totalBytes);
        let offset = 0;
        for (const c of this.chunks) {
          merged.set(c, offset);
          offset += c.byteLength;
        }
      }
      this.chunks = [];
      this.totalBytes = 0;

      if (term) {
        term.write(merged);
      }
      const textChunk = utf8Decoder.decode(merged);
      if (textChunk) {
        checkOscNotifications(textChunk);
        const session = getActiveSession();
        if (isAiAgentSession(session)) {
          guiParser.appendStream(textChunk);
        }
      }
    },

    reset() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.chunks = [];
      this.totalBytes = 0;
    },
  };

  const heartbeatController = {
    intervalId: null,
    pongDeadlineTimer: null,
    activeNonce: null,
    rttHistory: [],
    pingIntervalMs: 3500,
    pongDeadlineMs: 6000,
    lastPingTime: 0,

    start(ws) {
      this.stop();
      this.rttHistory = [];

      this.intervalId = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          this.sendPing(ws);
        }
      }, this.pingIntervalMs);

      // Send initial ping immediately
      this.sendPing(ws);
    },

    sendPing(ws, deadlineMs) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      this.lastPingTime = now;
      const nonce = "p_" + now + "_" + Math.random().toString(36).substring(2, 7);
      this.activeNonce = nonce;

      if (this.pongDeadlineTimer) {
        clearTimeout(this.pongDeadlineTimer);
        this.pongDeadlineTimer = null;
      }
      const timeout = deadlineMs || this.pongDeadlineMs;
      this.pongDeadlineTimer = setTimeout(() => {
        if (ws === activeSocket && ws.readyState === WebSocket.OPEN) {
          console.warn(`[Tunminal] Heartbeat pong deadline exceeded (${timeout}ms). Terminating dead socket.`);
          try {
            ws.close();
          } catch (e) {}
        }
      }, timeout);

      try {
        ws.send(JSON.stringify({ type: "ping", time: now, nonce }));
      } catch (e) {
        console.warn("[Tunminal] Failed to send ping:", e);
      }
    },

    handlePong(parsed) {
      if (!parsed) return;
      if (!this.activeNonce || !parsed.nonce || parsed.nonce === this.activeNonce) {
        if (this.pongDeadlineTimer) {
          clearTimeout(this.pongDeadlineTimer);
          this.pongDeadlineTimer = null;
        }
        this.activeNonce = null;

        if (parsed.time) {
          const rtt = Math.max(0, Date.now() - parsed.time);
          this.rttHistory.push(rtt);
          if (this.rttHistory.length > 5) {
            this.rttHistory.shift();
          }
          const sorted = [...this.rttHistory].sort((a, b) => a - b);
          const medianRtt = sorted[Math.floor(sorted.length / 2)];
          updateLatencyBadge(medianRtt);
        }
      }
    },

    probe(ws, fastDeadline = 2500) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        this.sendPing(ws, fastDeadline);
      }
    },

    stop() {
      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
      if (this.pongDeadlineTimer) {
        clearTimeout(this.pongDeadlineTimer);
        this.pongDeadlineTimer = null;
      }
      this.activeNonce = null;
    },
  };

  const reconnectController = {
    timer: null,
    attempts: 0,
    baseDelay: 1000,
    maxDelay: 15000,

    reset() {
      this.attempts = 0;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    },

    resetTimer() {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    },

    schedule(sessionId, callback) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      this.attempts++;
      const exp = Math.pow(1.5, Math.min(this.attempts - 1, 8));
      const jitter = 0.8 + Math.random() * 0.4;
      const delay = Math.min(this.maxDelay, Math.round(this.baseDelay * exp * jitter));

      statusEl.className = "status-badge connecting";
      statusEl.title = `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.attempts})...`;

      this.timer = setTimeout(() => {
        this.timer = null;
        if (currentSessionId === sessionId) {
          callback();
        }
      }, delay);
    },
  };

  function setupNetworkWakeListeners() {
    const handleWake = () => {
      if (!currentSessionId) return;

      if (!activeSocket || activeSocket.readyState === WebSocket.CLOSED || activeSocket.readyState === WebSocket.CLOSING) {
        console.log("[Tunminal] Network wake detected with disconnected socket, reconnecting immediately...");
        reconnectController.reset();
        connectWebSocket(currentSessionId);
      } else if (activeSocket.readyState === WebSocket.OPEN) {
        console.log("[Tunminal] Network wake detected, sending urgent probe ping...");
        heartbeatController.probe(activeSocket, 2500);
      }
    };

    window.addEventListener("online", handleWake);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        handleWake();
      }
    });
    window.addEventListener("focus", () => {
      if (Date.now() - heartbeatController.lastPingTime > 2000) {
        handleWake();
      }
    });
  }

  function switchSession(sessionId) {
    if (currentSessionId === sessionId && activeSocket && activeSocket.readyState === WebSocket.OPEN) return;
    currentSessionId = sessionId;
    localStorage.setItem("tunminal_active_session", sessionId);

    if (activeSocket) {
      activeSocket.onclose = null;
      activeSocket.close();
      activeSocket = null;
    }
    reconnectController.reset();
    heartbeatController.stop();
    ptyCoalescer.reset();

    if (term) {
      term.reset();
    }
    guiParser.reset();

    document.querySelectorAll(".tab-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.id === sessionId);
    });

    updateViewModeVisibility();
    updateHeaderSessionTitle(getActiveSession());
    connectWebSocket(sessionId);
  }

  function connectWebSocket(sessionId) {
    reconnectController.resetTimer();
    heartbeatController.stop();
    ptyCoalescer.reset();

    statusEl.className = "status-badge connecting";
    statusEl.title = "Connecting...";

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/ws/${sessionId}?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    activeSocket = ws;

    ws.onopen = () => {
      if (ws !== activeSocket) return;
      reconnectController.reset();
      statusEl.className = "status-badge connected";
      statusEl.title = "Connected";

      if (fitAddon) {
        fitAddon.fit();
      }
      notifyTerminalResize();

      heartbeatController.start(ws);
    };

    ws.onmessage = (event) => {
      if (ws !== activeSocket) return;

      if (event.data instanceof ArrayBuffer) {
        ptyCoalescer.push(new Uint8Array(event.data));
      } else if (typeof event.data === "string") {
        if (event.data.includes('"pong"')) {
          try {
            const parsed = JSON.parse(event.data);
            if (parsed.type === "pong") {
              heartbeatController.handlePong(parsed);
            }
          } catch (e) {}
          return;
        }
        if (event.data.includes('"auth_error"')) {
          handleAuthFailure("Authentication failed: invalid token");
          return;
        }
        term.write(event.data);
        const textChunk = event.data;
        if (textChunk) {
          checkOscNotifications(textChunk);
          const session = getActiveSession();
          if (isAiAgentSession(session)) {
            guiParser.appendStream(textChunk);
          }
        }
      }
    };

    ws.onclose = async (event) => {
      if (ws !== activeSocket) return;
      heartbeatController.stop();
      ptyCoalescer.flush();
      resetLatencyBadge();
      statusEl.className = "status-badge disconnected";
      statusEl.title = "Disconnected";

      // 1. Explicit 4401 or auth rejection
      if (event.code === 4401) {
        handleAuthFailure("Authentication failed: invalid token");
        return;
      }

      // 2. Session not found (session closed or server restarted)
      if (event.code === 4404) {
        showToast("Previous terminal session was closed or expired");
        localStorage.removeItem("tunminal_active_session");
        currentSessionId = null;
        await refreshSessions();
        return;
      }

      // 3. Abnormal closure: check token validity
      if (token) {
        try {
          const checkRes = await fetch("/api/info", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (checkRes.status === 401) {
            handleAuthFailure("Authentication failed: invalid or expired token");
            return;
          }
        } catch (e) {
          // Network offline or server rebooting
        }
      }

      reconnectController.schedule(sessionId, () => {
        if (currentSessionId === sessionId) {
          connectWebSocket(sessionId);
        }
      });
    };

    ws.onerror = () => {
      statusEl.className = "status-badge disconnected";
    };
  }

  // 10. Latency Monitoring & Badge
  function updateLatencyBadge(latencyMs) {
    if (!latencyBadge) return;
    latencyBadge.classList.remove("hidden");
    latencyBadge.textContent = `${latencyMs} ms`;
    latencyBadge.classList.remove("good", "medium", "slow");
    if (latencyMs < 100) {
      latencyBadge.classList.add("good");
    } else if (latencyMs < 250) {
      latencyBadge.classList.add("medium");
    } else {
      latencyBadge.classList.add("slow");
    }
    latencyBadge.title = `WebSocket Ping Latency: ${latencyMs}ms`;
  }

  function resetLatencyBadge() {
    if (!latencyBadge) return;
    latencyBadge.textContent = "-- ms";
    latencyBadge.classList.remove("good", "medium", "slow");
    latencyBadge.classList.add("hidden");
  }

  // 11. Terminal Bell (Web Audio API) & OSC Notifications
  let audioCtx = null;
  let bellSoundEnabled = localStorage.getItem("tunminal_bell_enabled") !== "false";

  function updateBellButtonUI() {
    if (!btnBellToggle) return;
    if (bellSoundEnabled) {
      btnBellToggle.innerHTML = '<i class="fa-solid fa-bell"></i>';
      btnBellToggle.title = "Terminal Bell & Notifications: ON (click to mute)";
      btnBellToggle.classList.remove("muted");
    } else {
      btnBellToggle.innerHTML = '<i class="fa-solid fa-bell-slash"></i>';
      btnBellToggle.title = "Terminal Bell & Notifications: MUTED (click to enable)";
      btnBellToggle.classList.add("muted");
    }
  }

  function playBellSound() {
    if (!bellSoundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!audioCtx) {
        audioCtx = new AudioCtx();
      }
      if (audioCtx.state === "suspended") {
        audioCtx.resume();
      }
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz (A5)
      gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.32);
    } catch (e) {
      // Audio playback might need user interaction first
    }
  }

  function showTerminalNotification(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification(title || "Tunminal Notification", {
        body: body || "Task completed in terminal",
      });
    } catch (e) {}
  }

  function checkOscNotifications(chunk) {
    if (!chunk) return;
    // 1. BEL character (\x07)
    if (chunk.includes("\x07")) {
      playBellSound();
    }
    // 2. OSC 777 notification: \x1b]777;notify;TITLE;BODY\x07 or \x1b]777;notify;TITLE;BODY\x1b\
    const osc777 = /\x1b\]777;notify;([^;\x07\x1b]+)(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;
    let m777;
    while ((m777 = osc777.exec(chunk)) !== null) {
      playBellSound();
      if (document.hidden) {
        showTerminalNotification(m777[1], m777[2] || "");
      }
    }
    // 3. OSC 9 notification: \x1b]9;BODY\x07 or \x1b]9;BODY\x1b\
    const osc9 = /\x1b\]9;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
    let m9;
    while ((m9 = osc9.exec(chunk)) !== null) {
      playBellSound();
      if (document.hidden) {
        showTerminalNotification("Tunminal Notification", m9[1]);
      }
    }
  }

  function setupBellAndNotifications() {
    if (btnBellToggle) {
      btnBellToggle.addEventListener("click", () => {
        bellSoundEnabled = !bellSoundEnabled;
        localStorage.setItem("tunminal_bell_enabled", bellSoundEnabled ? "true" : "false");
        updateBellButtonUI();
        if ("Notification" in window && Notification.permission === "default") {
          Notification.requestPermission().catch(() => {});
        }
        if (bellSoundEnabled) {
          playBellSound();
          showToast("Sound notifications enabled");
        } else {
          showToast("Sound notifications muted");
        }
      });
      updateBellButtonUI();
    }
  }

  // 12. File Transfer & Session Explorer
  let currentFilesPath = "";

  function formatBytes(bytes) {
    if (bytes === 0 || !bytes) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  async function uploadFiles(sessionId, fileList, subpath = "") {
    if (!sessionId) return;
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      showToast(`Uploading ${file.name}...`);
      try {
        const query = new URLSearchParams({
          filename: file.name,
          subpath: subpath,
        });
        const res = await fetch(`/api/sessions/${sessionId}/upload?${query.toString()}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/octet-stream",
          },
          body: file,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          showToast(`Upload failed: ${data.detail || res.statusText}`);
        } else {
          showToast(`Uploaded ${file.name} (${formatBytes(file.size)})`);
        }
      } catch (e) {
        showToast(`Upload failed: ${e.message}`);
      }
    }
    if (filesModal && filesModal.open) {
      await loadSessionFiles(sessionId, currentFilesPath);
    }
  }

  async function downloadFile(sessionId, filePath, fileName) {
    showToast(`Downloading ${fileName}...`);
    try {
      const query = new URLSearchParams({ path: filePath });
      const res = await fetch(`/api/sessions/${sessionId}/download?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        showToast("Download failed");
        return;
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      showToast(`Download failed: ${e.message}`);
    }
  }

  async function loadSessionFiles(sessionId, relPath = "") {
    if (!sessionId) return;
    currentFilesPath = relPath;
    try {
      const query = relPath ? `?path=${encodeURIComponent(relPath)}` : "";
      const res = await apiFetch(`/api/sessions/${sessionId}/files${query}`);
      if (!res.ok) {
        showToast("Failed to load session files");
        return;
      }
      const data = await res.json();
      renderFilesList(sessionId, data);
    } catch (e) {
      showToast("Error loading files");
    }
  }

  function renderFilesList(sessionId, data) {
    const filesCurrentDir = document.getElementById("files-current-dir");
    const filesBreadcrumb = document.getElementById("files-breadcrumb");
    const filesTableBody = document.getElementById("files-table-body");

    if (filesCurrentDir) {
      filesCurrentDir.textContent = `Working directory: ${data.cwd}`;
    }

    if (filesBreadcrumb) {
      filesBreadcrumb.innerHTML = "";
      const rootSpan = document.createElement("span");
      rootSpan.className = "breadcrumb-segment";
      rootSpan.textContent = "root";
      rootSpan.addEventListener("click", () => loadSessionFiles(sessionId, ""));
      filesBreadcrumb.appendChild(rootSpan);

      if (data.current_path) {
        const parts = data.current_path.split("/").filter(Boolean);
        let accum = "";
        parts.forEach((p) => {
          accum = accum ? `${accum}/${p}` : p;
          const currentAccum = accum;
          const sep = document.createElement("span");
          sep.className = "breadcrumb-sep";
          sep.textContent = " / ";
          filesBreadcrumb.appendChild(sep);

          const seg = document.createElement("span");
          seg.className = "breadcrumb-segment";
          seg.textContent = p;
          seg.addEventListener("click", () => loadSessionFiles(sessionId, currentAccum));
          filesBreadcrumb.appendChild(seg);
        });
      }
    }

    if (filesTableBody) {
      filesTableBody.innerHTML = "";

      if (data.current_path) {
        const parentParts = data.current_path.split("/").filter(Boolean);
        parentParts.pop();
        const parentPath = parentParts.join("/");
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>
            <div class="file-row-name">
              <span><i class="fa-regular fa-folder"></i></span>
              <span class="file-dir-link">..</span>
            </div>
          </td>
          <td class="col-size">-</td>
          <td class="col-date">-</td>
          <td class="col-action"></td>
        `;
        tr.querySelector(".file-dir-link").addEventListener("click", () => {
          loadSessionFiles(sessionId, parentPath);
        });
        filesTableBody.appendChild(tr);
      }

      if (!data.items || data.items.length === 0) {
        const emptyTr = document.createElement("tr");
        emptyTr.innerHTML = `<td colspan="4" class="files-empty">No files in this directory</td>`;
        filesTableBody.appendChild(emptyTr);
        return;
      }

      data.items.forEach((item) => {
        const tr = document.createElement("tr");
        const itemRelPath = data.current_path ? `${data.current_path}/${item.name}` : item.name;
        const icon = item.is_dir ? '<i class="fa-regular fa-folder"></i>' : '<i class="fa-regular fa-file-lines"></i>';
        const dateStr = item.mtime ? new Date(item.mtime * 1000).toLocaleString() : "-";
        const sizeStr = item.is_dir ? "-" : formatBytes(item.size);

        tr.innerHTML = `
          <td>
            <div class="file-row-name">
              <span>${icon}</span>
              ${
                item.is_dir
                  ? `<span class="file-dir-link">${escapeHtml(item.name)}</span>`
                  : `<span class="file-link">${escapeHtml(item.name)}</span>`
              }
            </div>
          </td>
          <td class="col-size">${sizeStr}</td>
          <td class="col-date">${dateStr}</td>
          <td class="col-action">
            ${
              !item.is_dir
                ? `<button type="button" class="btn btn-sm btn-download" title="Download"><i class="fa-solid fa-download"></i></button>`
                : ""
            }
          </td>
        `;

        if (item.is_dir) {
          tr.querySelector(".file-dir-link").addEventListener("click", () => {
            loadSessionFiles(sessionId, itemRelPath);
          });
        } else {
          const dlBtn = tr.querySelector(".btn-download");
          if (dlBtn) {
            dlBtn.addEventListener("click", () => {
              downloadFile(sessionId, itemRelPath, item.name);
            });
          }
        }

        filesTableBody.appendChild(tr);
      });
    }
  }

  function setupFileTransfer() {
    if (fileDropOverlay) {
      fileDropOverlay.classList.add("hidden");
    }

    const fileDropClose = document.getElementById("file-drop-close");
    if (fileDropClose) {
      fileDropClose.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounter = 0;
        if (fileDropOverlay) fileDropOverlay.classList.add("hidden");
      });
    }

    if (fileDropOverlay) {
      fileDropOverlay.addEventListener("click", (e) => {
        if (e.target === fileDropOverlay || e.target.closest("#file-drop-close")) {
          dragCounter = 0;
          fileDropOverlay.classList.add("hidden");
        }
      });
    }

    let dragCounter = 0;
    window.addEventListener("dragenter", (e) => {
      // Don't show drop overlay unless drag contains actual files (prevents touch/scroll false triggers)
      if (e.dataTransfer && e.dataTransfer.types) {
        const types = Array.from(e.dataTransfer.types);
        if (!types.includes("Files")) {
          return;
        }
      } else {
        return;
      }
      e.preventDefault();
      dragCounter++;
      if (currentSessionId && fileDropOverlay) {
        fileDropOverlay.classList.remove("hidden");
      }
    });

    window.addEventListener("dragover", (e) => {
      if (e.dataTransfer && e.dataTransfer.types) {
        const types = Array.from(e.dataTransfer.types);
        if (!types.includes("Files")) {
          return;
        }
      }
      e.preventDefault();
    });

    window.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        if (fileDropOverlay) fileDropOverlay.classList.add("hidden");
      }
    });

    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      dragCounter = 0;
      if (fileDropOverlay) fileDropOverlay.classList.add("hidden");
      if (!currentSessionId) return;

      const files = e.dataTransfer ? e.dataTransfer.files : null;
      if (files && files.length > 0) {
        await uploadFiles(currentSessionId, files, currentFilesPath);
      }
    });

    const filesModalClose = document.getElementById("files-modal-close");
    const filesModalDone = document.getElementById("files-modal-done");
    const btnFilesUpload = document.getElementById("btn-files-upload");
    const filesHiddenInput = document.getElementById("files-hidden-input");
    const btnFilesRefresh = document.getElementById("btn-files-refresh");

    if (btnFilesModal) {
      btnFilesModal.addEventListener("click", async () => {
        if (!currentSessionId) {
          showToast("No active terminal session");
          return;
        }
        currentFilesPath = "";
        await loadSessionFiles(currentSessionId, "");
        if (filesModal) filesModal.showModal();
      });
    }

    if (filesModalClose) {
      filesModalClose.addEventListener("click", () => filesModal.close());
    }

    if (filesModalDone) {
      filesModalDone.addEventListener("click", () => filesModal.close());
    }

    if (btnFilesRefresh) {
      btnFilesRefresh.addEventListener("click", () => {
        if (currentSessionId) {
          loadSessionFiles(currentSessionId, currentFilesPath);
        }
      });
    }

    if (btnFilesUpload && filesHiddenInput) {
      btnFilesUpload.addEventListener("click", () => {
        filesHiddenInput.click();
      });

      filesHiddenInput.addEventListener("change", async () => {
        if (filesHiddenInput.files && filesHiddenInput.files.length > 0) {
          await uploadFiles(currentSessionId, filesHiddenInput.files, currentFilesPath);
          filesHiddenInput.value = "";
        }
      });
    }
  }

  // 13. Sessions Manager Dialog
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

  // 11. Mobile Virtual Keypad & Shortcuts
  function setupKeypad() {
    if (modCtrlBtn) {
      modCtrlBtn.addEventListener("click", () => {
        isCtrlActive = !isCtrlActive;
        modCtrlBtn.classList.toggle("active", isCtrlActive);
      });
    }

    if (modAltBtn) {
      modAltBtn.addEventListener("click", () => {
        isAltActive = !isAltActive;
        modAltBtn.classList.toggle("active", isAltActive);
      });
    }

    document.querySelectorAll(".key-pill[data-key], .key-btn[data-key]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const key = btn.getAttribute("data-key");
        handleSpecialKey(key);
      });
    });

    document.querySelectorAll(".key-pill[data-shortcut], .key-btn[data-shortcut]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const sc = btn.getAttribute("data-shortcut");
        if (sc === "ctrl-c") sendTerminalInput("\x03");
        else if (sc === "ctrl-d") sendTerminalInput("\x04");
        else if (sc === "ctrl-l") sendTerminalInput("\x0c");
        else if (sc === "shift-tab") sendTerminalInput("\x1b[Z");
      });
    });

    document.querySelectorAll(".key-pill[data-send], .key-btn[data-send]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const char = btn.getAttribute("data-send");
        sendTerminalInput(char);
      });
    });

    const pasteBtn = document.getElementById("btn-paste");
    if (pasteBtn) {
      pasteBtn.addEventListener("click", async () => {
        if (navigator.clipboard && navigator.clipboard.readText) {
          try {
            const text = await navigator.clipboard.readText();
            if (text) {
              sendTerminalInput(text);
              return;
            }
          } catch (err) {}
        }
        textInputModal.showModal();
      });
    }

    const inputModalBtn = document.getElementById("btn-input-modal");
    if (inputModalBtn) {
      inputModalBtn.addEventListener("click", () => {
        document.getElementById("mobile-text-content").value = "";
        textInputModal.showModal();
      });
    }

    const textModalCancel = document.getElementById("text-modal-cancel");
    if (textModalCancel) {
      textModalCancel.addEventListener("click", () => {
        textInputModal.close();
      });
    }

    const textInputForm = document.getElementById("text-input-form");
    if (textInputForm) {
      textInputForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const content = document.getElementById("mobile-text-content").value;
        if (content) {
          sendTerminalInput(content + "\r");
        }
        textInputModal.close();
      });
    }

    const toggleKeypadBtn = document.getElementById("btn-toggle-keypad");
    if (toggleKeypadBtn) {
      toggleKeypadBtn.addEventListener("click", () => {
        mobileKeypad.classList.toggle("hidden");
        if (currentViewMode === "terminal" && fitAddon) {
          setTimeout(() => fitAddon.fit(), 100);
        }
      });
    }

    // Mobile Drawer & Sessions Click Handlers
    if (btnMenuDrawer) {
      btnMenuDrawer.addEventListener("click", async () => {
        await refreshSessions();
        if (sessionsModal) sessionsModal.showModal();
      });
    }
    if (headerActiveSession) {
      headerActiveSession.addEventListener("click", async () => {
        await refreshSessions();
        if (sessionsModal) sessionsModal.showModal();
      });
    }

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
      const cwd = document.getElementById("custom-cwd").value.trim() || null;
      const name = document.getElementById("custom-name").value.trim() || null;
      createNewSession(cmd, name, cwd);
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

  // 12. Helpers
  function showToast(msg, duration = 3000) {
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
