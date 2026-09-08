import asyncio
import sys
import pytest
from starlette.testclient import TestClient

from tunminal.pty import spawn_pty, get_default_shell, detect_cli_tools
from tunminal.security import AuthManager
from tunminal.session import SessionManager
from tunminal.server import create_app


def test_auth_manager(tmp_path, monkeypatch):
    # Test explicit token
    auth = AuthManager("secret123")
    assert auth.is_valid_token("secret123")
    assert not auth.is_valid_token("wrongtoken")
    assert not auth.is_valid_token(None)

    url = auth.make_magic_url("https://example.com/app")
    assert "token=secret123" in url

    # Test persistent token loading across instances
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr("pathlib.Path.home", lambda: fake_home)
    monkeypatch.delenv("TUNMINAL_TOKEN", raising=False)

    auth1 = AuthManager()
    token1 = auth1.token
    assert token1 is not None and len(token1) > 10

    # Second instance should reuse the same saved token
    auth2 = AuthManager()
    assert auth2.token == token1


def test_cli_tools_detection():
    tools = detect_cli_tools()
    assert "shell" in tools
    assert tools["shell"] is True
    assert "claude" in tools
    assert "codex" in tools


def test_tray_module(monkeypatch):
    from tunminal.tray import (
        is_tray_available,
        create_tray_icon_image,
        copy_to_clipboard,
        TunminalTrayApp,
    )

    # 1. Icon generation
    img = create_tray_icon_image()
    assert img.size == (64, 64)
    assert img.mode == "RGBA"

    # 2. Tray app initialization & menu
    auth = AuthManager("testsecret")
    mgr = SessionManager()
    tray_app = TunminalTrayApp(
        session_manager=mgr,
        auth_manager=auth,
        local_url="http://127.0.0.1:8080",
        remote_url="https://remote.example.com",
        port=8080,
    )
    assert tray_app.get_active_url() == "https://remote.example.com"
    menu = tray_app.build_menu()
    assert len(menu.items) >= 5

    # 3. Headless simulation
    monkeypatch.setattr("sys.platform", "linux")
    monkeypatch.delenv("DISPLAY", raising=False)
    monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)
    assert not is_tray_available()


@pytest.mark.asyncio
async def test_pty_echo():
    # Only test UnixPty on POSIX systems
    if sys.platform == "win32":
        pytest.skip("Skipping UnixPty test on Windows")

    pty = spawn_pty(command=["echo", "tunminal_test"])
    assert pty.pid is not None

    output = b""
    while True:
        chunk = await asyncio.wait_for(pty.read(), timeout=3.0)
        if not chunk:
            break
        output += chunk

    pty.close()
    assert b"tunminal_test" in output


@pytest.mark.asyncio
async def test_session_manager_lifecycle():
    mgr = SessionManager()
    session = mgr.create_session(name="TestSession", command=["echo", "session_output"])
    assert session.session_id in [s["id"] for s in mgr.list_sessions()]

    # Wait for echo to complete and buffer to populate
    await asyncio.sleep(0.5)

    assert b"session_output" in session._buffer

    mgr.close_session(session.session_id)
    assert len(mgr.list_sessions()) == 0


def test_server_routes():
    auth = AuthManager("testtoken")
    mgr = SessionManager()
    app = create_app(auth_manager=auth, session_manager=mgr)
    client = TestClient(app)

    # 1. Unauthenticated API request
    res = client.get("/api/info")
    assert res.status_code == 401

    # 2. Authenticated with header
    res = client.get("/api/info", headers={"Authorization": "Bearer testtoken"})
    assert res.status_code == 200
    data = res.json()
    assert "presets" in data
    assert "platform" in data

    # 3. Create session via POST
    res = client.post(
        "/api/sessions",
        headers={"Authorization": "Bearer testtoken"},
        json={"name": "ApiTestSession", "command": "cat"},
    )
    assert res.status_code == 200
    session_id = res.json()["id"]

    # 4. List sessions
    res = client.get("/api/sessions", headers={"Authorization": "Bearer testtoken"})
    assert res.status_code == 200
    assert any(s["id"] == session_id for s in res.json())

    # 5. Rename session via PATCH
    res = client.patch(
        f"/api/sessions/{session_id}",
        headers={"Authorization": "Bearer testtoken"},
        json={"name": "RenamedSession"},
    )
    assert res.status_code == 200
    assert res.json()["name"] == "RenamedSession"

    # 6. Session reconnect / pick-up test:
    # First connection (browser 1)
    with client.websocket_connect(f"/ws/{session_id}?token=testtoken") as ws1:
        ws1.send_text("persisted_terminal_data\n")
        reply = ws1.receive_bytes()
        assert b"persisted_terminal_data" in reply

    # Browser 1 is now closed (ws1 exited context). The session is still alive in mgr!
    session = mgr.get_session(session_id)
    assert session is not None
    assert session.is_alive()
    assert b"persisted_terminal_data" in session._buffer

    # Second connection (browser 2 reopening) - picks up old still running terminal!
    with client.websocket_connect(f"/ws/{session_id}?token=testtoken") as ws2:
        replayed = ws2.receive_bytes()
        assert b"persisted_terminal_data" in replayed

    # 7. Delete session
    res = client.delete(f"/api/sessions/{session_id}", headers={"Authorization": "Bearer testtoken"})
    assert res.status_code == 200

    # 6. WebSocket with invalid token
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/default?token=badtoken"):
            pass

    # 7. WebSocket with valid token
    with client.websocket_connect(f"/ws/default?token=testtoken") as ws:
        # Send ping
        ws.send_text('{"type": "ping"}')
        data = ws.receive_text()
        assert "pong" in data

    mgr.close_all()
