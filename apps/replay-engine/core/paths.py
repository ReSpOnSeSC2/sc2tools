"""Shared filesystem paths and global toggles.

`APP_DIR` resolves to the directory containing the entry script regardless of
whether the app runs from source or a PyInstaller-frozen binary. All other
path constants are derived from it so the app remains portable.
"""

import os
import sys


if getattr(sys, "frozen", False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    # core/paths.py lives at <project_root>/core/paths.py — go one level up.
    APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DB_FILE = os.path.join(APP_DIR, "meta_database.json")
CONFIG_FILE = os.path.join(APP_DIR, "config.json")
ERROR_LOG_FILE = os.path.join(APP_DIR, "replay_errors.log")

# The engine's bundled data directory: build/custom-build seeds, the
# custom_builds schema, map images, and map bounds all live here. The
# desktop agent bundles this directory alongside the engine and the API
# Docker image COPYs it to /opt/sc2-analyzer/data.
DATA_DIR = os.path.join(APP_DIR, "data")


def _resolve_custom_builds_file() -> str:
    """Pick the canonical custom_builds.json for this install.

    Both the engine's detectors and the replay parser read this single
    file so the two never disagree about which builds exist. The
    SC2T_CUSTOM_BUILDS_FILE env var (tests, dev overrides) wins;
    otherwise the bundled DATA_DIR copy is used. The function is called
    once at import time; tests that need a different file should set the
    env var *before* importing this module.
    """
    override = os.environ.get("SC2T_CUSTOM_BUILDS_FILE")
    if override:
        return override
    return os.path.join(DATA_DIR, "custom_builds.json")


CUSTOM_BUILDS_FILE = _resolve_custom_builds_file()

DEBUG_VERBOSE = False
