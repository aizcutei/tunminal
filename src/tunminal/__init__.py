"""Tunminal - Cross-platform web terminal server for remote access to AI coding CLI tools."""

__version__ = "0.1.14"


def main():
    from tunminal.cli import main as _main
    return _main()


__all__ = ["main", "__version__"]
