"""
Reconnaissance helper for the merged toolkit.

The extract script assumed pre-2018 SC2 layout where Mods/*.SC2Mod and
Mods/*.SC2Assets were MPQ archive files. Modern Battle.net installs
ship as folders with CASC-backed data. This recon script walks the
install once and tells you what's actually there:

  * count of files by extension
  * any MPQ-shaped archive files (legacy)
  * any loose .dds / .png / .tga textures we could use directly
  * total Mods/* folders + a per-folder file count
  * presence of CASC index (Data/data/*.idx)

It also writes the full file list to data/sc2_install_listing.txt so
we can do filename pattern-matching against the wishlist.

Usage:
    python scripts/recon_sc2_install.py
    python scripts/recon_sc2_install.py --sc2-dir "D:\\Games\\StarCraft II"
"""
from __future__ import annotations

import argparse
import os
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Optional

THIS_FILE = Path(__file__).resolve()
PROJECT_ROOT = THIS_FILE.parent.parent
DATA_DIR = PROJECT_ROOT / "data"
LISTING_FILE = DATA_DIR / "sc2_install_listing.txt"

COMMON_SC2_PATHS = [
    r"C:\Program Files (x86)\StarCraft II",
    r"C:\Program Files\StarCraft II",
    r"D:\Games\StarCraft II",
    r"D:\StarCraft II",
    "/Applications/StarCraft II",
]


def find_sc2_install(override: Optional[str] = None) -> Optional[Path]:
    if override:
        p = Path(override).expanduser()
        return p if p.exists() else None
    for c in COMMON_SC2_PATHS:
        if c and os.path.exists(c):
            return Path(c)
    return None


def main() -> int:
    p = argparse.ArgumentParser(description="Recon SC2 install layout.")
    p.add_argument("--sc2-dir", default=None,
                   help="Override SC2 install path (default: auto-detect).")
    args = p.parse_args()

    sc2 = find_sc2_install(args.sc2_dir)
    if not sc2:
        print("[ERROR] No SC2 install found. Pass --sc2-dir.")
        return 1
    print(f"[Find] SC2 install: {sc2}")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    ext_counts: Counter = Counter()
    total = 0
    by_top: dict = defaultdict(int)
    archive_files = []
    casc_indices = []
    loose_dds = []
    loose_png = []

    with LISTING_FILE.open("w", encoding="utf-8") as out:
        for p, dirs, files in os.walk(sc2):
            for fname in files:
                full = os.path.join(p, fname)
                rel = os.path.relpath(full, sc2)
                out.write(rel.replace("\\", "/") + "\n")

                total += 1
                low = fname.lower()
                ext = os.path.splitext(low)[1]
                ext_counts[ext] += 1

                # Top-level folder bucket (Versions/, Mods/, Data/, ...).
                top = rel.split(os.sep, 1)[0]
                by_top[top] += 1

                # Specific things we care about
                if low.endswith((".sc2mod", ".sc2assets", ".sc2data")):
                    archive_files.append(rel)
                if low.endswith(".idx") and "data" in rel.lower():
                    casc_indices.append(rel)
                if low.endswith(".dds"):
                    loose_dds.append(rel)
                if low.endswith(".png"):
                    loose_png.append(rel)

    print()
    print(f"[Listing] {total} total files across the install")
    print(f"[Listing] Wrote full listing to {LISTING_FILE}")

    print()
    print("[Top-level folders] file count")
    for k in sorted(by_top.keys()):
        print(f"  {k:<30} {by_top[k]:>8}")

    print()
    print("[Top extensions]")
    for ext, n in ext_counts.most_common(20):
        print(f"  {ext or '(no ext)':<10} {n:>8}")

    print()
    print(f"[MPQ archives] {len(archive_files)} found")
    for r in archive_files[:10]:
        print(f"  - {r}")
    if len(archive_files) > 10:
        print(f"  ... and {len(archive_files) - 10} more")

    print()
    print(f"[CASC indices] {len(casc_indices)} found "
          f"(if non-zero, this install uses CASC, not MPQ)")
    for r in casc_indices[:5]:
        print(f"  - {r}")

    print()
    print(f"[Loose .dds textures] {len(loose_dds)} found")
    for r in loose_dds[:10]:
        print(f"  - {r}")
    if len(loose_dds) > 10:
        print(f"  ... and {len(loose_dds) - 10} more")

    print()
    print(f"[Loose .png images] {len(loose_png)} found")
    for r in loose_png[:10]:
        print(f"  - {r}")
    if len(loose_png) > 10:
        print(f"  ... and {len(loose_png) - 10} more")

    print()
    print("=== Diagnosis ===")
    if archive_files:
        print(" * Legacy MPQ archives present -> extract_sc2_icons.py should work,")
        print("   but the script's archive-discovery treats .SC2Mod as a file.")
        print("   These are likely files of the same name; run --extract again.")
    elif casc_indices:
        print(" * Modern CASC layout. mpyq (MPQ) cannot read these.")
        print("   Use Ladik's CascView GUI tool to browse and extract DDS textures:")
        print("     https://www.zezula.net/en/casc/main.html")
        print("   Open the SC2 install dir, navigate to Assets/Textures/,")
        print("   extract the btn-unit-* / btn-building-* / btn-upgrade-* DDS files,")
        print("   then run scripts/convert_dds_to_png.py to batch-convert and rename.")
    if loose_dds:
        print(f" * {len(loose_dds)} loose DDS texture(s) found in the install --")
        print("   if any of these are unit/building icons, the convert script can")
        print("   pick them up directly without needing CASC extraction.")
    if loose_png:
        print(f" * {len(loose_png)} loose PNG(s) in the install -- these can be")
        print("   copied straight into SC2-Overlay/icons/.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
