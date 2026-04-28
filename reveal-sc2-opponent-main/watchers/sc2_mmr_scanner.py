"""
DEPRECATED — OCR-based MMR scanning was removed.

This module is intentionally inert. MMR is now sourced from SC2Pulse
via the Node backend (stream-overlay-backend/index.js).

Safe to delete this file. See REMOVE_OCR_FILES.ps1 at the project root.
"""
import sys

if __name__ == "__main__":
    sys.stderr.write(
        "watchers.sc2_mmr_scanner is deprecated. "
        "MMR is now fetched from SC2Pulse by the overlay backend.\n"
    )
    sys.exit(0)
