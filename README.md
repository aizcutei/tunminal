# ⚡ Tunminal

**Tunminal** is a lightweight, cross-platform web terminal server engineered to provide browser access to local terminal apps—specifically interactive AI developer tools like **Claude Code** (`claude`) and **Codex** (`codex`), as well as system shells (`zsh`, `bash`, `powershell`).

With built-in **Cloudflare Tunnel** support and a **mobile-first virtual keypad**, you can control AI coding agents running on your desktop or server directly from your phone browser from anywhere in the world.

---

## 🌟 Highlights

- 🎭 **Dual-Mode UI (Raw Terminal vs Modern Web GUI)**:
  - **Switch with 1 Tap**: Seamlessly toggle between `[ 💻 Terminal ]` and `[ ✨ GUI ]` at any moment with zero state loss.
  - **Modern App GUI**: A chat app interface mimicking official desktop apps (Claude Desktop / Codex Composer) featuring user cards, assistant bubbles, markdown styling, copyable code blocks, and tool execution badges.
  - **Modern Composer**: Auto-expanding prompt input box, send button, cancel button (`■` / `^C`), and quick command chips (`/help`, `/compact`, `/cost`, `/clear`).
- 🎨 **Terminal Color Themes**:
  - Switch color themes on the fly from the `🎨` Theme modal.
  - Includes 8 themes: **Tunminal Dark**, **Dracula**, **Tokyo Night**, **One Dark**, **Nord**, **Monokai Pro**, **Solarized Dark**, and **GitHub Light**.
  - Persists your preference across sessions and devices.
- 📱 **Mobile-First Ergonomics**:
  - **Touch Virtual Keypad**: Dedicated floating/docked keys for `ESC`, `TAB`, `CTRL`, `ALT`, `↑`, `↓`, `←`, `→`, `Enter`, and shortcuts (`^C`, `^D`, `^L`, `/`, `~`, `|`).
  - **Visual Viewport Compensation**: Responsive layout that automatically shrinks and repositions xterm when the soft on-screen keyboard slides up on iOS Safari or Android Chrome.
  - **Mobile Dictation / Text Dialog**: A dedicated mobile text input dialog for effortless prompt typing, dictation, and IME composition without struggling with raw canvas touch events.
- 🔄 **Persistent Background Sessions & Browser Reopen Pick-Up**:
  - PTY processes run in the background independent of client connection state.
  - **Close Browser Safely**: You can close your mobile or desktop browser completely, and your running Claude Code, Codex, or shell sessions will keep executing uninterrupted.
  - **Auto-Resume**: Reopening your browser automatically reconnects to your last active terminal session, with recent scrollback replayed instantly.
  - **Running Terminals Manager (📑)**: View all active background terminals, inspect uptime/PID, switch between them, rename, or start new ones at any time.
- 🌐 **Instant Cloudflare Tunnel**:
  - Automatically starts a Cloudflare Quick Tunnel (`cloudflared tunnel --url ...`).
  - Generates a public HTTPS link (`https://*.trycloudflare.com`).
  - Renders a high-contrast **scannable QR code** in your terminal—just point your phone's camera at your screen to connect!
- 🔒 **Built-in Security**:
  - Mandatory token authentication on all HTTP endpoints and WebSockets.
  - Magic login links with automatic secure cookie persistence for seamless mobile logins.
- 🔔 **System Tray / Taskbar Integration (Windows, macOS, Linux)**:
  - **Cross-Platform Status Icon**: Runs in the macOS menu bar, Windows system tray/taskbar notification area, and Linux tray (X11 & Wayland).
  - **Context Menu**: Instantly inspect status (active session count, bound port, tunnel URL), **Open Web Terminal** in default browser, **Copy Access URL** to clipboard, re-print QR Code, or **Exit Tunminal** cleanly.
  - **Headless Fallback**: Automatically switches to pure console mode when running in headless servers or via `--no-tray`.
- 📦 **Single Standalone Executables**:
  - Precompiled, single-file runnable binaries available for **Windows (x86_64)**, **macOS (Apple Silicon arm64 & Intel x86_64)**, and **Linux (x86_64)**.
  - Run immediately without needing Python, uv, or node installed.
- 💻 **True Cross-Platform**:
  - **macOS & Linux**: Native POSIX pseudo-terminals (`os.openpty`, `termios`).
  - **Windows 10/11 / Server**: Windows ConPTY support via `pywinpty`.

---

## 🚀 Quick Start

