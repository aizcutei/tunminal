import asyncio
import collections
import errno
import fcntl
import os
import queue
import select
import signal
import struct
import subprocess
import termios
import threading
from typing import List, Optional, Union

from tunminal.pty.base import BasePty


class UnixPty(BasePty):
    """POSIX PTY implementation for macOS and Linux."""

    def __init__(
        self,
        command: Union[str, List[str]],
        cwd: Optional[str] = None,
        env: Optional[dict] = None,
        cols: int = 80,
        rows: int = 24,
    ):
        self._cols = cols
        self._rows = rows
        self._closed = False

        # Open pseudo-terminal pair
        self._master_fd, self._slave_fd = os.openpty()

        # Set initial terminal size
        self.resize(cols, rows)

        # Build command
        if isinstance(command, str):
            cmd_args = ["/bin/sh", "-c", command]
        else:
            cmd_args = list(command)

        # Inherit or update environment
        proc_env = os.environ.copy()
        if env:
            proc_env.update(env)
        proc_env.setdefault("TERM", "xterm-256color")
        proc_env.setdefault("COLORTERM", "truecolor")

        try:
            self._proc = subprocess.Popen(
                cmd_args,
                stdin=self._slave_fd,
                stdout=self._slave_fd,
                stderr=self._slave_fd,
                cwd=cwd,
                env=proc_env,
                preexec_fn=os.setsid,
                close_fds=True,
            )
        finally:
            # Slave must be closed in parent so master receives EOF on child termination
            os.close(self._slave_fd)
            self._slave_fd = -1

        self._chunks = collections.deque()
        self._eof = False

        # Start background reader thread to pull data from master_fd
        self._reader_thread = threading.Thread(
            target=self._reader_worker, daemon=True, name=f"pty-reader-{self._proc.pid}"
        )
        self._reader_thread.start()

    @property
    def pid(self) -> Optional[int]:
        return self._proc.pid if self._proc else None

    def is_alive(self) -> bool:
        if self._proc is None:
            return False
        return self._proc.poll() is None

    def write(self, data: bytes) -> None:
        if self._closed or self._master_fd < 0:
            return
        try:
            os.write(self._master_fd, data)
        except OSError:
            pass

    def resize(self, cols: int, rows: int) -> None:
        self._cols = max(1, cols)
        self._rows = max(1, rows)
        fd = self._master_fd if self._master_fd >= 0 else self._slave_fd
        if fd >= 0:
            try:
                winsize = struct.pack("HHHH", self._rows, self._cols, 0, 0)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)
            except OSError:
                pass

    async def read(self) -> bytes:
        """Fetch next chunk of output. Returns b"" when process exits / stream closes."""
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
            while not self._closed and self._master_fd >= 0:
                # Use select with timeout so worker never blocks indefinitely
                try:
                    r, _, _ = select.select([self._master_fd], [], [], 0.1)
                except (ValueError, OSError):
                    break

                if not r or self._closed or self._master_fd < 0:
                    continue

                try:
                    data = os.read(self._master_fd, 4096)
                    if not data:
                        break
                    self._chunks.append(data)
                except OSError as e:
                    # Linux raises EIO when slave is closed
                    if e.errno == errno.EIO:
                        break
                    if e.errno in (errno.EBADF, errno.EINTR, errno.EAGAIN):
                        continue
                    break
        finally:
            self._eof = True

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._eof = True

        # Terminate child process group
        if self._proc and self._proc.poll() is None:
            try:
                pgid = os.getpgid(self._proc.pid)
                os.killpg(pgid, signal.SIGHUP)
                os.killpg(pgid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                try:
                    self._proc.terminate()
                except OSError:
                    pass

            # Wait briefly for process exit; if stubborn, force kill
            try:
                self._proc.wait(timeout=0.3)
            except (subprocess.TimeoutExpired, Exception):
                try:
                    pgid = os.getpgid(self._proc.pid)
                    os.killpg(pgid, signal.SIGKILL)
                except (OSError, ProcessLookupError):
                    try:
                        self._proc.kill()
                    except OSError:
                        pass

        # Wait for reader thread to exit select loop before closing master_fd
        if hasattr(self, "_reader_thread") and self._reader_thread.is_alive():
            self._reader_thread.join(timeout=0.3)

        if self._master_fd >= 0:
            try:
                os.close(self._master_fd)
            except OSError:
                pass
            self._master_fd = -1
