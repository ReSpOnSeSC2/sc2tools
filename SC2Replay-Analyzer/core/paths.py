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
CUSTOM_BUILDS_FILE = os.path.join(APP_DIR, "custom_builds.json")

DEBUG_VERBOSE = False
