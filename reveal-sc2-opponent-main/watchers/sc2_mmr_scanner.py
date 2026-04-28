"""
SC2 MMR scanner - dual-zone screen OCR.

Continuously screen-grabs the two MMR text regions of the SC2 loading
screen, OCRs each one with Tesseract, validates the result against a
4-digit MMR range, and writes the comma-joined values to
`scanned_mmr.txt` at the project root. The Node overlay backend
watches that file and emits the `mmrDelta` event when it changes.

Stage 6.2 hardening:
- Per-zone logging so we can see which zone is failing.
- Bounded "patience" loop: keep scanning until BOTH zones have a value
  (or DUAL_ZONE_PATIENCE_SECONDS elapses), instead of committing the
  first single-zone hit and napping for 20 seconds.
- MMR_DEBUG=1 env-var: dump the cropped + thresholded zone images to
  disk every loop so the user can recalibrate zone coordinates if their
  monitor / SC2 window differs from the calibrated 1920x1080.
- Atomic write of scanned_mmr.txt (write -> fsync -> rename) so the
  Node-side watcher never sees a torn file.

Example:
    >>> # In a separate terminal, with SC2 on the loading screen:
    >>> # > MMR_DEBUG=1 python -m watchers.sc2_mmr_scanner
    >>> # Inspect mmr_debug_left_*.png and mmr_debug_right_*.png to see
    >>> # exactly which crop the OCR is being given.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from typing import List, Optional, Tuple

# Allow running standalone or as part of the package.
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_THIS_DIR)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from core.paths import SCANNED_MMR_TXT  # noqa: E402


# =========================================================
# Calibrated capture zones (1920x1080 fullscreen SC2)
# =========================================================
ZONE_LEFT = {"top": 466, "left": 470, "width": 46, "height": 15}
ZONE_RIGHT = {"top": 468, "left": 1401, "width": 51, "height": 11}

# =========================================================
# Tunables -- extracted from inline magic numbers
# =========================================================
MMR_VALID_MIN = 1000
MMR_VALID_MAX = 8000
OCR_UPSCALE_FACTOR = 3
OCR_BINARY_THRESHOLD = 150
OCR_TESSERACT_CONFIG = (
    r"--oem 3 --psm 7 -c tessedit_char_whitelist=0123456789"
)
SCAN_INTERVAL_SECONDS = 0.5
# Once we get any hit, keep scanning for up to this long to collect the
# OTHER zone before we commit. Loading screens reveal both player tiles
# asynchronously; this prevents single-zone reads from locking in early.
DUAL_ZONE_PATIENCE_SECONDS = 8
# After we commit a write, sleep this long so we don't keep re-OCRing
# the same loading screen.
POST_HIT_COOLDOWN_SECONDS = 20

def _resolve_debug() -> bool:
    """Return True if --debug / -d is on argv or MMR_DEBUG=1 in env.

    Example:
        >>> # argv=['sc2_mmr_scanner', '--debug']
        >>> # _resolve_debug()  -> True
    """
    if "--debug" in sys.argv or "-d" in sys.argv:
        return True
    return os.environ.get("MMR_DEBUG") == "1"


DEBUG = _resolve_debug()


# =========================================================
# Tesseract auto-detection
# =========================================================
def find_tesseract() -> Optional[str]:
    """Return the path to tesseract.exe, or None if not found.

    Example:
        >>> path = find_tesseract()  # doctest: +SKIP
        >>> isinstance(path, str) or path is None
        True
    """
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
# OCR helpers
# =========================================================
def _preprocess(img, cv2):
    """Convert raw mss screen-grab to the binary image fed to Tesseract."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGRA2GRAY)
    gray = cv2.resize(
        gray, None,
        fx=OCR_UPSCALE_FACTOR, fy=OCR_UPSCALE_FACTOR,
        interpolation=cv2.INTER_CUBIC,
    )
    _, thresh = cv2.threshold(
        gray, OCR_BINARY_THRESHOLD, 255, cv2.THRESH_BINARY_INV,
    )
    return thresh


def _scan_zone(sct, monitor, pytesseract, cv2, np,
               *, label: str = "") -> Tuple[Optional[str], Optional[str]]:
    """OCR a single zone. Returns (validated_mmr, raw_ocr_text).

    `validated_mmr` is non-None only when the OCR text is digit-only and
    falls inside the MMR_VALID_MIN..MMR_VALID_MAX range. `raw_ocr_text`
    is the un-validated OCR result so callers can log WHY a zone failed.

    Example:
        >>> # Real OCR is hit during runtime; this helper is exercised
        >>> # by the main loop. (No pure-python doctest possible.)
    """
    img = np.array(sct.grab(monitor))
    thresh = _preprocess(img, cv2)
    if DEBUG:
        ts = int(time.time() * 1000)
        cv2.imwrite(
            os.path.join(_PROJECT_ROOT, f"mmr_debug_{label}_{ts}.png"),
            thresh,
        )
    raw = pytesseract.image_to_string(
        thresh, config=OCR_TESSERACT_CONFIG,
    ).strip()
    if raw.isdigit() and MMR_VALID_MIN <= int(raw) <= MMR_VALID_MAX:
        return raw, raw
    return None, raw or None


