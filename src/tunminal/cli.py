import argparse
import atexit
import logging
import os
import signal
import sys
import uvicorn

from tunminal.pty import detect_cli_tools, get_default_shell
from tunminal.security import AuthManager
from tunminal.server import create_app
from tunminal.session import SessionManager
from tunminal.tray import TunminalTrayApp, is_tray_available
from tunminal.tunnel import (
    CloudflareTunnel,
    ServiceStatus,
    detect_existing_tunnel,
    get_install_instructions,
)


class InvalidHttpRequestFilter(logging.Filter):
    """Provide a friendly hint when TLS/HTTPS handshake is sent to plain HTTP port."""

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "Invalid HTTP request received" in msg:
            record.msg = "Invalid HTTP request received (Tip: Local access uses http://, not https://)"
        return True


def patch_windows_asyncio_connection_reset():
    """Silence harmless Windows asyncio WinError 10054 on remote connection reset."""
    if sys.platform != "win32":
        return

    try:
        from asyncio.proactor_events import _ProactorBasePipeTransport
        orig_call_connection_lost = _ProactorBasePipeTransport._call_connection_lost

        def _safe_call_connection_lost(self, exc):
            try:
                orig_call_connection_lost(self, exc)
            except (ConnectionResetError, ConnectionAbortedError, OSError):
                # Remote client closed or reset connection abruptly before socket shutdown
                if getattr(self, "_sock", None) is not None:
                    try:
                        self._sock.close()
                    except Exception:
                        pass
                    self._sock = None
                self._called_connection_lost = True

        _ProactorBasePipeTransport._call_connection_lost = _safe_call_connection_lost
    except Exception:
        pass


BANNER = r"""
  _____                  _             _ 
 |_   _|   _ _ __  _ __ (_)_ __   __ _| |
   | || | | | '_ \| '_ \| | '_ \ / _` | |
   | || |_| | | | | | | | | | | | (_| | |
   |_| \__,_|_| |_|_| |_|_|_| |_|\__,_|_|
   Web Terminal & Remote AI Agent Bridge
"""


