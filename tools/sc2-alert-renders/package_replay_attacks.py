#!/usr/bin/env python3
"""Validate rendered Attack sheets and package the local web release assets.

Requires Pillow. The PNG source atlases stay in the staging directory; only
WebP sheets with lossless alpha and an auditable source ledger are published.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image


def validate_sheet(path: Path) -> dict:
    with Image.open(path) as source:
        image = source.convert("RGBA")
    if image.size != (2048, 2048):
        raise ValueError(f"{path}: expected eight 256px frames and eight facings")
    counts = []
    for facing in range(8):
        digests = []
        for frame in range(8):
            cell = image.crop((frame * 256, facing * 256, (frame + 1) * 256, (facing + 1) * 256))
            alpha = cell.getchannel("A")
            bounds = alpha.getbbox()
            if bounds is None:
                raise ValueError(f"{path}: transparent cell {facing}/{frame}")
            if bounds[0] == 0 or bounds[1] == 0 or bounds[2] == 256 or bounds[3] == 256:
                raise ValueError(f"{path}: clipped cell {facing}/{frame}")
            digests.append(hashlib.sha256(cell.tobytes()).hexdigest())
        counts.append(len(set(digests)))
    if max(counts) < 2:
        raise ValueError(f"{path}: all authored attack poses rendered identically")
    return {"image": image, "distinctFramesPerFacing": counts}


def package(staging: Path, destination: Path, ledger_path: Path, bundle: Path):
    report = json.loads((staging / "attack-bake-report.json").read_text(encoding="utf-8"))
    errors = [entry for entry in report if entry["status"] == "failed"]
    if errors:
        raise ValueError(f"Resolve failed bakes before publishing: {[entry['unit'] for entry in errors]}")
    def encode_clip(entry):
        name, race = entry["unit"], entry["race"]
        if "attack" not in entry["group"].lower().split():
            raise ValueError(f"{name}: source must be an authored Attack sequence")
        geometry = entry["anims"]["Attack"]
        colors = {}
        for color in ("red", "blue"):
            checked = validate_sheet(staging / race / f"{name}_{color}_Attack.png")
            relative = Path("units") / race / f"{name}_{color}_Attack.webp"
            output = destination / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary = output.with_suffix(".tmp.webp")
            checked["image"].save(temporary, "WEBP", quality=90, alpha_quality=100, method=4)
            temporary.replace(output)
            release = bundle / relative
            release.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(output, release)
            colors[color] = {"bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                             "distinctFramesPerFacing": checked["distinctFramesPerFacing"]}
        return name, {
            "race": race, "frameSize": 256, "facings": 8,
            "animation": {**geometry, "sheet": f"{name}_red_Attack.webp"},
            "sourceAnimation": {key: entry[key] for key in ("group", "action", "srcRange", "authoredRange", "srcFrames", "srcFps") if key in entry},
            "files": colors,
        }
    with ThreadPoolExecutor(max_workers=4) as pool:
        clips = dict(pool.map(encode_clip, [entry for entry in report if entry["status"] == "baked"]))
    ledger = {"schemaVersion": 1, "assetBase": "/replay-attacks", "clips": clips,
              "withoutAttackSequence": [e["unit"] for e in report if e["status"] == "no_attack_sequence"]}
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(ledger, indent=2) + "\n"
    ledger_path.write_text(serialized, encoding="utf-8")
    (bundle / "replay-attack-clips.json").write_text(serialized, encoding="utf-8")
    print(f"Validated {len(clips)} native Attack clips / {len(clips) * 2} sheets; published {destination}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staging", type=Path, default=Path("output/replay-attacks"))
    parser.add_argument("--destination", type=Path, default=Path("apps/web/public/replay-attacks"))
    parser.add_argument("--ledger", type=Path, default=Path("tools/sc2-alert-renders/replay-attack-clips.json"))
    parser.add_argument("--bundle", type=Path, default=Path("output/replay-attack-sprites"))
    options = parser.parse_args()
    package(options.staging, options.destination, options.ledger, options.bundle)


if __name__ == "__main__":
    main()
