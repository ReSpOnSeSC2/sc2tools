"""Initialize the optional learner's verified source manifest without ML imports."""
import hashlib
import json
from pathlib import Path
import shutil


def prepare(root):
    root = Path(root).resolve()
    source = root / "references/alphastar-upstream"
    manifest = root / "requirements/alphastar-upstream-source-manifest.json"
    for name, expected in json.loads(manifest.read_text()).items():
        path = (source / name).resolve()
        if not path.is_relative_to(source) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f"Official source differs: {name}")
    target = root / "runs/alphastar-foundation-v1/runtime-setup/upstream-source-manifest.json"
    if target.exists():
        if target.read_bytes() != manifest.read_bytes():
            raise ValueError("Preserving a different existing upstream manifest; inspect it first")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(manifest, target)
    print("Verified upstream source. Supply --upstream references/alphastar-upstream to learner commands.")


if __name__ == "__main__":
    prepare(Path(__file__).resolve().parents[1])
