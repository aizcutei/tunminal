import os
import shlex
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
        # Parse command string handling quotes safely
        try:
            parts = shlex.split(command, posix=(sys.platform != "win32"))
        except ValueError:
            parts = command.strip().split()
        if parts:
            exe = shutil.which(parts[0])
            if exe:
                command = [exe] + parts[1:]
            else:
                command = parts

    if sys.platform == "win32":
        from tunminal.pty.windows import WindowsPty

        return WindowsPty(command=command, cwd=cwd, env=env, cols=cols, rows=rows)
    else:
        from tunminal.pty.unix import UnixPty

        return UnixPty(command=command, cwd=cwd, env=env, cols=cols, rows=rows)


__all__ = ["BasePty", "spawn_pty", "get_default_shell", "detect_cli_tools"]
