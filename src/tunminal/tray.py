import logging
import os
import signal
import subprocess
import sys
import threading
import webbrowser
from typing import Callable, Optional

logger = logging.getLogger("tunminal.tray")


def is_tray_available() -> bool:
    """Check if system tray GUI is supported in the current environment."""
    # Headless checks
    if sys.platform.startswith("linux"):
        # Must have X11 or Wayland display available
        if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
            return False

    try:
        import pystray
        from PIL import Image
        if hasattr(pystray, "backend"):
            _ = pystray.backend()
        return True
    except Exception as e:
        logger.debug("Tray not available: %s", e)
        return False


def create_tray_icon_image():
    """Dynamically render a 64x64 RGBA Tunminal lightning-bolt icon."""
    from PIL import Image, ImageDraw

    size = 64
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    # Outer circle badge (dark slate with vibrant blue border)
    draw.ellipse(
        (2, 2, size - 3, size - 3),
        fill=(22, 27, 34, 255),
        outline=(88, 166, 255, 255),
        width=3,
    )

    # Golden lightning bolt symbol ⚡
    points = [
        (35, 10),
        (18, 34),
        (31, 34),
        (27, 54),
        (47, 28),
        (35, 28),
    ]
    draw.polygon(points, fill=(245, 158, 11, 255))
    return image


def copy_to_clipboard(text: str) -> bool:
    """Copy text to system clipboard across Windows, macOS, and Linux (Wayland/X11)."""
    try:
        if sys.platform == "darwin":
            subprocess.run(["pbcopy"], input=text.encode("utf-8"), check=True)
            return True
        elif sys.platform == "win32":
            subprocess.run(["clip"], input=text.encode("utf-8"), check=True, shell=True)
            return True
        else:
            # Linux: try wl-copy (Wayland), then xclip, then xsel (X11)
            candidates = [
                ["wl-copy"],
                ["xclip", "-selection", "clipboard"],
                ["xsel", "--clipboard", "--input"],
            ]
            for cmd in candidates:
                try:
                    subprocess.run(cmd, input=text.encode("utf-8"), check=True)
                    return True
                except FileNotFoundError:
                    continue
    except Exception as e:
        logger.warning("Failed to copy to clipboard: %s", e)
    return False


class TunminalTrayApp:
    """Cross-platform Taskbar / System Tray integration for Tunminal."""

    def __init__(
        self,
        session_manager,
        auth_manager,
        local_url: str,
        remote_url: Optional[str] = None,
        port: int = 8080,
        on_exit: Optional[Callable[[], None]] = None,
    ):
        self.session_manager = session_manager
        self.auth_manager = auth_manager
        self.local_url = local_url
        self.remote_url = remote_url
        self.port = port
        self.on_exit = on_exit

        self.icon = None
        self.server = None
        self._server_thread = None
        self._is_running = False

    def get_active_url(self) -> str:
        return self.remote_url if self.remote_url else self.local_url

    def _get_status_text(self) -> str:
        try:
            sessions = self.session_manager.list_sessions()
            alive = sum(1 for s in sessions if s.get("alive"))
            return f"⚡ Tunminal: Active ({alive} session{'s' if alive != 1 else ''})"
        except Exception:
            return "⚡ Tunminal: Running"

    def _get_tunnel_text(self) -> str:
        if self.remote_url:
            return "🔗 Cloudflare Tunnel: Online"
        return "🔗 Cloudflare Tunnel: Offline"

    def _on_open_browser(self, icon=None, item=None):
        url = self.get_active_url()
        logger.info("Opening web terminal in default browser: %s", url)
        webbrowser.open(url)

    def _on_copy_url(self, icon=None, item=None):
        url = self.get_active_url()
        copied = copy_to_clipboard(url)
        if copied and self.icon and hasattr(self.icon, "notify"):
            try:
                self.icon.notify("Copied Tunminal URL with access token to clipboard!", "Tunminal")
            except Exception:
                pass
        print(f"\n[*] Copied to clipboard: {url}")

    def _on_show_qr(self, icon=None, item=None):
        url = self.get_active_url()
        label = "Remote Access (Cloudflare Tunnel):" if self.remote_url else "Local Network Access:"
        self.auth_manager.print_qr_code(url, label=label)

    def _on_exit(self, icon=None, item=None):
        print("\n[*] Exiting Tunminal from taskbar menu...")
        self.stop()

    def build_menu(self):
        try:
            import pystray
            from pystray import MenuItem as item, Menu
        except Exception as e:
            logger.warning("Failed to import pystray for build_menu: %s", e)
            return None

        return Menu(
            item(lambda text: self._get_status_text(), None, enabled=False),
            item(lambda text: f"🌐 Port: {self.port}", None, enabled=False),
            item(lambda text: self._get_tunnel_text(), None, enabled=False),
            Menu.SEPARATOR,
            item("💻 Open Web Terminal", self._on_open_browser, default=True),
            item("📋 Copy Web URL", self._on_copy_url),
            item("📱 Show QR Code in Terminal", self._on_show_qr),
            Menu.SEPARATOR,
            item("✕ Exit Tunminal", self._on_exit),
        )

    def run(self, server):
        """Run the tray icon on the main thread and Uvicorn server in a worker thread."""
        import pystray

        self.server = server
        self._is_running = True

        # Start Uvicorn server in a background thread
        self._server_thread = threading.Thread(
            target=self.server.run,
            name="TunminalUvicornThread",
            daemon=True,
        )
        self._server_thread.start()

        # Build pystray Icon
        icon_image = create_tray_icon_image()
        self.icon = pystray.Icon(
            name="tunminal",
            icon=icon_image,
            title=f"Tunminal (Port {self.port})",
            menu=self.build_menu(),
        )

        # Intercept SIGINT / SIGTERM on main thread
        def signal_handler(sig, frame):
            print("\n[*] Received interrupt signal, exiting...")
            self.stop()

        try:
            signal.signal(signal.SIGINT, signal_handler)
            signal.signal(signal.SIGTERM, signal_handler)
        except Exception:
            pass

        print("\033[1;32m[✓] Taskbar tray icon active.\033[0m Right-click the icon to check status or exit.\n")

        # icon.run() blocks main thread until icon.stop() is invoked
        try:
            self.icon.run()
        except KeyboardInterrupt:
            self.stop()

    def stop(self):
        """Gracefully stop the server, clean up resources, and close tray icon."""
        if not self._is_running:
            return
        self._is_running = False

        # 1. Stop tray icon
        if self.icon:
            try:
                self.icon.stop()
            except Exception:
                pass

        # 2. Stop Uvicorn server
        if self.server:
            self.server.should_exit = True

        # 3. Trigger cleanup callback (closes sessions, stops tunnel)
        if self.on_exit:
            try:
                self.on_exit()
            except Exception as e:
                logger.debug("Error during exit cleanup: %s", e)

        # 4. Wait for server thread to join
        if self._server_thread and self._server_thread.is_alive():
            self._server_thread.join(timeout=2.0)
