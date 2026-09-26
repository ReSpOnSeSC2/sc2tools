"""Source integrity checks stay independent of SC2 and all model runtimes."""
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "source_manifest_verifier", Path(__file__).resolve().parents[1] / "scripts/verify_source_manifest.py")
verifier = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verifier)


def manifest(folder, entries):
    (folder / "SOURCE_MANIFEST.json").write_text(json.dumps({"schema": 1, "sha256": entries}))


def test_verifies_bytes_without_writes_or_private_data_access(tmp_path):
    (tmp_path / "source.py").write_bytes(b"public source\n")
    manifest(tmp_path, {"source.py": hashlib.sha256(b"public source\n").hexdigest()})
    (tmp_path / "private-data.pt").write_bytes(b"unlisted local data")
    before = {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in tmp_path.iterdir()}
    result = verifier.verify(tmp_path)
    assert result["controlled_files"] == 1 and result["writes"] == 0
    assert before == {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in tmp_path.iterdir()}


def test_modified_and_missing_source_are_rejected(tmp_path):
    target = tmp_path / "source.py"
    target.write_bytes(b"original")
    manifest(tmp_path, {"source.py": hashlib.sha256(b"original").hexdigest()})
    target.write_bytes(b"changed")
    with pytest.raises(ValueError, match="hash mismatch"):
        verifier.verify(tmp_path)
    target.unlink()
    with pytest.raises(ValueError, match="Missing"):
        verifier.verify(tmp_path)


@pytest.mark.parametrize("name", ["../escape", "/absolute", "C:/absolute", "a\\b", "a//b", "a/./b", ""])
def test_unsafe_paths_are_rejected(tmp_path, name):
    manifest(tmp_path, {name: "a" * 64})
    with pytest.raises(ValueError, match="relative source path"):
        verifier.verify(tmp_path)


def test_manifest_cannot_self_attest_or_use_malformed_digest(tmp_path):
    manifest(tmp_path, {"SOURCE_MANIFEST.json": "a" * 64})
    with pytest.raises(ValueError, match="hash itself"):
        verifier.verify(tmp_path)
    manifest(tmp_path, {"source.py": "not-a-digest"})
    with pytest.raises(ValueError, match="digest"):
        verifier.verify(tmp_path)


def test_symlink_traversal_is_rejected_before_reading(tmp_path, monkeypatch):
    manifest(tmp_path, {"linked/source.py": "a" * 64})
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda path: path.name == "linked" or original(path))
    with pytest.raises(ValueError, match="traverses a link"):
        verifier.verify(tmp_path)


def test_cli_reports_failure_with_nonzero_exit(tmp_path, capsys):
    manifest(tmp_path, {"missing.py": "a" * 64})
    assert verifier.main(["--root", str(tmp_path)]) == 1
    assert json.loads(capsys.readouterr().out)["status"] == "failed"
