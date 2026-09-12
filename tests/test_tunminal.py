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

    # 7. File transfer endpoints
    # 7a. List files in session
    res = client.get(f"/api/sessions/{session_id}/files", headers={"Authorization": "Bearer testtoken"})
    assert res.status_code == 200
    files_data = res.json()
    assert "cwd" in files_data
    assert "items" in files_data

    # 7b. File upload to session
    upload_content = b"tunminal_vibe_term_file_upload_test"
    res = client.post(
        f"/api/sessions/{session_id}/upload?filename=test_upload.txt",
        headers={"Authorization": "Bearer testtoken"},
        content=upload_content,
    )
    assert res.status_code == 200
    assert res.json()["status"] == "success"
    assert res.json()["filename"] == "test_upload.txt"

    # 7c. Verify uploaded file appears in file list
    res = client.get(f"/api/sessions/{session_id}/files", headers={"Authorization": "Bearer testtoken"})
    assert res.status_code == 200
    assert any(item["name"] == "test_upload.txt" for item in res.json()["items"])

    # 7d. Download uploaded file
    res = client.get(
        f"/api/sessions/{session_id}/download?path=test_upload.txt",
        headers={"Authorization": "Bearer testtoken"},
    )
    assert res.status_code == 200
    assert res.content == upload_content

    # 7e. Path traversal security (must return 403)
    res = client.get(
        f"/api/sessions/{session_id}/download?path=../../../../etc/passwd",
        headers={"Authorization": "Bearer testtoken"},
    )
    assert res.status_code == 403

    res = client.get(
        f"/api/sessions/{session_id}/files?path=../../../../etc",
        headers={"Authorization": "Bearer testtoken"},
    )
    assert res.status_code == 403

    # Clean up uploaded test file
    import pathlib
    uploaded_path = pathlib.Path(session.get_cwd()) / "test_upload.txt"
    if uploaded_path.exists():
        uploaded_path.unlink()

    # 8. Delete session
    res = client.delete(f"/api/sessions/{session_id}", headers={"Authorization": "Bearer testtoken"})
    assert res.status_code == 200

    # 9. WebSocket with invalid token
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/default?token=badtoken"):
            pass

    # 10. WebSocket with valid token and nonce ping
    with client.websocket_connect(f"/ws/default?token=testtoken") as ws:
        # Send ping with time and nonce
        ws.send_text('{"type": "ping", "time": 1726000000, "nonce": "test_nonce_123"}')
        found_pong = False
        for _ in range(30):
            msg = receive_with_timeout(ws, timeout=0.5)
            if msg and "text" in msg and msg["text"] and "pong" in msg["text"]:
                import json
                data = json.loads(msg["text"])
                if data.get("type") == "pong" and data.get("nonce") == "test_nonce_123" and data.get("time") == 1726000000:
                    found_pong = True
                    break
        assert found_pong, "Expected pong response with matched nonce and time"

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


def test_osc_color_report_filtering():
    from tunminal.session import TerminalSession, OSC_COLOR_REPORT_BYTES

    class MockPty:
        def __init__(self):
            self.written = []

        def write(self, data: bytes):
            self.written.append(data)

        def is_alive(self):
            return True

    session = TerminalSession(session_id="test-session", name="Test")
    mock_pty = MockPty()
    session._pty = mock_pty

    # 1. Full OSC color reports with ESC (\x1b)
    session.write(b"\x1b]10;rgb:f0f0/f6f6/fcfc\x1b\\\x1b]11;rgb:0a0a/0c0c/1010\x1b\\")
    assert mock_pty.written == []

    # 2. OSC color reports with BEL (\x07)
    session.write(b"\x1b]10;rgb:f0f0/f6f6/fcfc\x07")
    assert mock_pty.written == []

    # 3. Stripped OSC sequences (as leaked through Windows ConPTY)
    session.write(b"]10;rgb:f0f0/f6f6/fcfc\\]11;rgb:0a0a/0c0c/1010\\")
    assert mock_pty.written == []

    # 4. Normal keystrokes / commands must pass through untouched
    session.write(b"ls -la\r\n")
    assert mock_pty.written == [b"ls -la\r\n"]

    # 5. Mixed keystrokes with OSC sequence in the middle
    session.write(b"prompt_before\x1b]10;rgb:ffff/ffff/ffff\x1b\\prompt_after")
    assert mock_pty.written == [b"ls -la\r\n", b"prompt_beforeprompt_after"]


def test_named_tunnel_config_parsing(tmp_path):
    from tunminal.tunnel import find_hostname_in_config

    cfg_file = tmp_path / "config.yml"
    cfg_file.write_text(
        """
tunnel: 12345678-abcd-1234-abcd-1234567890ab
credentials-file: /path/to/credentials.json
ingress:
  - hostname: term.mycompany.com
    service: http://localhost:8080
  - hostname: api.mycompany.com
    service: http://127.0.0.1:3000
  - service: http_status:404
""",
        encoding="utf-8",
    )

    # Ingress for port 8080 should resolve to term.mycompany.com
    hostname = find_hostname_in_config(str(cfg_file), port=8080)
    assert hostname == "term.mycompany.com"

    # Ingress for port 3000 should resolve to api.mycompany.com
    hostname_3000 = find_hostname_in_config(str(cfg_file), port=3000)
    assert hostname_3000 == "api.mycompany.com"

    # Ingress for port 9999 should return None
    assert find_hostname_in_config(str(cfg_file), port=9999) is None


def test_cloudflare_tunnel_command_generation(monkeypatch):
    from tunminal.tunnel import CloudflareTunnel

    # Mock get_cloudflared_path
    monkeypatch.setattr("tunminal.tunnel.get_cloudflared_path", lambda: "/mock/cloudflared")

    # 1. Quick Tunnel (HTTP/2 protocol default)
    qt = CloudflareTunnel(local_port=8080, protocol="http2")
    assert qt.protocol == "http2"
    assert qt.tunnel_token is None

    # 2. Named Tunnel with Token
    nt = CloudflareTunnel(local_port=8080, tunnel_token="eyJhToken123", protocol="http2")
    assert nt.tunnel_token == "eyJhToken123"
    assert nt.protocol == "http2"


def test_detect_existing_tunnel_mocked(monkeypatch, tmp_path):
    from tunminal.tunnel import detect_existing_tunnel, ServiceStatus

    # Simulate running service
    monkeypatch.setattr("tunminal.tunnel.check_windows_service", lambda: (ServiceStatus.RUNNING, "Cloudflared"))
    monkeypatch.setattr("sys.platform", "win32")

    info = detect_existing_tunnel(port=8080)
    assert info.service_status == ServiceStatus.RUNNING
    assert info.service_name == "Cloudflared"



