import asyncio
from dataclasses import dataclass
from enum import Enum
import glob
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
from typing import Optional, Tuple

logger = logging.getLogger("tunminal.tunnel")

CLOUDFLARE_REGEX = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")


class ServiceStatus(str, Enum):
    RUNNING = "running"
    STOPPED = "stopped"
    NOT_INSTALLED = "not_installed"


@dataclass
class ExistingTunnelInfo:
    service_status: ServiceStatus = ServiceStatus.NOT_INSTALLED
    service_name: Optional[str] = None
    config_file: Optional[str] = None
    detected_hostname: Optional[str] = None
    source: str = "none"


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


def check_windows_service() -> Tuple[ServiceStatus, Optional[str]]:
    """Check if Cloudflared Windows Service is installed and whether it is running."""
    if sys.platform != "win32":
        return ServiceStatus.NOT_INSTALLED, None

    try:
        res = subprocess.run(
            ["sc.exe", "query", "Cloudflared"],
            capture_output=True,
            text=True,
            timeout=3,
            errors="replace",
        )
        out = res.stdout.upper()
        if "STATE" in out:
            if "RUNNING" in out:
                return ServiceStatus.RUNNING, "Cloudflared"
            elif "STOPPED" in out or "START_PENDING" in out or "PAUSED" in out:
                return ServiceStatus.STOPPED, "Cloudflared"
            return ServiceStatus.STOPPED, "Cloudflared"
    except Exception as e:
        logger.debug("Failed to query Windows service Cloudflared: %s", e)

    return ServiceStatus.NOT_INSTALLED, None


def check_systemd_service() -> Tuple[ServiceStatus, Optional[str]]:
    """Check if cloudflared systemd service is active or installed on Linux."""
    if not sys.platform.startswith("linux"):
        return ServiceStatus.NOT_INSTALLED, None

    try:
        res = subprocess.run(
            ["systemctl", "is-active", "cloudflared"],
            capture_output=True,
            text=True,
            timeout=3,
            errors="replace",
        )
        status = res.stdout.strip().lower()
        if status == "active":
            return ServiceStatus.RUNNING, "cloudflared"

        unit_res = subprocess.run(
            ["systemctl", "status", "cloudflared"],
            capture_output=True,
            text=True,
            timeout=3,
            errors="replace",
        )
        if "Loaded: loaded" in unit_res.stdout:
            return ServiceStatus.STOPPED, "cloudflared"
    except Exception as e:
        logger.debug("Failed to check systemd cloudflared: %s", e)

    return ServiceStatus.NOT_INSTALLED, None


def check_macos_service() -> Tuple[ServiceStatus, Optional[str]]:
    """Check if cloudflared service is managed via launchctl on macOS."""
    if sys.platform != "darwin":
        return ServiceStatus.NOT_INSTALLED, None

    try:
        res = subprocess.run(
            ["launchctl", "list"],
            capture_output=True,
            text=True,
            timeout=3,
            errors="replace",
        )
        for line in res.stdout.splitlines():
            if "cloudflared" in line.lower():
                parts = line.split()
                pid = parts[0] if parts else "-"
                label = parts[2] if len(parts) > 2 else "cloudflared"
                if pid != "-" and pid.isdigit():
                    return ServiceStatus.RUNNING, label
                else:
                    return ServiceStatus.STOPPED, label
    except Exception as e:
        logger.debug("Failed to check launchctl cloudflared: %s", e)

    return ServiceStatus.NOT_INSTALLED, None


