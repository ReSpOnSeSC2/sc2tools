"""SC2 Tools Agent — local replay watcher + cloud uploader.

The agent runs on the user's gaming PC and:
  1. Watches the SC2 Replays folder.
  2. Parses each new ``.SC2Replay`` (sc2reader + the macro engine).
  3. Uploads the resulting JSON record to the SC2 Tools cloud API.
  4. Surfaces sync status in a system-tray icon.

The actual replay parsers (event_extractor, macro_score, ...) live in
the existing SC2Replay-Analyzer/ package — the agent imports them so we
never duplicate parsing logic. See ``replay_pipeline.py``.
"""

__version__ = "0.1.0"
