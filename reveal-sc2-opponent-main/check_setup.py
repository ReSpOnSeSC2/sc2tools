"""
check_setup.py  —  SC2 Replay Analyzer environment diagnostic
Run this first to confirm everything is installed correctly before
running watchers/replay_watcher.py.
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
    "numpy":        "numpy",
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

# ── 3. Summary ──────────────────────────────────
print()
print("=" * 55)
if all_ok:
    print("  All checks passed! You're good to go.")
else:
    print("  Fix the items marked [FAIL] above, then re-run this script.")
print("=" * 55)

input("\nPress Enter to close...")
