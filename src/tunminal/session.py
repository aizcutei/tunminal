import asyncio
import collections
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Set
from fastapi import WebSocket

from tunminal.pty import BasePty, spawn_pty

logger = logging.getLogger("tunminal.session")

MAX_SCROLLBACK_BYTES = 512 * 1024  # 512 KB scrollback buffer per session


class TerminalSession:
    """Manages a single interactive terminal process with persistent buffer and multi-client support."""

    def __init__(
        self,
        session_id: str,
        name: str,
        command: Optional[str] = None,
        cwd: Optional[str] = None,
        cols: int = 80,
        rows: int = 24,
    ):
        self.session_id = session_id
        self.name = name
        self.command = command
        self.cwd = cwd
        self.cols = cols
        self.rows = rows
        self.created_at = time.time()
        self.last_active_at = time.time()

        self._pty: Optional[BasePty] = None
        self._clients: Set[WebSocket] = set()
        self._buffer: bytearray = bytearray()
        self._reader_task: Optional[asyncio.Task] = None
        self._closed = False

    def start(self) -> None:
        """Spawn the PTY process and start background output listener."""
        if self._pty is None:
            self._pty = spawn_pty(
                command=self.command,
                cwd=self.cwd,
                cols=self.cols,
                rows=self.rows,
            )
        self.ensure_listener_started()
        logger.info("Session %s started (PID: %s, cmd: %s)", self.session_id, self.pid, self.command)

    def ensure_listener_started(self) -> None:
        """Ensure reader background task is running once an event loop is active."""
        if self._reader_task is None or self._reader_task.done():
            try:
                loop = asyncio.get_running_loop()
                self._reader_task = loop.create_task(
                    self._listen_pty_output(), name=f"session-reader-{self.session_id}"
                )
            except RuntimeError:
                pass

    @property
    def pid(self) -> Optional[int]:
        return self._pty.pid if self._pty else None

    def is_alive(self) -> bool:
        if self._closed or not self._pty:
            return False
        return self._pty.is_alive()

    async def _listen_pty_output(self) -> None:
        """Continuously read from PTY, append to scrollback buffer, and broadcast to clients."""
        try:
            while not self._closed and self._pty:
                chunk = await self._pty.read()
                if not chunk:
                    # EOF / child process exited
                    break

                # Maintain scrollback ring buffer
                self._buffer.extend(chunk)
                if len(self._buffer) > MAX_SCROLLBACK_BYTES:
                    excess = len(self._buffer) - MAX_SCROLLBACK_BYTES
                    del self._buffer[:excess]

                self.last_active_at = time.time()

                # Broadcast to all connected WebSocket clients
                if self._clients:
                    dead_clients = set()
                    for ws in list(self._clients):
                        try:
                            await ws.send_bytes(chunk)
                        except Exception:
                            dead_clients.add(ws)
                    self._clients.difference_update(dead_clients)
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("Error reading PTY output for session %s: %s", self.session_id, e)
        finally:
            logger.info("Session %s process finished or stream closed", self.session_id)
            # Notify clients of exit
            exit_msg = b"\r\n\x1b[33m[Tunminal: Process terminated]\x1b[0m\r\n"
            for ws in list(self._clients):
                try:
                    await ws.send_bytes(exit_msg)
                except Exception:
                    pass

    async def attach_client(self, websocket: WebSocket) -> None:
        """Attach a WebSocket client to this session and replay recent scrollback buffer."""
        self.ensure_listener_started()
        self._clients.add(websocket)
        self.last_active_at = time.time()

        # Replay scrollback buffer so client screen restores immediately
        if self._buffer:
            try:
                await websocket.send_bytes(bytes(self._buffer))
            except Exception as e:
                logger.warning("Failed to replay buffer to client: %s", e)

        if not self.is_alive():
            try:
                await websocket.send_bytes(b"\r\n\x1b[33m[Tunminal: Process is terminated]\x1b[0m\r\n")
            except Exception:
                pass

    def detach_client(self, websocket: WebSocket) -> None:
        """Detach a WebSocket client without killing the background PTY."""
        self._clients.discard(websocket)

    def write(self, data: bytes) -> None:
        """Write user input to PTY stdin."""
        if self._pty and self.is_alive():
            self.last_active_at = time.time()
            self._pty.write(data)

    def resize(self, cols: int, rows: int) -> None:
        """Update terminal dimensions."""
        self.cols = max(1, cols)
        self.rows = max(1, rows)
        if self._pty:
            self._pty.resize(self.cols, self.rows)

    def close(self) -> None:
        """Explicitly terminate PTY and close session."""
        if self._closed:
            return
        self._closed = True

        if self._reader_task and not self._reader_task.done():
            self._reader_task.cancel()

        if self._pty:
            self._pty.close()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.session_id,
            "name": self.name,
            "command": self.command,
            "pid": self.pid,
            "alive": self.is_alive(),
            "cols": self.cols,
            "rows": self.rows,
            "clients": len(self._clients),
            "created_at": self.created_at,
            "last_active_at": self.last_active_at,
        }


class SessionManager:
    """Manages active terminal sessions."""

    def __init__(self, default_cwd: Optional[str] = None):
        self._sessions: Dict[str, TerminalSession] = {}
        self._default_cwd = default_cwd

    def create_session(
        self,
        name: Optional[str] = None,
        command: Optional[str] = None,
        cwd: Optional[str] = None,
        cols: int = 80,
        rows: int = 24,
    ) -> TerminalSession:
        session_id = str(uuid.uuid4())[:8]
        if not name:
            if command:
                name = command.strip().split()[0]
            else:
                name = f"Shell-{session_id}"

        session = TerminalSession(
            session_id=session_id,
            name=name,
            command=command,
            cwd=cwd or self._default_cwd,
            cols=cols,
            rows=rows,
        )
        session.start()
        self._sessions[session_id] = session
        return session

    def get_session(self, session_id: str) -> Optional[TerminalSession]:
        return self._sessions.get(session_id)

    def list_sessions(self) -> List[Dict[str, Any]]:
        # Return sorted by creation time
        return [s.to_dict() for s in sorted(self._sessions.values(), key=lambda x: x.created_at)]

    def close_session(self, session_id: str) -> bool:
        session = self._sessions.pop(session_id, None)
        if session:
            session.close()
            return True
        return False

    def close_all(self) -> None:
        for session in list(self._sessions.values()):
            session.close()
        self._sessions.clear()
