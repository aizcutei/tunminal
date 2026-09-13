import asyncio
import collections
import logging
import os
import threading
from typing import List, Optional, Union

from tunminal.pty.base import BasePty

logger = logging.getLogger("tunminal.pty.windows")

try:
    from winpty import PtyProcess
    HAS_WINPTY = True
except ImportError:
    HAS_WINPTY = False
    PtyProcess = None


class WindowsPty(BasePty):
    """Windows ConPTY implementation using pywinpty."""

    def __init__(
        self,
        command: Union[str, List[str]],
        cwd: Optional[str] = None,
        env: Optional[dict] = None,
        cols: int = 80,
        rows: int = 24,
    ):
        if not HAS_WINPTY:
            raise RuntimeError(
                "pywinpty is not installed. Windows support requires pywinpty. "
                "Run `uv add pywinpty` or `pip install pywinpty`."
            )

        self._cols = cols
        self._rows = rows
        self._closed = False
        self._eof = False

        if isinstance(command, list):
            cmd_args = list(command)
        elif isinstance(command, str):
            cmd_args = [command]
        else:
            cmd_args = ["powershell.exe"]

        proc_env = os.environ.copy()
        if env:
            proc_env.update(env)
        proc_env.setdefault("TERM", "xterm-256color")

        self._proc = PtyProcess.spawn(
            cmd_args,
            cwd=cwd,
            env=proc_env,
            dimensions=(self._rows, self._cols),
        )

        self._chunks = collections.deque()

        self._reader_thread = threading.Thread(
            target=self._reader_worker, daemon=True, name=f"winpty-reader-{self.pid}"
        )
        self._reader_thread.start()

    @property
    def pid(self) -> Optional[int]:
        return getattr(self._proc, "pid", None)

    def is_alive(self) -> bool:
        if self._proc is None:
            return False
        return self._proc.isalive()

    def write(self, data: bytes) -> None:
        if self._closed or not self._proc:
            return
        try:
            text = data.decode("utf-8", errors="replace")
            # Ensure line endings include carriage return for Windows console input
            if "\n" in text and "\r" not in text:
                text = text.replace("\n", "\r\n")
            self._proc.write(text)
        except Exception:
            pass

    def resize(self, cols: int, rows: int) -> None:
        cols = max(1, cols)
        rows = max(1, rows)
        if self._cols == cols and self._rows == rows:
            return
        self._cols = cols
        self._rows = rows
        if self._proc and self.is_alive():
            try:
                if hasattr(self._proc, "setwinsize"):
                    self._proc.setwinsize(self._rows, self._cols)
                elif hasattr(self._proc, "set_winsize"):
                    self._proc.set_winsize(self._rows, self._cols)
                elif hasattr(self._proc, "pty") and hasattr(self._proc.pty, "set_size"):
                    self._proc.pty.set_size(self._cols, self._rows)
            except Exception as e:
                logger.warning("Failed to resize Windows PTY: %s", e)

    async def read(self) -> bytes:
        while not self._closed:
            if self._chunks:
                return self._chunks.popleft()
            if self._eof:
                if self._chunks:
                    return self._chunks.popleft()
                return b""
            await asyncio.sleep(0.01)
        if self._chunks:
            return self._chunks.popleft()
        return b""

    def _reader_worker(self) -> None:
        try:
            while not self._closed and self._proc:
                try:
                    data = self._proc.read(4096)
                    if not data:
                        break
                    chunk = data.encode("utf-8", errors="replace") if isinstance(data, str) else data
                    self._chunks.append(chunk)
                except (EOFError, OSError, Exception):
                    break
        finally:
            self._eof = True

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._eof = True
        if self._proc:
            try:
                self._proc.terminate()
            except Exception:
                pass
        if hasattr(self, "_reader_thread") and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=0.3)


def subprocess_list_to_cmd(args: List[str]) -> str:
    """Format an argument list for Windows command execution."""
    import subprocess
    return subprocess.list2cmdline(args)
