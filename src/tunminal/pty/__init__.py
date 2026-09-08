import os
import shutil
import sys
from typing import List, Optional, Union

from tunminal.pty.base import BasePty


def get_default_shell() -> str:
    """Return default user shell based on operating system."""
    if sys.platform == "win32":
        # Check for powershell.exe or cmd.exe
        pwsh = shutil.which("powershell.exe") or shutil.which("pwsh.exe")
        return pwsh if pwsh else os.environ.get("COMSPEC", "cmd.exe")
    return os.environ.get("SHELL") or shutil.which("zsh") or shutil.which("bash") or "/bin/sh"


def detect_cli_tools() -> dict:
    """Detect presence of interactive AI coding CLI tools like Claude and Codex."""
    return {
        "claude": shutil.which("claude") is not None,
        "codex": shutil.which("codex") is not None,
        "shell": True,
    }


def spawn_pty(
    command: Optional[Union[str, List[str]]] = None,
    cwd: Optional[str] = None,
    env: Optional[dict] = None,
    cols: int = 80,
    rows: int = 24,
) -> BasePty:
    """Factory creating platform-specific PTY session."""
    if command is None or command == "":
        command = [get_default_shell()]
    elif isinstance(command, str):
        # Check if single word command exists or needs shell parsing
        parts = command.strip().split()
        if len(parts) == 1 and shutil.which(parts[0]):
            command = [shutil.which(parts[0])]
        elif len(parts) > 1 and shutil.which(parts[0]):
            command = [shutil.which(parts[0])] + parts[1:]

    if sys.platform == "win32":
        from tunminal.pty.windows import WindowsPty

        return WindowsPty(command=command, cwd=cwd, env=env, cols=cols, rows=rows)
    else:
        from tunminal.pty.unix import UnixPty

        return UnixPty(command=command, cwd=cwd, env=env, cols=cols, rows=rows)


__all__ = ["BasePty", "spawn_pty", "get_default_shell", "detect_cli_tools"]
