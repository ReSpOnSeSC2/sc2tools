# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the SC2 Tools Agent.

Builds a single Windows EXE that bundles:

  * Python 3.12 runtime
  * sc2tools_agent (this package)
  * SC2Replay-Analyzer (sibling package, imported at runtime by
    replay_pipeline.py for sc2reader-based parsing)
  * sc2reader, watchdog, pystray, Pillow, requests, sentry-sdk

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

ONE_FILE = True

HERE = Path.cwd()
ANALYZER_DIR = HERE / ".." / ".." / "SC2Replay-Analyzer"

# Bring the analyzer's Python source + its data dir along so the
# bundled .exe can `import core.sc2_replay_parser` exactly the same
# way the source-run agent does.
DATAS = []
if ANALYZER_DIR.exists():
    for sub in ("core", "analytics", "scripts", "detectors", "data"):
        src = ANALYZER_DIR / sub
        if src.exists():
            DATAS.append((str(src), f"SC2Replay-Analyzer/{sub}"))

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

block_cipher = None

a = Analysis(
    ["../sc2tools_agent/__main__.py"],
    pathex=[str(HERE / "..")],
    binaries=[],
    datas=DATAS,
    hiddenimports=HIDDEN,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Keep the bundle slim — we don't ship Jupyter, IPython, or
        # tests in the user-facing .exe.
        "IPython",
        "jupyter",
        "pytest",
        "matplotlib.tests",
        "numpy.tests",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

EXE_NAME = "sc2tools-agent"
ICON_PATH = HERE / "icon.ico"
ICON_KW = {"icon": str(ICON_PATH)} if ICON_PATH.exists() else {}

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
