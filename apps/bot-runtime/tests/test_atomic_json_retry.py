import json
from pathlib import Path

import pytest

from pluto_sc2 import runner


def test_transient_reader_lock_keeps_old_complete_json_until_atomic_retry(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    path.write_text('{"old":true}')
    original = Path.replace
    attempts = []

    def replace(source, target):
        attempts.append(source)
        assert json.loads(path.read_text()) == {"old": True}
        if len(attempts) < 3:
            raise PermissionError("Windows reader holds a share handle")
        return original(source, target)

    monkeypatch.setattr(Path, "replace", replace)
    monkeypatch.setattr(runner.time, "sleep", lambda _: None)
    runner.write_json(path, {"new": [1, 2]})
    assert len(attempts) == 3
    assert json.loads(path.read_text()) == {"new": [1, 2]}
    assert list(tmp_path.iterdir()) == [path]


def test_permanent_denial_is_bounded_and_preserves_authoritative_state(tmp_path, monkeypatch):
    path = tmp_path / "state.json"
    path.write_text('{"committed":80}')
    attempts = []

    def denied(source, target):
        attempts.append(source)
        raise PermissionError("Permanent denial")

    monkeypatch.setattr(Path, "replace", denied)
    monkeypatch.setattr(runner.time, "sleep", lambda _: None)
    with pytest.raises(PermissionError, match="Permanent"):
        runner.write_json(path, {"committed": 81})
    assert len(attempts) == 21
    assert json.loads(path.read_text()) == {"committed": 80}
    assert list(tmp_path.iterdir()) == [path]
