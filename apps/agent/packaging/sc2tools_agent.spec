# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the SC2 Tools Agent.

Builds a Windows distribution that bundles:

  * Python 3.12 runtime
  * sc2tools_agent (this package)
  * SC2Replay-Analyzer (sibling package, imported at runtime by
    replay_pipeline.py for sc2reader-based parsing)
  * sc2reader, watchdog, pystray, Pillow, requests, sentry-sdk
  * PySide6 (Qt6) - production GUI window

Build:
    cd apps/agent
    pyinstaller packaging/sc2tools_agent.spec

Output (one-folder, default):
    apps/agent/dist/sc2tools-agent/sc2tools-agent.exe
    apps/agent/dist/sc2tools-agent/_internal/...

Output (one-file, ONE_FILE=True):
    apps/agent/dist/sc2tools-agent.exe

We default to ONE-FOLDER mode (``ONE_FILE = False``). The reason is
multiprocessing compatibility on Windows: with ``ONE_FILE=True`` every
``ProcessPoolExecutor`` child re-launches the 319 MB self-extracting
exe, each child re-extracts its own ``%TEMP%\\_MEI{random}\\`` folder,
and N children spawn N simultaneous ~10 GB extractions. Antivirus
scanning + disk I/O contention make children crash with
``BrokenProcessPool('terminated abruptly')``, which is exactly the
failure the v0.5.7 watcher was fighting. One-folder mode extracts
once at install time and every spawn child loads from the existing
folder — no per-child extraction, no antivirus thrash, no spawn
crashes. Flip ONE_FILE to True only when shipping a stand-alone
download (e.g. a portable archive) where the installer flow isn't
acceptable.
"""

# noqa: E501

from pathlib import Path

# PyInstaller helpers for collecting whole packages — used for PySide6
# (Qt plugins) and sc2reader (CSV game-data files loaded via
# ``pkgutil.get_data`` which PyInstaller's static analyser cannot see).
from PyInstaller.utils.hooks import (  # type: ignore[import-not-found]
    collect_all,
    collect_data_files,
    collect_submodules,
)

ONE_FILE = False

HERE = Path.cwd()
REPO_ROOT = HERE / ".." / ".."
ANALYZER_DIR = REPO_ROOT / "SC2Replay-Analyzer"
REVEAL_DIR = REPO_ROOT / "reveal-sc2-opponent-main"
ICON_DIR = HERE / "sc2tools_agent" / "ui"

# Bring the analyzer source + its data dirs along so the bundled .exe
# can ``import core.sc2_replay_parser`` exactly the same way the
# source-run agent does. The actual parser entry point lives in
# reveal-sc2-opponent-main/core/, but we still ship the legacy
# SC2Replay-Analyzer companion package because some auxiliary helpers
# fall back to it. Both directories are added to sys.path at runtime by
# replay_pipeline._ensure_analyzer_on_path; the *reveal* layout wins.
DATAS = []
if ANALYZER_DIR.exists():
    for sub in ("core", "analytics", "scripts", "detectors", "data"):
        src = ANALYZER_DIR / sub
        if src.exists():
            DATAS.append((str(src), f"SC2Replay-Analyzer/{sub}"))

if REVEAL_DIR.exists():
    # ``core`` is mandatory (sc2_replay_parser, pulse_resolver, build defs).
    # ``data`` is optional but provides community build seeds and the
    # custom_builds defaults the parser reads at startup; without it the
    # parser still works (paths.py creates an empty data dir on demand)
    # but the build-name DB is empty.
    for sub in ("core", "data"):
        src = REVEAL_DIR / sub
        if src.exists():
            DATAS.append((str(src), f"reveal-sc2-opponent-main/{sub}"))

# Tray + GUI icon - referenced at runtime via Path(__file__).parent.
TRAY_ICON = ICON_DIR / "tray_icon.png"
if TRAY_ICON.exists():
    DATAS.append((str(TRAY_ICON), "sc2tools_agent/ui"))

# sc2reader internals + matplotlib pyplot lazy imports need explicit
# hidden imports because PyInstaller can't statically detect them.
# CRITICAL: sc2reader also ships CSV game-data files inside its wheel
# (sc2reader/data/HotS/, /LotV/, /WoL/) which it loads via
# ``pkgutil.get_data`` from ``sc2reader/constants.py``. PyInstaller's
# static analyser can't see those reads, so we collect them explicitly
# below — without this, every parse crashes with FileNotFoundError the
# moment sc2reader tries to look up a unit/ability ID. Bug surfaced
# in v0.3.5 once probe_analyzer started executing the import chain at
# boot; in earlier versions it failed silently per-replay.
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
# Pull EVERY sc2reader submodule + its bundled CSV game-data files.
# ``collect_submodules`` walks the package's __path__ and emits the
# full hidden-imports list; ``collect_data_files`` does the same for
# non-Python siblings (CSVs, JSONs). Both are idempotent against the
# explicit HIDDEN entries above.
HIDDEN += collect_submodules("sc2reader")
SC2READER_DATAS = collect_data_files("sc2reader")

# sc2reader CSV game-data files (collected above). MUST be in DATAS
# or every parse crashes with FileNotFoundError on the first lookup.
DATAS += SC2READER_DATAS

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
