"""
Centralized filesystem paths for the merged SC2 Tools project.

This module is the single source of truth for where data files live.
Both the stream overlay watchers and the analyzer GUI read from these
constants so the unified `/data/` folder stays consistent.

Layout:
    <project_root>/
        core/                       -- this package
        gui/                        -- analyzer GUI
        watchers/                   -- replay watcher + MMR scanner
        stream-overlay-backend/     -- Node.js overlay server
        SC2-Overlay/                -- HTML/CSS/JS overlay client
        data/                       -- unified runtime data
            MyOpponentHistory.json  -- pulse-id keyed Black Book
            meta_database.json      -- build-name keyed analyzer DB
            custom_builds.json      -- user-defined Spawning Tool builds
            config.json             -- last_player and similar prefs
            replay_errors.log       -- analyzer error log
            session.state.json      -- (optional) overlay session backup
"""

import os
import sys

# --- PROJECT ROOT ---
# When frozen by PyInstaller this resolves to the dist directory; otherwise
# it walks up from this file location.
if getattr(sys, "frozen", False):
    PROJECT_ROOT = os.path.dirname(sys.executable)
else:
    PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))

# --- DATA FOLDER ---
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# --- DATA FILES ---
HISTORY_FILE = os.path.join(DATA_DIR, "MyOpponentHistory.json")
META_DB_FILE = os.path.join(DATA_DIR, "meta_database.json")
CUSTOM_BUILDS_FILE = os.path.join(DATA_DIR, "custom_builds.json")
CONFIG_FILE = os.path.join(DATA_DIR, "config.json")
ERROR_LOG_FILE = os.path.join(DATA_DIR, "replay_errors.log")
SESSION_STATE_FILE = os.path.join(DATA_DIR, "session.state.json")

# --- OVERLAY-FACING FILES ---
# These live at the project root because the Node.js backend and OCR scanner
# expect them at fixed locations the overlay was originally built against.
OPPONENT_TXT = os.path.join(PROJECT_ROOT, "opponent.txt")
SCANNED_MMR_TXT = os.path.join(PROJECT_ROOT, "scanned_mmr.txt")

# --- SHIM: legacy MyOpponentHistory.json at project root ---
# If the user's existing setup keeps the Black Book at the project root,
# expose its path so the migration script can find it. The watcher will
# always write to DATA_DIR going forward.
LEGACY_HISTORY_FILE = os.path.join(PROJECT_ROOT, "MyOpponentHistory.json")


def existing_history_path() -> str:
    """
    Resolve which MyOpponentHistory.json is authoritative.

    Preference order:
        1. data/MyOpponentHistory.json (the merged target)
        2. <project_root>/MyOpponentHistory.json (legacy location)
    Returns the path that exists; defaults to the data/ path if neither does.
    """
    if os.path.exists(HISTORY_FILE):
        return HISTORY_FILE
    if os.path.exists(LEGACY_HISTORY_FILE):
        return LEGACY_HISTORY_FILE
    return HISTORY_FILE
