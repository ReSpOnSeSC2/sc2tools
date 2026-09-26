"""Read-only verification of the package's controlled public source files."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


def controlled_path(root: Path, name: str) -> Path:
    if (not isinstance(name, str) or not name or "\\" in name or ":" in name
            or any(part in {"", ".", ".."} for part in name.split("/"))):
        raise ValueError("Invalid relative source path")
    target = root
    for part in name.split("/"):
        target = target / part
        if target.is_symlink() or (hasattr(target, "is_junction") and target.is_junction()):
            raise ValueError("Source path traverses a link: " + name)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("Source path escapes the package")
    return target


def verify(root: Path) -> dict:
    root = Path(root).resolve(strict=True)
    manifest_path = controlled_path(root, "SOURCE_MANIFEST.json")
    body = manifest_path.read_bytes()
    manifest = json.loads(body)
    entries = manifest.get("sha256")
    if manifest.get("schema") != 1 or not isinstance(entries, dict) or not entries:
        raise ValueError("Unsupported or empty source manifest")
    if "SOURCE_MANIFEST.json" in entries:
        raise ValueError("Manifest cannot hash itself")
    total = 0
    for name, expected in entries.items():
        if not isinstance(expected, str) or re.fullmatch(r"[a-f0-9]{64}", expected) is None:
            raise ValueError("Invalid source digest")
        target = controlled_path(root, name)
        if not target.is_file():
            raise ValueError("Missing controlled source: " + name)
        with target.open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != expected:
            raise ValueError("Controlled source hash mismatch: " + name)
        total += target.stat().st_size
    return {"status": "passed", "controlled_files": len(entries), "controlled_bytes": total,
            "manifest_sha256": hashlib.sha256(body).hexdigest(), "writes": 0,
            "scope": "Manifest-listed source bytes only; no private data, models, or runtime admission"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args(argv)
    try:
        result = verify(args.root)
    except (OSError, ValueError, TypeError) as exc:
        print(json.dumps({"status": "failed", "reason": str(exc)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
