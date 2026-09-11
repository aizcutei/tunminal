import asyncio
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
from typing import Optional

logger = logging.getLogger("tunminal.tunnel")

CLOUDFLARE_REGEX = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")


def get_cloudflared_path() -> Optional[str]:
    """Find cloudflared executable in PATH or standard install locations."""
    path = shutil.which("cloudflared")
    if path:
        return path

    # Common manual installation paths
    if sys.platform == "win32":
        candidates = [
            os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared*"),
            r"C:\Program Files\cloudflared\cloudflared.exe",
            r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
        ]
        import glob
        for c in candidates:
            matches = glob.glob(c)
            if matches:
                exe = os.path.join(matches[0], "cloudflared.exe") if os.path.isdir(matches[0]) else matches[0]
                if os.path.exists(exe):
                    return exe
    elif sys.platform == "darwin":
        candidates = [
            "/opt/homebrew/bin/cloudflared",
            "/usr/local/bin/cloudflared",
        ]
        for c in candidates:
            if os.path.exists(c):
                return c
    else:
        candidates = [
            "/usr/local/bin/cloudflared",
            "/usr/bin/cloudflared",
        ]
        for c in candidates:
            if os.path.exists(c):
                return c

    return None


def get_install_instructions() -> str:
    """Return OS-tailored instructions for installing cloudflared."""
    if sys.platform == "darwin":
        return "macOS detected: Run `brew install cloudflared`"
    elif sys.platform == "win32":
        return "Windows detected: Run `winget install --id Cloudflare.cloudflared` (or download from https://github.com/cloudflare/cloudflared/releases)"
    else:
        return (
            "Linux detected:\n"
            "  Debian/Ubuntu: sudo apt-get install cloudflared\n"
            "  Binary download: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared"
        )


class CloudflareTunnel:
    """Manages cloudflared quick tunnel child process."""

    def __init__(self, local_port: int, host: str = "127.0.0.1"):
        self.local_port = local_port
        self.host = host
        self.cloudflared_bin = get_cloudflared_path()
        self.tunnel_url: Optional[str] = None
        self._proc: Optional[subprocess.Popen] = None
        self._url_event = threading.Event()
        self._monitor_thread: Optional[threading.Thread] = None
        self._stopped = False

    def is_available(self) -> bool:
        return self.cloudflared_bin is not None

    def start(self, timeout: float = 25.0) -> Optional[str]:
        """Start cloudflared quick tunnel and wait for the trycloudflare.com URL."""
        if not self.cloudflared_bin:
            logger.warning("cloudflared executable not found.")
            return None

        cmd = [
            self.cloudflared_bin,
            "tunnel",
            "--url",
            f"http://{self.host}:{self.local_port}",
            "--no-autoupdate",
        ]

        logger.info("Starting Cloudflare Tunnel: %s", " ".join(cmd))
        try:
            # cloudflared prints tunnel info to stderr (UTF-8 encoded)
            self._proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except Exception as e:
            logger.error("Failed to launch cloudflared: %s", e)
            return None

        self._monitor_thread = threading.Thread(
            target=self._monitor_output, daemon=True, name="cloudflared-monitor"
        )
        self._monitor_thread.start()

        # Wait for URL to appear
        ready = self._url_event.wait(timeout=timeout)
        if ready and self.tunnel_url:
            logger.info("Cloudflare tunnel ready: %s", self.tunnel_url)
            return self.tunnel_url
        else:
            logger.warning("Timed out waiting for Cloudflare Tunnel URL to generate.")
            return None

    def _monitor_output(self) -> None:
        if not self._proc or not self._proc.stderr:
            return

        try:
            for line in iter(self._proc.stderr.readline, ""):
                if self._stopped:
                    break
                match = CLOUDFLARE_REGEX.search(line)
                if match and not self.tunnel_url:
                    self.tunnel_url = match.group(0)
                    self._url_event.set()
        except Exception as e:
            logger.warning("Error reading cloudflared output: %s", e)
        finally:
            self._url_event.set()

    def stop(self) -> None:
        self._stopped = True
        if self._proc and self._proc.poll() is None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=3)
            except Exception:
                try:
                    self._proc.kill()
                except Exception:
                    pass
        self._proc = None