def find_hostname_in_config(config_path: str, port: int) -> Optional[str]:
    """Parse a cloudflared YAML configuration file to look for ingress rules routing to port."""
    if not os.path.exists(config_path) or not os.path.isfile(config_path):
        return None

    try:
        with open(config_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()

        current_hostname = None
        for line in lines:
            line_str = line.strip()
            # Match hostname key: e.g. hostname: term.example.com or - hostname: term.example.com
            host_match = re.search(r"hostname:\s*([^\s#]+)", line_str, re.IGNORECASE)
            if host_match:
                current_hostname = host_match.group(1).strip("'\"")

            # Match service key: e.g. service: http://localhost:8080 or service: http://127.0.0.1:8080
            svc_match = re.search(r"service:\s*([^\s#]+)", line_str, re.IGNORECASE)
            if svc_match:
                svc_val = svc_match.group(1).strip("'\"")
                if (
                    f":{port}" in svc_val
                    or svc_val == f"http://localhost:{port}"
                    or svc_val == f"http://127.0.0.1:{port}"
                ):
                    if current_hostname:
                        return current_hostname
    except Exception as e:
        logger.debug("Error parsing %s for hostname: %s", config_path, e)

    return None


def detect_existing_tunnel(port: int = 8080) -> ExistingTunnelInfo:
    """Auto-detect if a Named Tunnel / system service is already installed or running."""
    info = ExistingTunnelInfo()

    # 1. Check OS service status
    if sys.platform == "win32":
        status, name = check_windows_service()
        if status != ServiceStatus.NOT_INSTALLED:
            info.service_status = status
            info.service_name = name
            info.source = "windows_service"
    elif sys.platform.startswith("linux"):
        status, name = check_systemd_service()
        if status != ServiceStatus.NOT_INSTALLED:
            info.service_status = status
            info.service_name = name
            info.source = "systemd"
    elif sys.platform == "darwin":
        status, name = check_macos_service()
        if status != ServiceStatus.NOT_INSTALLED:
            info.service_status = status
            info.service_name = name
            info.source = "launchd"

    # 2. Check local config files for ingress hostname
    config_candidates = []
    if sys.platform == "win32":
        config_candidates = [
            os.path.expandvars(r"%USERPROFILE%\.cloudflared\config.yml"),
            os.path.expandvars(r"%USERPROFILE%\.cloudflared\config.yaml"),
            r"C:\Program Files\cloudflared\config.yml",
            r"C:\Program Files (x86)\cloudflared\config.yml",
            r"C:\Windows\System32\config\systemprofile\.cloudflared\config.yml",
        ]
    elif sys.platform == "darwin":
        config_candidates = [
            os.path.expanduser("~/.cloudflared/config.yml"),
            os.path.expanduser("~/.cloudflared/config.yaml"),
            "/usr/local/etc/cloudflared/config.yml",
            "/opt/homebrew/etc/cloudflared/config.yml",
        ]
    else:
        config_candidates = [
            os.path.expanduser("~/.cloudflared/config.yml"),
            os.path.expanduser("~/.cloudflared/config.yaml"),
            "/etc/cloudflared/config.yml",
            "/etc/cloudflared/config.yaml",
        ]

    for cfg in config_candidates:
        if os.path.exists(cfg):
            hostname = find_hostname_in_config(cfg, port=port)
            if hostname:
                info.config_file = cfg
                info.detected_hostname = hostname
                break

    return info


class CloudflareTunnel:
    """Manages cloudflared quick tunnel or named tunnel child process."""

    def __init__(
        self,
        local_port: int,
        host: str = "127.0.0.1",
        tunnel_token: Optional[str] = None,
        protocol: str = "http2",
    ):
        self.local_port = local_port
        self.host = host
        self.tunnel_token = tunnel_token or os.environ.get("TUNMINAL_TUNNEL_TOKEN")
        self.protocol = protocol
        self.cloudflared_bin = get_cloudflared_path()
        self.tunnel_url: Optional[str] = None
        self._proc: Optional[subprocess.Popen] = None
        self._url_event = threading.Event()
        self._monitor_thread: Optional[threading.Thread] = None
        self._stopped = False

    def is_available(self) -> bool:
        return self.cloudflared_bin is not None

    def start(self, timeout: float = 25.0) -> Optional[str]:
        """Start cloudflared tunnel and wait for URL (in quick tunnel mode) or initialization."""
        if not self.cloudflared_bin:
            logger.warning("cloudflared executable not found.")
            return None

        # Build command based on whether we run Named Tunnel (Token) or Quick Tunnel
        if self.tunnel_token:
            cmd = [
                self.cloudflared_bin,
                "tunnel",
                "--protocol",
                self.protocol,
                "--no-autoupdate",
                "run",
                "--token",
                self.tunnel_token,
            ]
        else:
            cmd = [
                self.cloudflared_bin,
                "tunnel",
                "--url",
                f"http://{self.host}:{self.local_port}",
                "--protocol",
                self.protocol,
                "--no-autoupdate",
            ]

        logger.info("Starting Cloudflare Tunnel (%s): %s", "Named Token" if self.tunnel_token else "Quick Tunnel", " ".join(cmd))
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

        # In Token mode, the tunnel doesn't print a trycloudflare.com URL
        if self.tunnel_token:
            # Wait briefly to ensure the process started without immediately crashing
            import time
            time.sleep(1.0)
            if self._proc.poll() is None:
                logger.info("Cloudflare Named Tunnel started successfully with token.")
                return "named_tunnel_active"
            else:
                logger.error("Cloudflare Named Tunnel exited immediately with code %s", self._proc.poll())
                return None

        # Wait for URL to appear in Quick Tunnel mode
        ready = self._url_event.wait(timeout=timeout)
        if ready and self.tunnel_url:
            logger.info("Cloudflare quick tunnel ready: %s", self.tunnel_url)
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
                if "ERR" in line or "error" in line.lower():
                    logger.debug("cloudflared log: %s", line.strip())
        except Exception as e:
            logger.warning("Error reading cloudflared output: %s", e)
        finally:
            self._url_event.set()
            if not self._stopped and self._proc and self._proc.poll() is not None:
                code = self._proc.poll()
                logger.warning("cloudflared process terminated with return code %s", code)

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
