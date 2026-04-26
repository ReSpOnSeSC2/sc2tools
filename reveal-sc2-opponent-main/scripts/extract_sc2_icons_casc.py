"""
Extract SC2 icons from a modern CASC-format install.

The mpyq-based extractor only handles legacy MPQ archives. Battle.net
shipped SC2 over to CASC (Content Addressable Storage Container) in
2018, so any modern install needs a CASC-aware reader. This script
uses the `casclib` Python binding (a thin wrapper around Ladik's
CascLib C++ library, which is what CascView itself uses).

Setup:
    pip install casclib

Usage:
    # Index the whole storage and write data/sc2_casc_index.txt:
    python scripts/extract_sc2_icons_casc.py --scan

    # Extract every match into SC2-Overlay/icons/:
    python scripts/extract_sc2_icons_casc.py --extract

    # Override the install path:
    python scripts/extract_sc2_icons_casc.py --extract \\
        --sc2-dir "C:\\Program Files (x86)\\StarCraft II"

Behavior:
    * The wishlist regex patterns are imported from the MPQ extractor
      so the two scripts stay in lockstep.
    * If casclib can enumerate files, we walk the listfile and match.
    * If casclib's enumeration is empty (some CASC builds don't ship a
      listfile), we fall back to attempting the wishlist patterns as
      direct lookups -- worst case the script reports them as missing.
    * DDS bytes are decoded via Pillow's DDS plugin and written as
      RGBA PNGs into SC2-Overlay/icons/<subfolder>/<name>.png. If a
      particular DDS variant is unsupported, the raw .dds is dropped
      next to the target so you can convert it with another tool.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

THIS_FILE = Path(__file__).resolve()
PROJECT_ROOT = THIS_FILE.parent.parent
ICONS_ROOT = PROJECT_ROOT / "SC2-Overlay" / "icons"
DATA_DIR = PROJECT_ROOT / "data"
INDEX_FILE = DATA_DIR / "sc2_casc_index.txt"

# Pull the wishlist (and its compiled regex patterns) from the MPQ
# extractor module so we have one source of truth for what we want.
sys.path.insert(0, str(THIS_FILE.parent))
try:
    from extract_sc2_icons import WISHLIST, find_match  # noqa: E402
except ImportError as exc:
    print(f"[ERROR] Could not import wishlist from extract_sc2_icons.py: {exc}",
          file=sys.stderr)
    sys.exit(2)


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


def import_casclib():
    try:
        import casclib  # type: ignore
        return casclib
    except ImportError:
        print("[ERROR] casclib is not installed. Install it with:")
        print("            pip install casclib")
        print("        It wraps Ladik's CascLib C++ library and ships a Windows DLL.")
        sys.exit(2)


# ---------------------------------------------------------------------
# CASC enumeration
# ---------------------------------------------------------------------
def enumerate_storage(storage) -> List[str]:
    """
    Return every internal filename in the CASC storage we can see.
    casclib exposes this via storage.files(). Each entry has at
    least a `.filename` attribute.
    """
    names: List[str] = []
    try:
        for entry in storage.files():
            n = getattr(entry, "filename", None) or getattr(entry, "name", None)
            if not n:
                continue
            names.append(n)
    except Exception as exc:
        print(f"  [WARN] storage.files() iteration failed: {exc}")
    return names


def open_file_bytes(storage, internal_name: str) -> Optional[bytes]:
    """Read a single CASC entry by internal name into a bytes object."""
    try:
        with storage.open_file(internal_name) as fh:
            return fh.read()
    except Exception as exc:
        print(f"  [WARN] Could not read {internal_name}: {exc}")
        return None


# ---------------------------------------------------------------------
# DDS -> PNG (same as the MPQ extractor; isolated here so this script
# is runnable standalone without importing the other module's code path).
# ---------------------------------------------------------------------
def dds_to_png(dds_bytes: bytes, out_path: Path) -> bool:
    try:
        from PIL import Image
        from io import BytesIO
    except ImportError:
        print("[ERROR] Pillow is missing. Install via: pip install Pillow",
              file=sys.stderr)
        sys.exit(2)
    try:
        img = Image.open(BytesIO(dds_bytes)).convert("RGBA")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(out_path, "PNG")
        return True
    except Exception as exc:
        # Save raw DDS for manual conversion in another tool.
        raw_path = out_path.with_suffix(".dds")
        try:
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_bytes(dds_bytes)
            print(f"  [WARN] Pillow can't decode this DDS ({exc}); "
                  f"raw saved as {raw_path.name}.")
        except Exception:
            print(f"  [WARN] Pillow can't decode and raw save failed: {exc}")
        return False


# ---------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------
def run(scan_only: bool, sc2_dir_override: Optional[str], dry_run: bool) -> int:
    sc2 = find_sc2_install(sc2_dir_override)
    if not sc2:
        print("[ERROR] Could not locate StarCraft II install.")
        print("        Pass --sc2-dir <path> to point at it.")
        return 1
    print(f"[Find] SC2 install: {sc2}")

    casclib = import_casclib()

    # casclib.CASCStorage accepts the install root and resolves the
    # current "Versions/Base*****/" build automatically.
    try:
        storage = casclib.CASCStorage(str(sc2))
    except Exception as exc:
        print(f"[ERROR] casclib could not open the storage: {exc}")
        print("        If your install is fresh after a patch, the DB might")
        print("        still be settling; try again in a minute. Otherwise")
        print("        confirm you ran the SC2 launcher at least once on this")
        print("        machine so Battle.net wrote the .product.db file.")
        return 1

    try:
        names = enumerate_storage(storage)
        print(f"[Index] {len(names)} entries enumerated from CASC")

        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with INDEX_FILE.open("w", encoding="utf-8") as f:
            for n in names:
                f.write(n + "\n")
        print(f"[Index] Wrote {INDEX_FILE}")

        # Match against wishlist
        matches: Dict[str, str] = {}  # wishlist_key -> internal_name
        for n in names:
            key = find_match(n)
            if key and key not in matches:
                matches[key] = n

        # Fallback for storages without a listfile -- try direct opens
        # for each wishlist's most likely path.
        if not matches:
            print("[Match] No matches via enumeration; trying direct lookups...")
            for key, patterns in WISHLIST.items():
                for pat in patterns:
                    # Reverse-engineer a probable filename from the regex.
                    # Each pattern is anchored on a literal filename like
                    # "btn-unit-zerg-zergling.dds$" -- strip the regex chars.
                    src = pat.pattern.rstrip("$").replace(r"\.", ".")
                    # Try a couple of common Assets/Textures/ prefixes.
                    for prefix in ("Assets/Textures/", "assets/textures/"):
                        candidate = prefix + src
                        if open_file_bytes(storage, candidate) is not None:
                            matches[key] = candidate
                            break
                    if key in matches:
                        break

        print(f"[Match] Wishlist hits: {len(matches)} / {len(WISHLIST)}")
        missing = sorted(set(WISHLIST.keys()) - set(matches.keys()))
        if missing:
            print(f"[Match] {len(missing)} wishlist entries not found:")
            for k in missing[:20]:
                print(f"         - {k}")
            if len(missing) > 20:
                print(f"         ... and {len(missing) - 20} more")

        if scan_only:
            print("[Done] --scan only; no files extracted. "
                  "Re-run with --extract to write PNGs.")
            return 0

        extracted = 0
        failed = 0
        for key, internal in sorted(matches.items()):
            out = ICONS_ROOT / key
            if out.exists():
                print(f"  [skip] {key}  (already exists)")
                continue
            print(f"  [+]    {key}  <- {internal}")
            if dry_run:
                continue
            data = open_file_bytes(storage, internal)
            if data is None:
                failed += 1
                continue
            if dds_to_png(data, out):
                extracted += 1
            else:
                failed += 1

        print(f"[Done] Extracted {extracted}, failed {failed}, "
              f"missing {len(missing)} (out of {len(WISHLIST)} wishlist).")
    finally:
        try:
            storage.close()
        except Exception:
            pass

    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Extract SC2 icons from a CASC install.")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--scan",    action="store_true",
                   help="Index CASC and write data/sc2_casc_index.txt; do not extract.")
    g.add_argument("--extract", action="store_true",
                   help="Index and then extract matched icons to SC2-Overlay/icons/.")
    p.add_argument("--sc2-dir", default=None,
                   help="Override SC2 install path (default: auto-detect).")
    p.add_argument("--dry-run", action="store_true",
                   help="With --extract, show what would be extracted but write nothing.")
    args = p.parse_args()
    return run(scan_only=args.scan,
               sc2_dir_override=args.sc2_dir,
               dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
