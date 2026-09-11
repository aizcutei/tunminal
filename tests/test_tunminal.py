import asyncio
import sys
import time
import anyio
import pytest
from starlette.testclient import TestClient

from tunminal.pty import spawn_pty, get_default_shell, detect_cli_tools
from tunminal.security import AuthManager
from tunminal.session import SessionManager
from tunminal.server import create_app


def receive_with_timeout(ws, timeout=3.0):
    """Safely receive from starlette WebSocketTestSession without blocking thread executors."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if hasattr(ws, "portal") and hasattr(ws, "_send_rx"):
                return ws.portal.call(ws._send_rx.receive_nowait)
            return ws.receive()
        except anyio.WouldBlock:
            time.sleep(0.05)
        except Exception:
            return None
    return None


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
    if is_tray_available():
        menu = tray_app.build_menu()
        if menu is not None:
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

    pty = spawn_pty(command=[sys.executable, "-u", "-c", "print('tunminal_test', flush=True)"])
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
    # Cross-platform command working on Windows, Linux, and macOS
    cmd = [sys.executable, "-u", "-c", "print('session_output', flush=True)"]
    session = mgr.create_session(name="TestSession", command=cmd)
    assert session.session_id in [s["id"] for s in mgr.list_sessions()]

    # Wait for output to complete and buffer to populate
    for _ in range(50):
        if b"session_output" in session._buffer:
            break
        await asyncio.sleep(0.1)

    assert b"session_output" in session._buffer, f"Buffer content: {session._buffer!r}"

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

    # 3. Create session via POST using line-by-line unbuffered python echo
    py_cat = [
        sys.executable,
        "-u",
        "-c",
        "import sys; [(sys.stdout.write(x), sys.stdout.flush()) for x in iter(sys.stdin.readline, '')]",
    ]
    res = client.post(
        "/api/sessions",
        headers={"Authorization": "Bearer testtoken"},
        json={"name": "ApiTestSession", "command": py_cat},
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
        ws1.send_text("persisted_terminal_data\r\n")
        received = b""
        for _ in range(30):
            msg = receive_with_timeout(ws1, timeout=0.5)
            if msg and "bytes" in msg and msg["bytes"]:
                received += msg["bytes"]
                if b"persisted_terminal_data" in received:
                    break
        assert b"persisted_terminal_data" in received, f"Expected echoed data, got: {received!r}"

    # Browser 1 is now closed (ws1 exited context). The session is still alive in mgr!
    session = mgr.get_session(session_id)
    assert session is not None
    assert session.is_alive()
    assert b"persisted_terminal_data" in session._buffer, f"Session buffer: {session._buffer!r}"

    # Second connection (browser 2 reopening) - picks up old still running terminal!
    with client.websocket_connect(f"/ws/{session_id}?token=testtoken") as ws2:
        received2 = b""
        for _ in range(30):
            msg = receive_with_timeout(ws2, timeout=0.5)
            if msg and "bytes" in msg and msg["bytes"]:
                received2 += msg["bytes"]
                if b"persisted_terminal_data" in received2:
                    break
        assert b"persisted_terminal_data" in received2, f"Expected replayed data, got: {received2!r}"

    # 7. Delete session
    res = client.delete(f"/api/sessions/{session_id}", headers={"Authorization": "Bearer testtoken"})
    assert res.status_code == 200

    # 8. WebSocket with invalid token
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/default?token=badtoken"):
            pass

    # 9. WebSocket with valid token
    with client.websocket_connect(f"/ws/default?token=testtoken") as ws:
        # Send ping
        ws.send_text('{"type": "ping"}')
        found_pong = False
        for _ in range(30):
            msg = receive_with_timeout(ws, timeout=0.5)
            if msg and "text" in msg and msg["text"] and "pong" in msg["text"]:
                found_pong = True
                break
        assert found_pong, "Expected pong response from websocket"

    mgr.close_all()


def test_cloudflare_tunnel_decoding():
    from tunminal.tunnel import CloudflareTunnel
    import io

    tunnel = CloudflareTunnel(local_port=8080)
    # Simulate stderr emitting multibyte UTF-8 sequences (like byte 0xac) and tunnel URL
    # \u20ac in UTF-8 is b'\xe2\x82\xac' which caused 'gbk' codec UnicodeDecodeError on Windows
    simulated_output = (
        "2026-09-11T14:00:00Z INF Tunnel status: active € ⚡ 欢迎使用\n"
        "2026-09-11T14:00:01Z INF | https://test-sample-123.trycloudflare.com |\n"
    )

    class MockProc:
        def __init__(self):
            self.stderr = io.StringIO(simulated_output)
            self.poll = lambda: 0

    tunnel._proc = MockProc()
    tunnel._monitor_output()

    assert tunnel.tunnel_url == "https://test-sample-123.trycloudflare.com"
    assert tunnel._url_event.is_set()