def main():
    patch_windows_asyncio_connection_reset()
    logging.getLogger("uvicorn.error").addFilter(InvalidHttpRequestFilter())

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
        "--tunnel-token",
        default=os.environ.get("TUNMINAL_TUNNEL_TOKEN", None),
        help="Cloudflare Named Tunnel token (enables permanent fixed Named Tunnel)",
    )
    parser.add_argument(
        "--tunnel-url",
        default=os.environ.get("TUNMINAL_TUNNEL_URL", None),
        help="Custom public URL/domain for Named Tunnel (e.g. https://term.yourdomain.com)",
    )
    parser.add_argument(
        "--tunnel-protocol",
        default="http2",
        choices=["http2", "quic", "auto"],
        help="Network protocol for cloudflared (default: http2 for optimal TCP stability)",
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
    session_mgr.create_session(
        name=session_name,
        command=initial_cmd,
        cwd=args.cwd,
        cols=120,
        rows=30,
    )

    # 3. Create FastAPI app
    app = create_app(auth_manager=auth, session_manager=session_mgr, default_cmd=initial_cmd)

    # 4. Handle Cloudflare Tunnel
    tunnel: Optional[CloudflareTunnel] = None
    remote_url = None
    tunnel_label = "Tunnel HTTPS"

    if args.tunnel:
        if args.tunnel_token:
            # Priority 1: User explicitly provided a tunnel token
            tunnel = CloudflareTunnel(
                local_port=args.port,
                host=args.host,
                tunnel_token=args.tunnel_token,
                protocol=args.tunnel_protocol,
            )
            if tunnel.is_available():
                print(f"\033[1;33m[*] Starting Cloudflare Named Tunnel (Token Mode, {args.tunnel_protocol})...\033[0m")
                tunnel.start(timeout=10.0)
                tunnel_label = "Named Tunnel (Token)"
                if args.tunnel_url:
                    pub_url = args.tunnel_url
                    if not pub_url.startswith("http://") and not pub_url.startswith("https://"):
                        pub_url = f"https://{pub_url}"
                    remote_url = auth.make_magic_url(pub_url)
                else:
                    print("\033[1;36m[*] Named Tunnel running with token.\033[0m")
                    print("    Tip: Use --tunnel-url https://<your-domain> to generate mobile magic link & QR code.\n")
            else:
                print("\033[1;33m[*] Notice: `cloudflared` executable was not found.\033[0m")
                print(f"    {get_install_instructions()}\n")
        else:
            # Priority 2: Auto-detect if a system service or local config already exists
            existing = detect_existing_tunnel(port=args.port)
            if existing.service_status == ServiceStatus.RUNNING:
                tunnel_label = "Named Tunnel (System Service)"
                print(f"\033[1;32m[*] Detected active Cloudflare system service ({existing.service_name or 'Cloudflared'}).\033[0m")
                pub_url = args.tunnel_url or existing.detected_hostname
                if pub_url:
                    if not pub_url.startswith("http://") and not pub_url.startswith("https://"):
                        pub_url = f"https://{pub_url}"
                    remote_url = auth.make_magic_url(pub_url)
                else:
                    print("    Using existing background Named Tunnel.")
                    print("    Tip: Pass --tunnel-url https://<your-domain> to display mobile magic link & QR code.\n")
            elif existing.service_status == ServiceStatus.STOPPED:
                print(f"\033[1;33m[*] Notice: Found installed Cloudflare service '{existing.service_name}', but it is STOPPED (shows DOWN in dashboard).\033[0m")
                if sys.platform == "win32":
                    print("    To start it as Administrator: Start-Service Cloudflared (or: sc.exe start Cloudflared)")
                else:
                    print("    To start it: sudo systemctl start cloudflared")
                print("    Falling back to Cloudflare Quick Tunnel (HTTP/2)...\n")

                tunnel = CloudflareTunnel(
                    local_port=args.port,
                    host=args.host,
                    protocol=args.tunnel_protocol,
                )
                if tunnel.is_available():
                    print(f"\033[1;33m[*] Starting Cloudflare Quick Tunnel ({args.tunnel_protocol})...\033[0m")
                    tunnel_url = tunnel.start(timeout=25.0)
                    if tunnel_url:
                        remote_url = auth.make_magic_url(tunnel_url)
                        tunnel_label = "Quick Tunnel HTTPS"
                    else:
                        print("\033[1;31m[!] Cloudflare Tunnel timed out or failed to start.\033[0m")
                else:
                    print("\033[1;33m[*] Notice: `cloudflared` executable was not found.\033[0m")
                    print(f"    {get_install_instructions()}\n")
            else:
                # Priority 3: Start Quick Tunnel with HTTP/2
                tunnel = CloudflareTunnel(
                    local_port=args.port,
                    host=args.host,
                    protocol=args.tunnel_protocol,
                )
                if tunnel.is_available():
                    print(f"\033[1;33m[*] Starting Cloudflare Quick Tunnel ({args.tunnel_protocol})...\033[0m")
                    tunnel_url = tunnel.start(timeout=25.0)
                    if tunnel_url:
                        remote_url = auth.make_magic_url(tunnel_url)
                        tunnel_label = "Quick Tunnel HTTPS"
                    else:
                        print("\033[1;31m[!] Cloudflare Tunnel timed out or failed to start.\033[0m")
                else:
                    print("\033[1;33m[*] Notice: `cloudflared` executable was not found.\033[0m")
                    print(f"    {get_install_instructions()}\n")

    local_url = auth.make_magic_url(f"http://{args.host}:{args.port}")

    # 5. Display Access URLs & QR Codes
    print("-" * 56)
    print(f"  Local Access (HTTP):     \033[1;32m{local_url}\033[0m")
    if remote_url:
        print(f"  Remote ({tunnel_label}): \033[1;36m{remote_url}\033[0m")
        auth.print_qr_code(remote_url, label=f"Scan with Phone Camera for Remote Access ({tunnel_label}):")
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
