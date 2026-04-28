"""
DEPRECATED — OCR-based MMR scanning was removed.

This module is intentionally inert. MMR is now sourced from SC2Pulse
via the Node backend (stream-overlay-backend/index.js), which is the
single source of truth for both player and opponent MMR.

The original OCR scanner was deleted because it was unreliable on
non-1080p displays and on multi-monitor setups, and because SC2Pulse
already exposes the same data through a stable HTTP API.

Safe to delete this file. See REMOVE_OCR_FILES.ps1 at the project root.
"""
import sys

if __name__ == "__main__":
    sys.stderr.write(
        "sc2_mmr_scanner.py is deprecated. "
        "MMR is now fetched from SC2Pulse by the overlay backend. "
        "Delete this file (see REMOVE_OCR_FILES.ps1).\n"
    )
    sys.exit(0)
