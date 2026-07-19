# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for NVIDIA Hub standalone builds (Windows + Linux)."""
from PyInstaller.utils.hooks import collect_submodules

hiddenimports = (
    collect_submodules("uvicorn")
    + ["websockets", "wsproto", "httptools", "socksio"]
)

a = Analysis(
    ["launcher.py"],
    pathex=[],
    binaries=[],
    datas=[("static", "static"), ("icon.png", ".")],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="nvidia-hub",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
)