# =========================================================
# Atomic write
# =========================================================
def _atomic_write(path: str, payload: str) -> None:
    """Write `payload` to `path` via tmp + fsync + rename so the Node
    watcher never sees a torn file mid-write.

    Example:
        >>> # _atomic_write('/tmp/x', '4075,3950')   # doctest: +SKIP
    """
    parent = os.path.dirname(path) or "."
    try:
        os.makedirs(parent, exist_ok=True)
    except (OSError, ValueError):
        pass
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(payload)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# =========================================================
# Patience loop -- gather both zones before committing
# =========================================================
def _scan_both_zones(sct, pytesseract, cv2, np):
    """One pass over both zones. Returns (left_mmr, right_mmr,
    left_raw, right_raw). Each *_mmr is None unless it passed validation.
    """
    left_mmr, left_raw = _scan_zone(
        sct, ZONE_LEFT, pytesseract, cv2, np, label="left",
    )
    right_mmr, right_raw = _scan_zone(
        sct, ZONE_RIGHT, pytesseract, cv2, np, label="right",
    )
    return left_mmr, right_mmr, left_raw, right_raw


def _gather_both(sct, pytesseract, cv2, np, initial):
    """Given an initial (left, right, lraw, rraw) where AT LEAST ONE side
    is valid, keep re-scanning the missing side(s) for up to
    DUAL_ZONE_PATIENCE_SECONDS before returning whatever we got.
    """
    left, right, lraw, rraw = initial
    deadline = time.monotonic() + DUAL_ZONE_PATIENCE_SECONDS
    while time.monotonic() < deadline and not (left and right):
        time.sleep(SCAN_INTERVAL_SECONDS)
        if not left:
            left, lraw = _scan_zone(
                sct, ZONE_LEFT, pytesseract, cv2, np, label="left",
            )
        if not right:
            right, rraw = _scan_zone(
                sct, ZONE_RIGHT, pytesseract, cv2, np, label="right",
            )
    return left, right, lraw, rraw


def _format_zone(mmr: Optional[str], raw: Optional[str]) -> str:
    """Render a single zone's status for the console."""
    if mmr is not None:
        return mmr
    if raw is not None:
        return f"INVALID({raw!r})"
    return "—"


# =========================================================
# Main loop -- split into init / loop / entrypoint so each
# stays under the 30-line target and complexity 10 cap.
# =========================================================
SCAN_ERROR_BACKOFF_SECONDS = 2


def _init_runtime():
    """Import OCR deps and locate Tesseract.

    Returns (cv2, mss, np, pytesseract) on success or None on failure
    (printing a remediation message). Lazy-imports keep the rest of the
    merged toolkit from paying the opencv/mss/pytesseract import tax
    unless this watcher actually runs.

    Example:
        >>> result = _init_runtime()  # doctest: +SKIP
        >>> # On a CI machine with no Tesseract, returns None.
    """
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
        return None

    tesseract_path = find_tesseract()
    if not tesseract_path:
        print("=" * 60)
        print("ERROR: Tesseract OCR engine not found!")
        print("")
        print("Install from:  https://github.com/UB-Mannheim/tesseract/wiki")
        print("Make sure 'Add Tesseract to system PATH' is checked.")
        print("=" * 60)
        return None

    pytesseract.pytesseract.tesseract_cmd = tesseract_path
    print(f"[MMR] Tesseract found at: {tesseract_path}")
    print(f"[MMR] Output file:        {SCANNED_MMR_TXT}")
    if DEBUG:
        bar = "*" * 60
        print(bar)
        print("[MMR] DEBUG MODE: ON")
        print(f"[MMR] Dumping zone crops to: {_PROJECT_ROOT}")
        print(f"[MMR] Look for: {os.path.join(_PROJECT_ROOT, 'mmr_debug_left_<ts>.png')}")
        print(f"[MMR]           {os.path.join(_PROJECT_ROOT, 'mmr_debug_right_<ts>.png')}")
        print(bar)
    else:
        print("[MMR] DEBUG MODE: off  (re-run with --debug to enable image dump)")
    print("[MMR] Dual-zone scanner running. Watching both sides...")
    return cv2, mss, np, pytesseract


def _scan_iteration(sct, pytesseract, cv2, np) -> None:
    """One outer-loop iteration: scan, gather, log, commit, cool down."""
    left, right, lraw, rraw = _scan_both_zones(sct, pytesseract, cv2, np)
    if not (left or right):
        time.sleep(SCAN_INTERVAL_SECONDS)
        return
    left, right, lraw, rraw = _gather_both(
        sct, pytesseract, cv2, np, (left, right, lraw, rraw),
    )
    found: List[str] = [m for m in (left, right) if m]
    print(
        f"[MMR] zone-left={_format_zone(left, lraw)} "
        f"zone-right={_format_zone(right, rraw)} "
        f"-> wrote {','.join(found) or '<none>'}"
    )
    if found:
        _atomic_write(SCANNED_MMR_TXT, ",".join(found))
    time.sleep(POST_HIT_COOLDOWN_SECONDS)


def _run_loop(sct, pytesseract, cv2, np) -> int:
    """Drive _scan_iteration forever, swallowing per-iteration errors so
    a transient OCR / capture glitch doesn't take the watcher down."""
    while True:
        try:
            _scan_iteration(sct, pytesseract, cv2, np)
        except KeyboardInterrupt:
            print("\n[MMR] Stopped.")
            return 0
        except Exception as exc:  # pragma: no cover - defensive
            print(f"[MMR] Scan error: {exc}")
            time.sleep(SCAN_ERROR_BACKOFF_SECONDS)


def main() -> int:
    """Entry point. See _init_runtime + _run_loop for the real work."""
    runtime = _init_runtime()
    if runtime is None:
        return 1
    cv2, mss, np, pytesseract = runtime
    with mss.mss() as sct:
        return _run_loop(sct, pytesseract, cv2, np)


if __name__ == "__main__":
    sys.exit(main())