### Prerequisites
- Python 3.12+
- [uv](https://github.com/astral-sh/uv) (fast Python package manager)
- (Optional but recommended) `cloudflared` for remote internet access

### Run Tunminal

Clone the repository and launch directly with `uv`:

```bash
# Clone repository
git clone https://github.com/your-username/tunminal.git
cd tunminal

# Start Tunminal server with default shell and Cloudflare Tunnel
uv run tunminal
```

### Launching with AI Coding Agents

Run directly with **Claude Code**:
```bash
uv run tunminal --cmd "claude"
```

Run directly with **Codex**:
```bash
uv run tunminal --cmd "codex"
```

Run with custom port, host, or directory:
```bash
uv run tunminal --port 9000 --cwd ~/workspace/my-project
```

Run in local-only mode (without Cloudflare Tunnel):
```bash
uv run tunminal --no-tunnel
```

---

## ☁️ Cloudflare Tunnel Setup

Tunminal automatically discovers and runs `cloudflared` if installed on your system.

### Installing `cloudflared`

#### macOS (Homebrew)
```bash
brew install cloudflared
```

#### Windows (WinGet / Scoop / Chocolatey)
```powershell
winget install --id Cloudflare.cloudflared
# or
choco install cloudflared
```

#### Linux (Debian / Ubuntu / Arch)
```bash
# Debian / Ubuntu:
sudo apt-get install cloudflared

# Or direct binary download:
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared
```

Once installed, running `uv run tunminal` will automatically initialize a secure tunnel and display a scannable QR code in your console:

```
  _____                  _             _ 
 |_   _|   _ _ __  _ __ (_)_ __   __ _| |
   | || | | | '_ \| '_ \| | '_ \ / _` | |
   | || |_| | | | | | | | | | | | (_| | |
   |_| \__,_|_| |_|_| |_|_|_| |_|\__,_|_|
   Web Terminal & Remote AI Agent Bridge

[*] Starting Cloudflare Tunnel...
--------------------------------------------------------
  Local Access:      http://127.0.0.1:8080/?token=abc123...
  Remote (Tunnel):   https://quick-name.trycloudflare.com/?token=abc123...

==================================================
  Scan with Phone Camera for Remote Access:
==================================================
  [ ANSI QR CODE ]
==================================================
```

---

## ⌨️ Mobile Interface Controls

| Key / Control | Purpose |
|---------------|---------|
| `ESC` | Cancel current selection, exit prompt, or close dialogs in Claude Code / Codex |
| `TAB` | Trigger autocomplete for commands, filepaths, and agent recommendations |
| `CTRL` / `ALT` | Sticky modifier toggle (turns green when armed for the next keypress) |
| `▲ ▼ ◀ ▶` | Arrow keys for navigating interactive agent menus and terminal history |
| `^C` | Send `SIGINT` / Ctrl+C to cancel current generation or interrupt command |
| `^D` | Send EOF / Ctrl+D to exit shell or end stdin |
| `^L` | Clear screen |
| `/` | Quick slash for Claude Code commands (`/help`, `/compact`, `/bug`) |
| `💬 Text` | Open comfortable native text input dialog (supports dictation & mobile IMEs) |
| `📋` | Paste clipboard content directly into terminal |
| `📑` | Open Running Terminals Manager to inspect, resume, or rename background sessions |
| `+` | Open modal to create new sessions (Claude, Codex, Shell, or Custom) |

---

## 🛠️ CLI Options

```
usage: tunminal [-h] [--host HOST] [--port PORT] [--token TOKEN] [--cmd CMD]
                [--cwd CWD] [--tunnel | --no-tunnel] [--tray | --no-tray]

options:
  -h, --help            show this help message and exit
  --host HOST           Host to bind the server on (default: 127.0.0.1)
  --port PORT           Port to bind the server on (default: 8080)
  --token TOKEN         Authentication token (auto-generated or loaded from ~/.tunminal/token)
  --cmd CMD             Initial command to run (e.g. 'claude', 'codex', or shell)
  --cwd CWD             Working directory for sessions (default: current directory)
  --tunnel, --no-tunnel Enable/disable Cloudflare Tunnel (default: enabled)
  --tray, --no-tray     Enable/disable system tray / taskbar icon (default: enabled when GUI is available)
```

---

## 📦 Standalone Binary Compilation

To build a standalone binary locally without relying on Python runtime:

```bash
uv run pyinstaller --noconfirm --clean tunminal.spec
```

The output single executable will be located in `dist/tunminal` (or `dist/tunminal.exe` on Windows).
Standalone executables for Linux, Windows, macOS ARM64, and macOS Intel are automatically built and published by the **GitHub Actions CI** on every release.

---

## 🧪 Running Tests

Run the test suite using `pytest`:

```bash
uv run pytest
```

---

## 📄 License

MIT License. See [LICENSE](LICENSE) for details.
