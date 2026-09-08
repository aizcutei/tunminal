from abc import ABC, abstractmethod
from typing import Optional


class BasePty(ABC):
    """Abstract base class for platform-independent pseudo-terminal sessions."""

    @property
    @abstractmethod
    def pid(self) -> Optional[int]:
        """Return the process ID of the child process."""
        pass

    @abstractmethod
    def is_alive(self) -> bool:
        """Check if the child process is still running."""
        pass

    @abstractmethod
    def write(self, data: bytes) -> None:
        """Write bytes to the PTY stdin."""
        pass

    @abstractmethod
    def resize(self, cols: int, rows: int) -> None:
        """Resize the PTY terminal window dimensions."""
        pass

    @abstractmethod
    async def read(self) -> bytes:
        """Asynchronously read the next chunk of output from the PTY stdout.
        Returns b"" on EOF / process termination.
        """
        pass

    @abstractmethod
    def close(self) -> None:
        """Terminate the child process and close PTY file descriptors / handles."""
        pass
