"""
Extract SC2 unit / building / upgrade / race / league icons from your
own StarCraft II install and drop them into SC2-Overlay/icons/ where
the merged toolkit's icon registry expects them.

Why a script and not just "find them in the install folder":
SC2 stores its UI textures inside MPQ-format archives ('.SC2Mod' /
'.SC2Assets'), not as loose files. The textures are DDS images, which
browsers can't display. This script:

  1. Auto-detects your SC2 install (or accepts --sc2-dir).
  2. Walks the install for .SC2Mod and .SC2Assets archive files.
  3. Uses mpyq (already a sc2reader dependency, so already installed)
     to list and read files inside those archives.
  4. Matches archive entries against a wishlist keyed to the icon
     registry filenames (zergling.png, spawningpool.png, etc.).
  5. Reads the DDS, converts to PNG with Pillow, writes to
     SC2-Overlay/icons/<subdir>/<name>.png.

Usage:

    # Scan only -- writes data/sc2_icon_index.txt for your review:
    python scripts/extract_sc2_icons.py --scan

    # Extract everything we can find (also runs scan first):
    python scripts/extract_sc2_icons.py --extract

    # Force a custom install path:
    python scripts/extract_sc2_icons.py --extract --sc2-dir "D:\\Games\\SC2"

    # Dry run -- show what WOULD be extracted, don't write any files:
    python scripts/extract_sc2_icons.py --extract --dry-run

Notes:
  - The script never writes anything outside your project's
    SC2-Overlay/icons/ tree and data/sc2_icon_index.txt.
  - SC2 archive layouts have shifted over patches; if a wishlist entry
    isn't found, the script logs a 'MISSING' line and moves on. You
    can always drop in a manually-sourced PNG with the right filename.
  - The DDS->PNG conversion uses Pillow's built-in DDS reader, which
    handles the DXT1/DXT3/DXT5 compressed formats SC2 uses for
    button icons.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

# ---------------------------------------------------------------------
# Project paths
# ---------------------------------------------------------------------
THIS_FILE = Path(__file__).resolve()
PROJECT_ROOT = THIS_FILE.parent.parent
ICONS_ROOT = PROJECT_ROOT / "SC2-Overlay" / "icons"
DATA_DIR = PROJECT_ROOT / "data"
INDEX_FILE = DATA_DIR / "sc2_icon_index.txt"

# ---------------------------------------------------------------------
# SC2 install discovery
# ---------------------------------------------------------------------
COMMON_SC2_PATHS = [
    r"C:\Program Files (x86)\StarCraft II",
    r"C:\Program Files\StarCraft II",
    r"D:\Games\StarCraft II",
    r"D:\StarCraft II",
    os.path.expandvars(r"%USERPROFILE%\StarCraft II"),
    os.path.expandvars(r"%USERPROFILE%\Documents\StarCraft II"),
    "/Applications/StarCraft II",
]


def find_sc2_install(override: Optional[str] = None) -> Optional[Path]:
    if override:
        p = Path(override).expanduser()
        return p if p.exists() else None
    for cand in COMMON_SC2_PATHS:
        if cand and os.path.exists(cand):
            return Path(cand)
    return None


def list_archives(sc2_dir: Path) -> List[Path]:
    """
    Return every .SC2Mod and .SC2Assets file under the install. Each
    of these is an MPQ-format archive that mpyq can open directly.
    """
    archives: List[Path] = []
    for ext in (".SC2Mod", ".SC2Assets", ".SC2Data"):
        for p in sc2_dir.rglob(f"*{ext}"):
            # Skip directory-style mods (they're folders ending in
            # .SC2Mod, not files); we only want the archive files.
            if p.is_file():
                archives.append(p)
    return archives


# ---------------------------------------------------------------------
# Wishlist keyed by output filename
# ---------------------------------------------------------------------
# Each value is a list of regex patterns matched against archive entry
# names (case-insensitive). The first match wins. SC2's button icons
# follow the pattern btn-{kind}-{race}-{name}.dds, but the script also
# accepts unprefixed names so different patch eras work.
def regex(*patterns: str) -> List[re.Pattern]:
    return [re.compile(p, re.IGNORECASE) for p in patterns]


WISHLIST: Dict[str, List[re.Pattern]] = {
    # ---- Races (small badges in glue/score UI) ----
    "races/zerg.png":    regex(r"btn-race-zerg\.dds$",    r"ui[-_]?race[-_]?zerg\.dds$",    r"score[-_]?race[-_]?zerg\.dds$"),
    "races/protoss.png": regex(r"btn-race-protoss\.dds$", r"ui[-_]?race[-_]?protoss\.dds$", r"score[-_]?race[-_]?protoss\.dds$"),
    "races/terran.png":  regex(r"btn-race-terran\.dds$",  r"ui[-_]?race[-_]?terran\.dds$",  r"score[-_]?race[-_]?terran\.dds$"),
    "races/random.png":  regex(r"btn-race-random\.dds$",  r"ui[-_]?race[-_]?random\.dds$",  r"score[-_]?race[-_]?random\.dds$"),

    # ---- League shields ----
    "leagues/bronze.png":      regex(r"league[-_]?bronze\.dds$",      r"badge[-_]?bronze\.dds$"),
    "leagues/silver.png":      regex(r"league[-_]?silver\.dds$",      r"badge[-_]?silver\.dds$"),
    "leagues/gold.png":        regex(r"league[-_]?gold\.dds$",        r"badge[-_]?gold\.dds$"),
    "leagues/platinum.png":    regex(r"league[-_]?platinum\.dds$",    r"badge[-_]?platinum\.dds$"),
    "leagues/diamond.png":     regex(r"league[-_]?diamond\.dds$",     r"badge[-_]?diamond\.dds$"),
    "leagues/master.png":      regex(r"league[-_]?master\.dds$",      r"badge[-_]?master\.dds$"),
    "leagues/grandmaster.png": regex(r"league[-_]?grandmaster\.dds$", r"badge[-_]?grandmaster\.dds$"),

    # ---- Zerg buildings ----
    "buildings/spawningpool.png":   regex(r"btn-building-zerg-spawningpool\.dds$"),
    "buildings/banelingnest.png":   regex(r"btn-building-zerg-banelingnest\.dds$"),
    "buildings/roachwarren.png":    regex(r"btn-building-zerg-roachwarren\.dds$"),
    "buildings/hydraliskden.png":   regex(r"btn-building-zerg-hydraliskden\.dds$"),
    "buildings/spire.png":          regex(r"btn-building-zerg-spire\.dds$"),
    "buildings/nydusnetwork.png":   regex(r"btn-building-zerg-nydusnetwork\.dds$", r"btn-building-zerg-nydus\.dds$"),
    "buildings/hatchery.png":       regex(r"btn-building-zerg-hatchery\.dds$"),
    "buildings/lair.png":           regex(r"btn-building-zerg-lair\.dds$"),
    "buildings/hive.png":           regex(r"btn-building-zerg-hive\.dds$"),
    "buildings/extractor.png":      regex(r"btn-building-zerg-extractor\.dds$"),

    # ---- Protoss buildings ----
    "buildings/gateway.png":          regex(r"btn-building-protoss-gateway\.dds$"),
    "buildings/warpgate.png":         regex(r"btn-building-protoss-warpgate\.dds$"),
    "buildings/photoncannon.png":    regex(r"btn-building-protoss-photoncannon\.dds$", r"btn-building-protoss-cannon\.dds$"),
    "buildings/forge.png":            regex(r"btn-building-protoss-forge\.dds$"),
    "buildings/twilightcouncil.png":  regex(r"btn-building-protoss-twilightcouncil\.dds$"),
    "buildings/roboticsfacility.png": regex(r"btn-building-protoss-roboticsfacility\.dds$"),
    "buildings/stargate.png":         regex(r"btn-building-protoss-stargate\.dds$"),
    "buildings/nexus.png":            regex(r"btn-building-protoss-nexus\.dds$"),
    "buildings/assimilator.png":      regex(r"btn-building-protoss-assimilator\.dds$"),
    "buildings/pylon.png":            regex(r"btn-building-protoss-pylon\.dds$"),

    # ---- Terran buildings ----
    "buildings/commandcenter.png":     regex(r"btn-building-terran-commandcenter\.dds$"),
    "buildings/orbitalcommand.png":    regex(r"btn-building-terran-orbitalcommand\.dds$"),
    "buildings/planetaryfortress.png": regex(r"btn-building-terran-planetaryfortress\.dds$"),
    "buildings/barracks.png":          regex(r"btn-building-terran-barracks\.dds$"),
    "buildings/factory.png":           regex(r"btn-building-terran-factory\.dds$"),
    "buildings/starport.png":          regex(r"btn-building-terran-starport\.dds$"),
    "buildings/armory.png":            regex(r"btn-building-terran-armory\.dds$"),
    "buildings/fusioncore.png":        regex(r"btn-building-terran-fusioncore\.dds$"),
    "buildings/missileturret.png":     regex(r"btn-building-terran-missileturret\.dds$", r"btn-building-terran-turret\.dds$"),
    "buildings/bunker.png":            regex(r"btn-building-terran-bunker\.dds$"),
    "buildings/refinery.png":          regex(r"btn-building-terran-refinery\.dds$"),

    # ---- Zerg units ----
    "units/zergling.png":   regex(r"btn-unit-zerg-zergling\.dds$"),
    "units/baneling.png":   regex(r"btn-unit-zerg-baneling\.dds$"),
    "units/queen.png":      regex(r"btn-unit-zerg-queen\.dds$"),
    "units/roach.png":      regex(r"btn-unit-zerg-roach\.dds$"),
    "units/ravager.png":    regex(r"btn-unit-zerg-ravager\.dds$"),
    "units/overseer.png":   regex(r"btn-unit-zerg-overseer\.dds$"),
    "units/hydralisk.png":  regex(r"btn-unit-zerg-hydralisk\.dds$"),
    "units/lurker.png":     regex(r"btn-unit-zerg-lurker\.dds$",     r"btn-unit-zerg-lurkermp\.dds$"),
    "units/mutalisk.png":   regex(r"btn-unit-zerg-mutalisk\.dds$"),
    "units/corruptor.png":  regex(r"btn-unit-zerg-corruptor\.dds$"),
    "units/broodlord.png":  regex(r"btn-unit-zerg-broodlord\.dds$"),
    "units/infestor.png":   regex(r"btn-unit-zerg-infestor\.dds$"),
    "units/swarmhost.png":  regex(r"btn-unit-zerg-swarmhost\.dds$",  r"btn-unit-zerg-swarmhostmp\.dds$"),
    "units/viper.png":      regex(r"btn-unit-zerg-viper\.dds$"),
    "units/ultralisk.png":  regex(r"btn-unit-zerg-ultralisk\.dds$"),

    # ---- Protoss units ----
    "units/zealot.png":      regex(r"btn-unit-protoss-zealot\.dds$"),
    "units/stalker.png":     regex(r"btn-unit-protoss-stalker\.dds$"),
    "units/sentry.png":      regex(r"btn-unit-protoss-sentry\.dds$"),
    "units/adept.png":       regex(r"btn-unit-protoss-adept\.dds$"),
    "units/hightemplar.png": regex(r"btn-unit-protoss-hightemplar\.dds$"),
    "units/darktemplar.png": regex(r"btn-unit-protoss-darktemplar\.dds$"),
    "units/archon.png":      regex(r"btn-unit-protoss-archon\.dds$"),
    "units/observer.png":    regex(r"btn-unit-protoss-observer\.dds$"),
    "units/immortal.png":    regex(r"btn-unit-protoss-immortal\.dds$"),
    "units/colossus.png":    regex(r"btn-unit-protoss-colossus\.dds$"),
    "units/disruptor.png":   regex(r"btn-unit-protoss-disruptor\.dds$"),
    "units/warpprism.png":   regex(r"btn-unit-protoss-warpprism\.dds$"),
    "units/phoenix.png":     regex(r"btn-unit-protoss-phoenix\.dds$"),
    "units/oracle.png":      regex(r"btn-unit-protoss-oracle\.dds$"),
    "units/voidray.png":     regex(r"btn-unit-protoss-voidray\.dds$"),
    "units/tempest.png":     regex(r"btn-unit-protoss-tempest\.dds$"),
    "units/carrier.png":     regex(r"btn-unit-protoss-carrier\.dds$"),
    "units/mothership.png":  regex(r"btn-unit-protoss-mothership\.dds$"),

    # ---- Terran units ----
    "units/marine.png":        regex(r"btn-unit-terran-marine\.dds$"),
    "units/marauder.png":      regex(r"btn-unit-terran-marauder\.dds$"),
    "units/reaper.png":        regex(r"btn-unit-terran-reaper\.dds$"),
    "units/ghost.png":         regex(r"btn-unit-terran-ghost\.dds$"),
    "units/hellion.png":       regex(r"btn-unit-terran-hellion\.dds$"),
    "units/hellbat.png":       regex(r"btn-unit-terran-hellbat\.dds$"),
    "units/widowmine.png":     regex(r"btn-unit-terran-widowmine\.dds$"),
    "units/siegetank.png":     regex(r"btn-unit-terran-siegetank\.dds$"),
    "units/cyclone.png":       regex(r"btn-unit-terran-cyclone\.dds$"),
    "units/thor.png":          regex(r"btn-unit-terran-thor\.dds$"),
    "units/viking.png":        regex(r"btn-unit-terran-viking\.dds$",       r"btn-unit-terran-vikingfighter\.dds$"),
    "units/medivac.png":       regex(r"btn-unit-terran-medivac\.dds$"),
    "units/liberator.png":     regex(r"btn-unit-terran-liberator\.dds$"),
    "units/banshee.png":       regex(r"btn-unit-terran-banshee\.dds$"),
    "units/raven.png":         regex(r"btn-unit-terran-raven\.dds$"),
    "units/battlecruiser.png": regex(r"btn-unit-terran-battlecruiser\.dds$"),

    # ---- Upgrades ----
    "upgrades/blink.png":         regex(r"btn-upgrade-protoss-blink\.dds$"),
    "upgrades/charge.png":        regex(r"btn-upgrade-protoss-charge\.dds$"),
    "upgrades/glaive.png":        regex(r"btn-upgrade-protoss-resonatingglaives\.dds$", r"btn-upgrade-protoss-glaive\.dds$"),
    "upgrades/speed.png":         regex(r"btn-upgrade-zerg-zerglingmovementspeed\.dds$", r"btn-upgrade-zerg-metabolicboost\.dds$"),
    "upgrades/cloak.png":         regex(r"btn-upgrade-terran-personalcloaking\.dds$",   r"btn-upgrade-terran-cloak\.dds$"),
    "upgrades/stim.png":          regex(r"btn-upgrade-terran-stimpack\.dds$"),
    "upgrades/concussive.png":    regex(r"btn-upgrade-terran-concussiveshells\.dds$"),
    "upgrades/combatshield.png":  regex(r"btn-upgrade-terran-combatshield\.dds$"),
}


# ---------------------------------------------------------------------
# Archive walking
# ---------------------------------------------------------------------
def list_archive_files(archive_path: Path) -> List[str]:
    """
    Return the list of internal filenames in an MPQ archive. Returns
    an empty list (and logs) on any failure -- a corrupt or version-
    mismatched archive shouldn't kill the scan.
    """
    try:
        import mpyq  # type: ignore
    except ImportError:
        print("[ERROR] mpyq is missing. Install via: pip install mpyq", file=sys.stderr)
        sys.exit(2)
    try:
        archive = mpyq.MPQArchive(str(archive_path))
        # mpyq's `files` is a list of bytes lines from the listfile.
        names = []
        for raw in archive.files or []:
            try:
                names.append(raw.decode("utf-8", errors="replace"))
            except Exception:
                continue
        return names
    except Exception as exc:
        print(f"  [WARN] Could not open {archive_path.name}: {exc}")
        return []


def read_archive_file(archive_path: Path, internal_name: str) -> Optional[bytes]:
    try:
        import mpyq  # type: ignore
        archive = mpyq.MPQArchive(str(archive_path))
        return archive.read_file(internal_name)
    except Exception as exc:
        print(f"  [WARN] Could not read {internal_name} from {archive_path.name}: {exc}")
        return None


# ---------------------------------------------------------------------
# DDS -> PNG
# ---------------------------------------------------------------------
def dds_to_png(dds_bytes: bytes, out_path: Path) -> bool:
    """
    Decode a DDS image with Pillow and write it as PNG. Returns False
    if Pillow can't decode this DDS variant (e.g. DXT10 BC7).
    """
    try:
        from PIL import Image
        from io import BytesIO
    except ImportError:
        print("[ERROR] Pillow is missing. Install via: pip install Pillow", file=sys.stderr)
        sys.exit(2)
    try:
        img = Image.open(BytesIO(dds_bytes))
        # Force RGBA so transparency in DXT5 is preserved.
        img = img.convert("RGBA")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        img.save(out_path, "PNG")
        return True
    except Exception as exc:
        # If Pillow's DDS plugin chokes (rare modern formats), drop
        # the raw DDS next to the target so the user can convert it
        # with another tool (GIMP, ImageMagick, IrfanView).
        raw_path = out_path.with_suffix(".dds")
        try:
            raw_path.parent.mkdir(parents=True, exist_ok=True)
            raw_path.write_bytes(dds_bytes)
            print(f"  [WARN] Pillow can't decode this DDS ({exc}); raw saved as {raw_path.name}.")
        except Exception:
            print(f"  [WARN] Pillow can't decode this DDS and raw save also failed: {exc}")
        return False


# ---------------------------------------------------------------------
# Index
# ---------------------------------------------------------------------
def write_index(rows: List[Tuple[str, str]]) -> None:
    """rows = list of (archive_path, internal_name)."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with INDEX_FILE.open("w", encoding="utf-8") as f:
        for arc, name in rows:
            f.write(f"{arc}\t{name}\n")
    print(f"[Index] Wrote {len(rows)} archive-entry pairs to {INDEX_FILE}")


