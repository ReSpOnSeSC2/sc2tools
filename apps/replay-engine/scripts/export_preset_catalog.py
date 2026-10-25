"""Generate the admin/server preset catalog from the released Python sources.

Usage: python scripts/export_preset_catalog.py [--check]
No private build documents or fabricated steps/signature stubs are exported.
"""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.build_definitions import BUILD_DEFINITIONS, EIGHT_WORKER_BUILD_NAMES, PROXY_ELIGIBLE_BUILDINGS, PRESET_SURFACES
from core.preset_defaults import RELEASED_PRESET_CRITERIA
from core.strategy_detector_helpers import UNIT_TECH_PREREQUISITES

TARGET = ROOT.parent / "api/src/config/presetCatalog.json"
RACES = {"P": "Protoss", "T": "Terran", "Z": "Zerg"}


def export_catalog():
    sources = sorted({*ROOT.joinpath("core").glob("strategy_detector*.py"), ROOT / "core/preset_policy.py", ROOT / "core/preset_defaults.py", ROOT / "core/build_definitions.py", ROOT / "core/build_durations.py"})
    fingerprints = {str(path.relative_to(ROOT)).replace("\\", "/"): hashlib.sha256(path.read_text(encoding="utf-8").replace("\r\n", "\n").encode("utf-8")).hexdigest() for path in sources}
    release_hash = hashlib.sha256(json.dumps(fingerprints, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    definitions = []
    for name, description in sorted(BUILD_DEFINITIONS.items()):
        prefix = name.split(" - ", 1)[0]
        matchup = prefix if len(prefix) == 3 and prefix[1] == "v" else None
        race = RACES.get(prefix[0]) if matchup else prefix
        row = {"name": name, "race": race, "matchup": matchup, "description": description.strip(), "surfaces": PRESET_SURFACES[name], "implementation": "declarative" if name in RELEASED_PRESET_CRITERIA else "procedural"}
        if name in EIGHT_WORKER_BUILD_NAMES:
            row["eightWorkerName"] = EIGHT_WORKER_BUILD_NAMES[name]
        if name in RELEASED_PRESET_CRITERIA:
            row["releasedCriteria"] = RELEASED_PRESET_CRITERIA[name]
        definitions.append(row)
    return {"$comment": "Generated from released Python sources. Run python apps/replay-engine/scripts/export_preset_catalog.py; --check verifies drift.", "source": "apps/replay-engine/core", "releaseHash": release_hash, "schemaVersion": 1, "evaluatorVersion": 1, "unitTechPrerequisites": UNIT_TECH_PREREQUISITES, "proxyEligibleBuildings": sorted(PROXY_ELIGIBLE_BUILDINGS), "definitions": definitions}


def main():
    wire = json.dumps(export_catalog(), ensure_ascii=True, indent=2) + "\n"
    if sys.argv[1:] == ["--check"]:
        if TARGET.read_text(encoding="utf-8") != wire:
            raise SystemExit("presetCatalog.json is stale; run python apps/replay-engine/scripts/export_preset_catalog.py")
    elif not sys.argv[1:]:
        TARGET.write_text(wire, encoding="utf-8", newline="\n")
    else:
        raise SystemExit("usage: export_preset_catalog.py [--check]")

if __name__ == "__main__":
    main()
