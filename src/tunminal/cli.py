import argparse
import atexit
import os
import signal
import sys
import uvicorn

from tunminal.pty import detect_cli_tools, get_default_shell
from tunminal.security import AuthManager
from tunminal.server import create_app
from tunminal.session import SessionManager
from tunminal.tray import TunminalTrayApp, is_tray_available
from tunminal.tunnel import CloudflareTunnel, get_install_instructions

BANNER = r"""
  _____                  _             _ 
 |_   _|   _ _ __  _ __ (_)_ __   __ _| |
   | || | | | '_ \| '_ \| | '_ \ / _` | |
   | || |_| | | | | | | | | | | | (_| | |
   |_| \__,_|_| |_|_| |_|_|_| |_|\__,_|_|
   Web Terminal & Remote AI Agent Bridge
"""


def main():
    parser = argparse.ArgumentParser(
        description="Tunminal: Cross-platform web terminal server for remote mobile access to Claude Code, Codex, and local shells."
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host to bind the server on (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8080,
        help="Port to bind the server on (default: 8080)",
    )
    parser.add_argument(
        "--token",
        default=None,
        help="Authentication token (auto-generated or loaded from ~/.tunminal/token)",
    )
    parser.add_argument(
        "--cmd",
        default=None,
        help="Initial command to run (e.g. 'claude', 'codex', or shell)",
    )
    parser.add_argument(
        "--cwd",
        default=os.getcwd(),
        help="Working directory for sessions (default: current directory)",
    )
    parser.add_argument(
        "--tunnel",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable/disable Cloudflare Tunnel (default: enabled)",
    )
    parser.add_argument(
        "--tray",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable/disable system tray / taskbar icon (default: enabled when GUI display is available)",
    )

    args = parser.parse_args()

    print(BANNER)

    # 1. Initialize Authentication
    auth = AuthManager(token=args.token)

    # 2. Initialize Session Manager
    session_mgr = SessionManager(default_cwd=args.cwd)

    # Pre-create initial session if requested or default
    initial_cmd = args.cmd
    session_name = "Initial Session"
    if initial_cmd:
        session_name = initial_cmd.split()[0]
    session_mgr.create_session(name=session_name, command=initial_cmd)

    # 3. Create FastAPI app
    app = create_app(auth_manager=auth, session_manager=session_mgr, default_cmd=initial_cmd)

    # 4. Handle Cloudflare Tunnel
    tunnel: CloudflareTunnel = None
    remote_url = None

    if args.tunnel:
        tunnel = CloudflareTunnel(local_port=args.port, host=args.host)
        if tunnel.is_available():
            print("\033[1;33m[*] Starting Cloudflare Tunnel...\033[0m")
            tunnel_url = tunnel.start(timeout=20.0)
            if tunnel_url:
                remote_url = auth.make_magic_url(tunnel_url)
            else:
                print("\033[1;31m[!] Cloudflare Tunnel timed out or failed to start.\033[0m")
        else:
            print("\033[1;33m[*] Notice: `cloudflared` executable was not found.\033[0m")
            print("    To access Tunminal remotely from your phone over the internet:")
            print(f"    {get_install_instructions()}\n")

    local_url = auth.make_magic_url(f"http://{args.host}:{args.port}")

    # 5. Display Access URLs & QR Codes
    print("-" * 56)
    print(f"  Local Access:      \033[1;32m{local_url}\033[0m")
    if remote_url:
        print(f"  Remote (Tunnel):   \033[1;36m{remote_url}\033[0m")
        auth.print_qr_code(remote_url, label="Scan with Phone Camera for Remote Access:")
    else:
        auth.print_qr_code(local_url, label="Scan with Phone Camera for Local Network Access:")
    print("-" * 56)

    # Detected CLI Tools
    tools = detect_cli_tools()
    detected = [t for t, avail in tools.items() if avail and t != "shell"]
    if detected:
        print(f"  Detected AI CLI tools: {', '.join(detected)}")
    print(f"  Auth Token: \033[1m{auth.token}\033[0m")
    print("-" * 56 + "\n")

    # Cleanup hook
    def cleanup():
        if tunnel:
            try:
                tunnel.stop()
            except Exception:
                pass
        session_mgr.close_all()

    atexit.register(cleanup)

    # 6. Run Server (with Taskbar Tray if available and enabled)
    should_run_tray = args.tray and is_tray_available()
    server_config = uvicorn.Config(app, host=args.host, port=args.port, log_level="warning")
    server = uvicorn.Server(server_config)

    if should_run_tray:
        tray_app = TunminalTrayApp(
            session_manager=session_mgr,
            auth_manager=auth,
            local_url=local_url,
            remote_url=remote_url,
            port=args.port,
            on_exit=cleanup,
        )
        try:
            tray_app.run(server=server)
        except KeyboardInterrupt:
            print("\n[*] Shutting down Tunminal...")
        finally:
            cleanup()
    else:
        if not args.tray:
            print("\033[1;33m[*] Taskbar tray disabled via --no-tray.\033[0m\n")
        else:
            print("\033[1;33m[*] Running in console-only mode (headless environment).\033[0m\n")
        try:
            server.run()
        except KeyboardInterrupt:
            print("\n[*] Shutting down Tunminal...")
        finally:
            cleanup()


if __name__ == "__main__":
    main()
