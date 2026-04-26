"""
Take a folder of DDS files extracted via CascView and turn them into
the PNG layout the overlay's icon registry expects.

Workflow:
  1. Run CascView (https://www.zezula.net/en/casc/main.html) and open
     your StarCraft II install directory.
  2. In the left tree, expand the CASC storage and navigate to
     Assets/Textures/. (If you can't find it, use CascView's search
     and filter by "btn-".)
  3. Select every file matching:
        btn-unit-*.dds
        btn-building-*.dds
        btn-upgrade-*.dds
        league-*.dds  / btn-race-*.dds  (if present)
     Right-click -> Extract -> choose any output folder, e.g.
     C:\\Temp\\sc2_icons_dump\\.
  4. Run this script pointing at that folder:
        python scripts/convert_extracted_icons.py --src C:\\Temp\\sc2_icons_dump

It walks the source folder for *.dds files, runs each filename through
the same regex wishlist the CASC/MPQ extractors use, decodes the DDS
with Pillow, and writes the matching PNG into
SC2-Overlay/icons/<subfolder>/<canonical-name>.png.

If a DDS variant is unsupported by Pillow (rare modern formats) the
raw DDS is saved next to the target so you can convert it manually
with another tool (GIMP, ImageMagick, IrfanView).

Idempotent: skips icons that already exist unless --force is passed.
"""

from __future__ import annotations

import argparse
import sys
from io import BytesIO
from pathlib import Path
from typing import Optional

THIS_FILE = Path(__file__).resolve()
PROJECT_ROOT = THIS_FILE.parent.parent
ICONS_ROOT = PROJECT_ROOT / "SC2-Overlay" / "icons"

# Reuse the wishlist + matcher from the MPQ extractor so all three
# scripts (mpq, casc, post-extract) share one source of truth.
sys.path.insert(0, str(THIS_FILE.parent))
try:
    from extract_sc2_icons import WISHLIST, find_match  # noqa: E402
except ImportError as exc:
    print(f"[ERROR] Could not import wishlist from extract_sc2_icons.py: {exc}",
          file=sys.stderr)
    sys.exit(2)


def import_pillow():
    try:
        from PIL import Image  # noqa: F401
        return True
    except ImportError:
        print("[ERROR] Pillow is missing. Install with: pip install Pillow",
              file=sys.stderr)
        return False


def dds_to_png(dds_path: Path, png_path: Path) -> bool:
    from PIL import Image
    try:
        with dds_path.open("rb") as f:
            data = f.read()
        img = Image.open(BytesIO(data)).convert("RGBA")
        png_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(png_path, "PNG")
        return True
    except Exception as exc:
        # Fall back: copy the raw DDS so it's not lost.
        raw_path = png_path.with_suffix(".dds")
        try:
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_bytes(dds_path.read_bytes())
            print(f"  [WARN] Pillow couldn't decode {dds_path.name} ({exc}); "
                  f"raw saved to {raw_path}.")
        except Exception as exc2:
            print(f"  [WARN] Conversion + raw save both failed for "
                  f"{dds_path.name}: {exc2}")
        return False


def run(src: Path, force: bool, dry_run: bool) -> int:
    if not src.exists() or not src.is_dir():
        print(f"[ERROR] --src directory does not exist: {src}")
        return 1
    if not import_pillow():
        return 2

    # Walk the source dir for DDS files.
    candidates = sorted(p for p in src.rglob("*.dds") if p.is_file())
    if not candidates:
        print(f"[ERROR] No .dds files found under {src}")
        return 1
    print(f"[Scan] {len(candidates)} DDS file(s) in {src}")

    matched = 0
    extracted = 0
    failed = 0
    skipped = 0
    unmatched = 0

    for dds in candidates:
        # find_match runs the wishlist's regex patterns against the
        # filename. We pass just the basename because the patterns
        # are anchored to a literal "<name>.dds$" tail.
        key = find_match(dds.name)
        if not key:
            unmatched += 1
            continue
        matched += 1
        out = ICONS_ROOT / key
        if out.exists() and not force:
            print(f"  [skip]  {key}  (already exists; pass --force to overwrite)")
            skipped += 1
            continue
        print(f"  [+]     {key}  <-  {dds.name}")
        if dry_run:
            continue
        if dds_to_png(dds, out):
            extracted += 1
        else:
            failed += 1

    print()
    print(f"[Done] DDS scanned:  {len(candidates)}")
    print(f"       Matched:      {matched}  (out of {len(WISHLIST)} wishlist)")
    print(f"       Converted:    {extracted}")
    print(f"       Failed:       {failed}")
    print(f"       Skipped:      {skipped}  (already existed)")
    print(f"       Unmatched:    {unmatched}  (filename not in wishlist regex)")

    if matched < len(WISHLIST):
        missing_keys = sorted(set(WISHLIST.keys()) -
                              {find_match(d.name) for d in candidates if find_match(d.name)})
        print()
        print(f"[Tip] {len(missing_keys)} wishlist entries weren't in your dump.")
        print("      Sample missing icons (re-extract these via CascView):")
        for k in missing_keys[:10]:
            print(f"        - {k}")
        if len(missing_keys) > 10:
            print(f"        ... and {len(missing_keys) - 10} more")

    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Convert + rename a CascView DDS dump.")
    p.add_argument("--src", required=True,
                   help="Folder where you extracted DDS files via CascView.")
    p.add_argument("--force", action="store_true",
                   help="Overwrite existing PNGs in SC2-Overlay/icons/.")
    p.add_argument("--dry-run", action="store_true",
                   help="Show what would happen, don't write files.")
    args = p.parse_args()
    return run(src=Path(args.src), force=args.force, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
