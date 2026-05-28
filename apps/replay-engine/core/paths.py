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


# Stage 7.5+: the Express SPA writes user-authored custom builds to its own
# data directory (reveal-sc2-opponent-main/data/custom_builds.json). When
# both the Python analyzer and the Express backend live under a shared
# install root (the documented production layout: C:\SC2TOOLS\), the
# Python detector should read the Express copy so the two engines never
# disagree about which builds exist. Fallback chain:
#   1. SC2T_CUSTOM_BUILDS_FILE env var (tests, dev overrides)
#   2. ../reveal-sc2-opponent-main/data/custom_builds.json (production)
#   3. <APP_DIR>/custom_builds.json (legacy / standalone)
_LEGACY_CUSTOM_BUILDS_FILE = os.path.join(APP_DIR, "custom_builds.json")
_EXPRESS_CUSTOM_BUILDS_FILE = os.path.normpath(os.path.join(
    APP_DIR, "..", "reveal-sc2-opponent-main", "data", "custom_builds.json",
))


def _resolve_custom_builds_file() -> str:
    """Pick the canonical custom_builds.json for this install.

    Resolution order is documented above. The function is called once at
    import time; tests that need to point at a different file should set
    `SC2T_CUSTOM_BUILDS_FILE` *before* importing this module, or
    monkey-patch `detectors.definitions.CUSTOM_BUILDS_FILE` directly.
    """
    override = os.environ.get("SC2T_CUSTOM_BUILDS_FILE")
    if override:
        return override
    if os.path.isfile(_EXPRESS_CUSTOM_BUILDS_FILE):
        return _EXPRESS_CUSTOM_BUILDS_FILE
    return _LEGACY_CUSTOM_BUILDS_FILE


CUSTOM_BUILDS_FILE = _resolve_custom_builds_file()

DEBUG_VERBOSE = False
