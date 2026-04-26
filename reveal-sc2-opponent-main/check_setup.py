"""
check_setup.py  —  SC2 Replay Analyzer environment diagnostic
Run this first to confirm everything is installed correctly before
running sc2_mmr_scanner.py or replay_watcher.py.
"""

import sys
import os
import shutil

print("=" * 55)
print("  SC2 Replay Analyzer — Environment Check")
print("=" * 55)

all_ok = True

# ── 1. Python version ───────────────────────────────────────
py = sys.version_info
ok = py >= (3, 8)
status = "OK" if ok else "FAIL"
print(f"\n[{status}] Python {py.major}.{py.minor}.{py.micro}  (need 3.8+)")
if not ok:
    all_ok = False
    print("      Download: https://www.python.org/downloads/")

# ── 2. Required Python packages ─────────────────────────────
packages = {
    "cv2":          "opencv-python",
    "numpy":        "numpy",
    "mss":          "mss",
    "pytesseract":  "pytesseract",
    "sc2reader":    "sc2reader",
    "watchdog":     "watchdog",
    "requests":     "requests",
}

print()
for module, pkg in packages.items():
    try:
        __import__(module)
        print(f"[OK  ] {module}")
    except ImportError:
        all_ok = False
        print(f"[FAIL] {module}  →  run:  pip install {pkg}")

# ── 3. Tesseract binary ─────────────────────────────────────
print()
username = os.environ.get("USERNAME", "")
candidates = [
    shutil.which("tesseract"),
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
    rf"C:\Users\{username}\AppData\Local\Tesseract-OCR\tesseract.exe",
    r"C:\tools\Tesseract-OCR\tesseract.exe",
    r"C:\ProgramData\chocolatey\bin\tesseract.exe",
]

tess_path = next((p for p in candidates if p and os.path.isfile(p)), None)
if tess_path:
    # Try calling it to get version
    import subprocess
    try:
        result = subprocess.run([tess_path, "--version"], capture_output=True, text=True, timeout=5)
        version_line = (result.stdout or result.stderr).splitlines()[0]
        print(f"[OK  ] Tesseract: {version_line}")
        print(f"       Path: {tess_path}")
    except Exception as e:
        print(f"[WARN] Tesseract found at {tess_path} but version check failed: {e}")
else:
    all_ok = False
    print("[FAIL] Tesseract binary not found!")
    print("       Download: https://github.com/UB-Mannheim/tesseract/wiki")
    print("       During install, check 'Add Tesseract to system PATH'")

# ── 4. Summary ──────────────────────────────────────────────
print()
print("=" * 55)
if all_ok:
    print("  All checks passed! You're good to go.")
else:
    print("  Fix the items marked [FAIL] above, then re-run this script.")
print("=" * 55)

input("\nPress Enter to close...")
