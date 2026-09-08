import json
import logging
import os
import sys
from pathlib import Path
from typing import List, Optional, Union

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from tunminal.pty import detect_cli_tools, get_default_shell
from tunminal.security import AuthManager
from tunminal.session import SessionManager

logger = logging.getLogger("tunminal.server")

def _resolve_static_dir() -> Path:
    # Check if running in a PyInstaller bundle
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        meipass_pkg = Path(sys._MEIPASS) / "tunminal" / "static"
        if meipass_pkg.exists():
            return meipass_pkg
        meipass_root = Path(sys._MEIPASS) / "static"
        if meipass_root.exists():
            return meipass_root

    # Standard source checkout / package installation
    src_static = Path(__file__).parent / "static"
    return src_static


STATIC_DIR = _resolve_static_dir()


class CreateSessionRequest(BaseModel):
    command: Optional[Union[str, List[str]]] = None
    name: Optional[str] = None
    cwd: Optional[str] = None
    cols: int = 80
    rows: int = 24


class UpdateSessionRequest(BaseModel):
    name: Optional[str] = None


from contextlib import asynccontextmanager


def create_app(
    auth_manager: AuthManager,
    session_manager: SessionManager,
    default_cmd: Optional[str] = None,
) -> FastAPI:
    """Create and configure the FastAPI application."""

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Startup: ensure listener tasks for all sessions are active
        for session in session_manager._sessions.values():
            session.ensure_listener_started()
        yield
        # Shutdown: close all sessions
        session_manager.close_all()

    app = FastAPI(title="Tunminal", docs_url=None, redoc_url=None, lifespan=lifespan)

    # Helper dependency for route authentication
    def authenticate(request: Request) -> None:
        auth_manager.verify_request(request)

    @app.get("/")
    async def index(request: Request, response: Response):
        token = request.query_params.get("token")
        index_file = STATIC_DIR / "index.html"
        if not index_file.exists():
            return JSONResponse(
                {"error": "Static web assets not found", "status": "running"},
                status_code=200,
            )

        resp = FileResponse(index_file)
        if token and auth_manager.is_valid_token(token):
            # Save token in cookie for subsequent requests
            resp.set_cookie(
                key="tunminal_token",
                value=token,
                httponly=True,
                samesite="lax",
                max_age=30 * 24 * 3600,
            )
        return resp

    @app.get("/api/info")
    async def get_info(request: Request):
        auth_manager.verify_request(request)
        return {
            "platform": sys.platform,
            "default_shell": get_default_shell(),
            "presets": detect_cli_tools(),
            "default_cmd": default_cmd,
            "cwd": session_manager._default_cwd or os.getcwd(),
        }

    @app.get("/api/sessions")
    async def list_sessions(request: Request):
        auth_manager.verify_request(request)
        return session_manager.list_sessions()

    @app.post("/api/sessions")
    async def create_session(req: CreateSessionRequest, request: Request):
        auth_manager.verify_request(request)

        # Resolve command preset shortcuts
        cmd = req.command
        if cmd == "shell" or not cmd:
            cmd = None  # will use default shell

        session = session_manager.create_session(
            name=req.name,
            command=cmd,
            cwd=req.cwd,
            cols=req.cols,
            rows=req.rows,
        )
        return session.to_dict()

    @app.patch("/api/sessions/{session_id}")
    async def update_session(session_id: str, req: UpdateSessionRequest, request: Request):
        auth_manager.verify_request(request)
        session = session_manager.get_session(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        if req.name is not None and req.name.strip():
            session.name = req.name.strip()
        return session.to_dict()

    @app.delete("/api/sessions/{session_id}")
    async def delete_session(session_id: str, request: Request):
        auth_manager.verify_request(request)
        closed = session_manager.close_session(session_id)
        if not closed:
            raise HTTPException(status_code=404, detail="Session not found")
        return {"status": "closed", "session_id": session_id}

    @app.websocket("/ws/{session_id}")
    async def websocket_endpoint(websocket: WebSocket, session_id: str):
        # 1. Authenticate WebSocket
        if not auth_manager.verify_websocket(websocket):
            logger.warning("Unauthorized WebSocket connection attempt to session %s", session_id)
            await websocket.close(code=4401, reason="Unauthorized: invalid token")
            return

        session = session_manager.get_session(session_id)
        if not session:
            # If default initial session doesn't exist yet, auto-create it
            if session_id == "default":
                session = session_manager.create_session(
                    name=default_cmd or "Default",
                    command=default_cmd,
                )
            else:
                await websocket.close(code=4404, reason="Session not found")
                return

        await websocket.accept()
        await session.attach_client(websocket)

        try:
            while True:
                # Receive input from client
                message = await websocket.receive()
                if "bytes" in message and message["bytes"]:
                    session.write(message["bytes"])
                elif "text" in message and message["text"]:
                    text = message["text"]
                    # Check if message is a JSON control message
                    if text.startswith("{") and text.endswith("}"):
                        try:
                            ctrl = json.loads(text)
                            if ctrl.get("type") == "resize":
                                cols = int(ctrl.get("cols", 80))
                                rows = int(ctrl.get("rows", 24))
                                session.resize(cols, rows)
                                continue
                            elif ctrl.get("type") == "ping":
                                await websocket.send_text(json.dumps({"type": "pong"}))
                                continue
                        except (json.JSONDecodeError, ValueError):
                            pass

                    # Normal text input from client
                    session.write(text.encode("utf-8"))
        except (WebSocketDisconnect, RuntimeError):
            # Normal client disconnect (e.g. browser closed or navigated away)
            pass
        except Exception as e:
            logger.warning("WebSocket error in session %s: %s", session_id, e)
        finally:
            session.detach_client(websocket)

    # Mount static files directory
    if STATIC_DIR.exists():
        app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    return app
