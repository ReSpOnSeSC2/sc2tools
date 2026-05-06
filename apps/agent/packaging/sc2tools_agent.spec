# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the SC2 Tools Agent.

Builds a single Windows EXE that bundles:

  * Python 3.12 runtime
  * sc2tools_agent (this package)
  * SC2Replay-Analyzer (sibling package, imported at runtime by
    replay_pipeline.py for sc2reader-based parsing)
  * sc2reader, watchdog, pystray, Pillow, requests, sentry-sdk
  * PySide6 (Qt6) - production GUI window

Build:
    cd apps/agent
    pyinstaller packaging/sc2tools_agent.spec

Output:
    apps/agent/dist/sc2tools-agent/sc2tools-agent.exe       (one-folder)
    apps/agent/dist/sc2tools-agent.exe                       (one-file)

We default to one-folder mode for faster startup; flip ONE_FILE to True
for a single .exe (slower first-run because the runtime unpacks into
%TEMP%, but easier to ship as a stand-alone download).
"""

# noqa: E501

from pathlib import Path

# PyInstaller helper for collecting whole packages - used for PySide6
# so every Qt plugin (platforms, imageformats, styles) is bundled.
from PyInstaller.utils.hooks import collect_all  # type: ignore[import-not-found]

ONE_FILE = True

HERE = Path.cwd()
ANALYZER_DIR = HERE / ".." / ".." / "SC2Replay-Analyzer"
ICON_DIR = HERE / "sc2tools_agent" / "ui"

# Bring the analyzer's Python source + its data dir along so the
# bundled .exe can `import core.sc2_replay_parser` exactly the same
# way the source-run agent does.
DATAS = []
if ANALYZER_DIR.exists():
    for sub in ("core", "analytics", "scripts", "detectors", "data"):
        src = ANALYZER_DIR / sub
        if src.exists():
            DATAS.append((str(src), f"SC2Replay-Analyzer/{sub}"))

# Tray + GUI icon - referenced at runtime via Path(__file__).parent.
TRAY_ICON = ICON_DIR / "tray_icon.png"
if TRAY_ICON.exists():
    DATAS.append((str(TRAY_ICON), "sc2tools_agent/ui"))

# sc2reader internals + matplotlib pyplot lazy imports need explicit
# hidden imports because PyInstaller can't statically detect them.
HIDDEN = [
    "sc2reader",
    "sc2reader.engine",
    "sc2reader.events",
    "sc2reader.factories",
    "sc2reader.factories.plugins",
    "sc2reader.objects",
    "sc2reader.scripts",
    "watchdog.observers",
    "watchdog.observers.polling",
    "watchdog.events",
    "pystray._win32",
    "PIL._imagingtk",
    "tkinter",
    "tkinter.filedialog",
    "sentry_sdk",
    "sentry_sdk.integrations",
]

# PySide6 - collect_all pulls every submodule, plus the Qt plugin
# directories the windowed runtime needs (qwindows, etc.). Without
# this, the frozen .exe boots and immediately fails with
# "could not find or load the Qt platform plugin".
PYSIDE6_DATAS, PYSIDE6_BINARIES, PYSIDE6_HIDDEN = collect_all("PySide6")
DATAS += PYSIDE6_DATAS
BINARIES = list(PYSIDE6_BINARIES)
HIDDEN += PYSIDE6_HIDDEN
HIDDEN += [
    "PySide6.QtCore",
    "PySide6.QtGui",
    "PySide6.QtWidgets",
]

block_cipher = None

a = Analysis(
    ["../sc2tools_agent/__main__.py"],
    pathex=[str(HERE / "..")],
    binaries=BINARIES,
    datas=DATAS,
    hiddenimports=HIDDEN,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Keep the bundle slim - we don't ship Jupyter, IPython, or
        # tests in the user-facing .exe. We also drop the PySide6
        # modules the agent doesn't touch (QtWebEngine, QtSql, 3D)
        # - that trims a lot out of the installer.
        "IPython",
        "jupyter",
        "pytest",
        "matplotlib.tests",
        "numpy.tests",
        "PySide6.QtWebEngineCore",
        "PySide6.QtWebEngineWidgets",
        "PySide6.QtMultimedia",
        "PySide6.QtMultimediaWidgets",
        "PySide6.QtSql",
        "PySide6.Qt3DCore",
        "PySide6.Qt3DRender",
        "PySide6.QtBluetooth",
        "PySide6.QtCharts",
        "PySide6.QtDataVisualization",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

EXE_NAME = "sc2tools-agent"
# Icon lives under packaging/ next to this spec. We probe both that
# canonical location and the legacy HERE root so a developer dropping
# an icon.ico at the agent root for quick iteration still works.
_ICON_CANDIDATES = [
    HERE / "packaging" / "icon.ico",
    HERE / "icon.ico",
]
ICON_PATH = next((p for p in _ICON_CANDIDATES if p.exists()), None)
ICON_KW = {"icon": str(ICON_PATH)} if ICON_PATH else {}

if ONE_FILE:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        [],
        name=EXE_NAME,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        **ICON_KW,
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name=EXE_NAME,
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        **ICON_KW,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name=EXE_NAME,
    )
