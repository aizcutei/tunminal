# -*- mode: python ; coding: utf-8 -*-
import sys
from pathlib import Path

block_cipher = None

# Determine base directory
ROOT_DIR = Path(__file__).parent.resolve() if "__file__" in locals() else Path(".").resolve()
static_src = ROOT_DIR / "src" / "tunminal" / "static"

datas = []
if static_src.exists():
    datas.append((str(static_src), "tunminal/static"))

hidden_imports = [
    "uvicorn",
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "fastapi",
    "fastapi.staticfiles",
    "pystray",
    "PIL",
    "PIL.Image",
    "PIL.ImageDraw",
    "qrcode",
    "websockets",
]

if sys.platform == "win32":
    hidden_imports.extend(["pystray._win32", "pywinpty"])
elif sys.platform == "darwin":
    hidden_imports.extend(["pystray._darwin", "AppKit", "Quartz", "PyObjCTools"])
else:
    hidden_imports.extend(["pystray._xorg", "pystray._appindicator", "pystray._gtk", "Xlib"])

a = Analysis(
    ["src/tunminal/cli.py"],
    pathex=["src"],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="tunminal",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
