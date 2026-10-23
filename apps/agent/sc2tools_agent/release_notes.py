"""Offline release notes bundled with the installer."""
from pathlib import Path
import sys


def bundled_notes():
    root=Path(getattr(sys,"_MEIPASS",Path(__file__).resolve().parents[1]))
    try:
        return (root/"CHANGELOG.md").read_text(encoding="utf-8")[:256000]
    except OSError:
        return "Release notes are available at https://sc2tools.com/download."
