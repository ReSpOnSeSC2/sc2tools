"""
SC2 MMR scanner - dual-zone screen OCR.

Continuously screen-grabs the two MMR text regions of the SC2 loading
screen, OCRs each one with Tesseract, validates the result against a
4-digit MMR range, and writes the comma-joined values to
`scanned_mmr.txt` at the project root. The Node overlay backend
watches that file and emits the `mmrDelta` event when it changes.

This module is a near-verbatim move of the legacy `sc2_mmr_scanner.py`
into the unified `watchers/` package, with the output path centralized
through `core.paths.SCANNED_MMR_TXT` so the overlay backend keeps
finding it at the same project-root location.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from typing import List, Optional

# Allow running standalone or as part of the package.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_THIS_DIR)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from core.paths import SCANNED_MMR_TXT  # noqa: E402


# =========================================================
# Tesseract auto-detection
# =========================================================
def find_tesseract() -> Optional[str]:
    """Return the path to tesseract.exe, or None if not found."""
    on_path = shutil.which("tesseract")
    if on_path:
        return on_path

    username = os.environ.get("USERNAME", "")
    candidates = [
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        rf"C:\Users\{username}\AppData\Local\Tesseract-OCR\tesseract.exe",
        r"C:\tools\Tesseract-OCR\tesseract.exe",
        r"C:\ProgramData\chocolatey\bin\tesseract.exe",
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


# =========================================================
# Calibrated capture zones
# =========================================================
# Zone 1 (Original / left side)
Z1 = {"top": 466, "left": 470, "width": 46, "height": 15}
# Zone 2 (Right side)
Z2 = {"top": 468, "left": 1401, "width": 51, "height": 11}


# =========================================================
# OCR
# =========================================================
def _scan_zone(sct, monitor, pytesseract, cv2, np) -> Optional[str]:
    img = np.array(sct.grab(monitor))
    gray = cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    gray = cv2.resize(gray, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
    _, thresh = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY_INV)
    config = r"--oem 3 --psm 7 -c tessedit_char_whitelist=0123456789"
    text = pytesseract.image_to_string(thresh, config=config).strip()
    if text.isdigit() and 1000 <= int(text) <= 8000:
        return text
    return None


# =========================================================
# Main loop
# =========================================================
def main() -> int:
    # Lazy imports so the rest of the merged toolkit doesn't pay the
    # opencv/mss/pytesseract import tax unless this watcher actually runs.
    try:
        import cv2  # noqa: WPS433
        import mss  # noqa: WPS433
        import numpy as np  # noqa: WPS433
        import pytesseract  # noqa: WPS433
    except ImportError as exc:
        print(
            "[MMR] Required library missing: "
            f"{exc}\nInstall with: pip install opencv-python mss pytesseract numpy"
        )
        return 1

    tesseract_path = find_tesseract()
    if not tesseract_path:
        print("=" * 60)
        print("ERROR: Tesseract OCR engine not found!")
        print("")
        print("Install from:  https://github.com/UB-Mannheim/tesseract/wiki")
        print("Make sure 'Add Tesseract to system PATH' is checked.")
        print("=" * 60)
        return 1

    pytesseract.pytesseract.tesseract_cmd = tesseract_path
    print(f"[MMR] Tesseract found at: {tesseract_path}")
    print(f"[MMR] Output file:        {SCANNED_MMR_TXT}")
    print("[MMR] Dual-zone scanner running. Watching both sides...")

    with mss.mss() as sct:
        while True:
            try:
                mmr_l = _scan_zone(sct, Z1, pytesseract, cv2, np)
                mmr_r = _scan_zone(sct, Z2, pytesseract, cv2, np)

                if mmr_l or mmr_r:
                    found: List[str] = [m for m in (mmr_l, mmr_r) if m]
                    print(f"[MMR] Detected on screen: {', '.join(found)}")
                    try:
                        os.makedirs(os.path.dirname(SCANNED_MMR_TXT), exist_ok=True)
                    except (OSError, ValueError):
                        pass
                    with open(SCANNED_MMR_TXT, "w", encoding="utf-8") as f:
                        f.write(",".join(found))
                    time.sleep(20)  # cooldown for the rest of the loading screen

                time.sleep(0.5)
            except KeyboardInterrupt:
                print("\n[MMR] Stopped.")
                return 0
            except Exception as exc:
                print(f"[MMR] Scan error: {exc}")
                time.sleep(2)


if __name__ == "__main__":
    sys.exit(main())
