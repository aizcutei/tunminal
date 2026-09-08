import hmac
import io
import os
import secrets
from pathlib import Path
from typing import Optional
from fastapi import HTTPException, Request, WebSocket, status
import qrcode


class AuthManager:
    """Handles token authentication, session cookies, and terminal QR code display."""

    def __init__(self, token: Optional[str] = None):
        if token:
            self.token = token.strip()
        else:
            env_token = os.environ.get("TUNMINAL_TOKEN")
            if env_token:
                self.token = env_token.strip()
            else:
                self.token = self._load_or_create_token()

    @staticmethod
    def _load_or_create_token() -> str:
        """Load persistent token from ~/.tunminal/token or generate and save a new one."""
        token_dir = Path.home() / ".tunminal"
        token_file = token_dir / "token"
        try:
            if token_file.exists():
                saved = token_file.read_text(encoding="utf-8").strip()
                if saved:
                    return saved
        except Exception:
            pass

        # Generate new token and save securely
        new_token = secrets.token_urlsafe(18)
        try:
            token_dir.mkdir(parents=True, exist_ok=True)
            token_file.write_text(new_token, encoding="utf-8")
            token_file.chmod(0o600)
        except Exception:
            pass
        return new_token

    def is_valid_token(self, candidate: Optional[str]) -> bool:
        if not candidate or not self.token:
            return False
        return hmac.compare_digest(self.token, candidate.strip())

    def extract_token(self, request: Request) -> Optional[str]:
        """Extract token from query param, Authorization header, or cookie."""
        # 1. Query parameter
        query_token = request.query_params.get("token")
        if query_token:
            return query_token

        # 2. Authorization header: Bearer <token>
        auth_header = request.headers.get("Authorization")
        if auth_header and auth_header.startswith("Bearer "):
            return auth_header[7:].strip()

        # 3. Cookie
        cookie_token = request.cookies.get("tunminal_token")
        if cookie_token:
            return cookie_token

        return None

    def verify_request(self, request: Request) -> None:
        """Verify HTTP request token; raises 401 HTTPException if invalid."""
        token = self.extract_token(request)
        if not self.is_valid_token(token):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or missing authentication token",
            )

    def verify_websocket(self, websocket: WebSocket) -> bool:
        """Verify WebSocket authentication from query parameter, header, or cookie."""
        token = websocket.query_params.get("token")
        if not token:
            auth_header = websocket.headers.get("Authorization")
            if auth_header and auth_header.startswith("Bearer "):
                token = auth_header[7:].strip()
        if not token:
            token = websocket.cookies.get("tunminal_token")

        return self.is_valid_token(token)

    def make_magic_url(self, base_url: str) -> str:
        """Append the authentication token to base URL for one-click access."""
        sep = "&" if "?" in base_url else "?"
        return f"{base_url.rstrip('/')}/{sep}token={self.token}"

    def print_qr_code(self, url: str, label: str = "Scan this QR code with your phone to open:") -> None:
        """Print high-contrast ANSI QR code to stdout for easy mobile camera scanning."""
        print("\n" + "=" * 50)
        print(f"  \033[1;36m{label}\033[0m")
        print("=" * 50)
        try:
            qr = qrcode.QRCode()
            qr.add_data(url)
            qr.print_ascii(invert=True)
        except Exception as e:
            print(f"(QR code generation failed: {e})")
        print(f"  URL: \033[1;32m{url}\033[0m")
        print("=" * 50 + "\n")