def find_match(internal_name: str) -> Optional[str]:
    """Return the wishlist key whose patterns match this entry, or None."""
    for key, patterns in WISHLIST.items():
        for pat in patterns:
            if pat.search(internal_name):
                return key
    return None


# ---------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------
def run(scan_only: bool, sc2_dir_override: Optional[str], dry_run: bool) -> int:
    sc2 = find_sc2_install(sc2_dir_override)
    if not sc2:
        print("[ERROR] Could not locate StarCraft II install.")
        print("        Pass --sc2-dir <path> to point at it, e.g.")
        print(r"        --sc2-dir 'C:\Program Files (x86)\StarCraft II'")
        return 1
    print(f"[Find] SC2 install: {sc2}")

    archives = list_archives(sc2)
    print(f"[Find] {len(archives)} archive(s) found")
    if not archives:
        print("       Nothing to scan -- is this really a StarCraft II install?")
        return 1

    # Walk every archive and build the global index of image-like
    # entries. We index .dds, .png, .tga -- the registry only uses
    # the .dds matches but the index is useful for manual lookups.
    index_rows: List[Tuple[str, str]] = []
    matches: Dict[str, Tuple[Path, str]] = {}  # wishlist_key -> (archive, internal)
    for arc in archives:
        names = list_archive_files(arc)
        for n in names:
            low = n.lower()
            if not (low.endswith(".dds") or low.endswith(".png") or low.endswith(".tga")):
                continue
            index_rows.append((str(arc), n))
            key = find_match(n)
            if key and key not in matches:
                matches[key] = (arc, n)

    write_index(index_rows)
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
    for key, (arc, internal) in sorted(matches.items()):
        out = ICONS_ROOT / key
        if out.exists():
            print(f"  [skip] {key}  (already exists)")
            continue
        print(f"  [+]    {key}  <- {arc.name} :: {internal}")
        if dry_run:
            continue
        data = read_archive_file(arc, internal)
        if data is None:
            failed += 1
            continue
        if dds_to_png(data, out):
            extracted += 1
        else:
            failed += 1

    print(f"[Done] Extracted {extracted}, failed {failed}, "
          f"missing {len(missing)} (out of {len(WISHLIST)} wishlist).")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Extract SC2 icons from your install.")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--scan",    action="store_true",
                   help="Scan archives and write data/sc2_icon_index.txt; do not extract.")
    g.add_argument("--extract", action="store_true",
                   help="Scan and then extract matched icons to SC2-Overlay/icons/.")
    p.add_argument("--sc2-dir", default=None,
                   help="Override SC2 install path (default: auto-detect).")
    p.add_argument("--dry-run", action="store_true",
                   help="With --extract, show what would be extracted but write nothing.")
    args = p.parse_args()
    return run(scan_only=args.scan, sc2_dir_override=args.sc2_dir, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
