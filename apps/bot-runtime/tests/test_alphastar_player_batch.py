"""CPU-only orchestration boundaries; no StarCraft process or model is loaded."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

PATH = Path(__file__).resolve().parents[1] / "scripts/capture_alphastar_player_batch.py"
SPEC = importlib.util.spec_from_file_location("player_batch", PATH)
batch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(batch)


def dump(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def test_duplicate_replay_across_partitions_rejected():
    with pytest.raises(ValueError, match="Duplicate"):
        batch.partition_map({"train_replay_ids": ["a"], "validation_replay_ids": [{"replay_id": "a"}]})


def test_nested_and_direct_splits_have_same_identity():
    direct = {"train_replay_ids": [{"replay_id": "a"}], "validation_replay_ids": ["b"]}
    assert batch.partition_map(direct) == batch.partition_map({"split": {"matchups": {"PvT": direct}}})


def test_changed_pinned_input_rejected(tmp_path):
    file = tmp_path / "replay"
    file.write_bytes(b"original")
    checksums = {str(file): batch.digest(file)}
    file.write_bytes(b"changed")
    with pytest.raises(ValueError, match="changed"):
        batch.unchanged(checksums)


def test_stop_and_absolute_deadline_have_no_side_effects(tmp_path):
    stop = tmp_path / "STOP"
    stop.write_text("user stop")
    with pytest.raises(InterruptedError):
        batch.check_stop_deadline([stop], 99, now=1)
    assert stop.read_text() == "user stop"
    with pytest.raises(TimeoutError):
        batch.check_stop_deadline([], 10, now=10)


def test_pid_reuse_is_never_an_owned_process(monkeypatch):
    monkeypatch.setattr(batch.psutil, "Process", lambda pid: SimpleNamespace(create_time=lambda: 21))
    with pytest.raises(RuntimeError, match="reused"):
        batch.verified_process(123, 20)


@pytest.mark.parametrize("state", [{"paused": False}, {"paused": 1}, {}, {"paused": "true"}])
def test_pause_must_be_explicit_true(tmp_path, monkeypatch, state):
    path = tmp_path / "agent.json"
    dump(path, state)
    monkeypatch.setattr(batch, "verified_process", lambda *_: object())
    with pytest.raises(RuntimeError, match="remain paused"):
        batch.require_paused_agent({"pid": 123, "process_created_at": 20, "state_path": str(path)})


def test_unknown_engine_is_not_adopted(monkeypatch):
    own = SimpleNamespace(pid=5, create_time=lambda: 50)
    unknown = SimpleNamespace(pid=6, create_time=lambda: 60)
    monkeypatch.setattr(batch, "verified_process", lambda *_: SimpleNamespace(children=lambda **_: [own]))
    monkeypatch.setattr(batch, "engines", lambda: [unknown])
    observed = set()
    with pytest.raises(RuntimeError, match="Unowned"):
        batch.owned_engines(1, 10, observed)
    assert observed == set()
    monkeypatch.setattr(batch, "engines", lambda: [own])
    assert batch.owned_engines(1, 10, observed) == {(5, 50)}


def test_existing_engine_prevents_subprocess(tmp_path, monkeypatch):
    monkeypatch.setattr(batch, "require_paused_agent", lambda _: None)
    monkeypatch.setattr(batch, "engines", lambda: [object()])
    monkeypatch.setattr(batch.subprocess, "Popen", lambda *_, **__: pytest.fail("must not spawn"))
    with pytest.raises(RuntimeError, match="already active"):
        batch.run_child(["python"], log=tmp_path / "log", agent={}, stops=[], deadline=float("inf"))
    assert not (tmp_path / "log").exists()


def test_expired_budget_prevents_subprocess(tmp_path, monkeypatch):
    monkeypatch.setattr(batch, "require_paused_agent", lambda _: None)
    monkeypatch.setattr(batch.subprocess, "Popen", lambda *_, **__: pytest.fail("must not spawn"))
    with pytest.raises(TimeoutError):
        batch.run_child(["python"], log=tmp_path / "log", agent={}, stops=[], deadline=0)


def test_running_child_keeps_original_deadline_and_stops_only_owned(tmp_path, monkeypatch):
    clock = [0.0]
    stopped = []
    process = SimpleNamespace(pid=10, create_time=lambda: 123, children=lambda **_: [],
                              terminate=lambda: stopped.append((10, 123)))
    child = SimpleNamespace(pid=10, poll=lambda: None)
    monkeypatch.setattr(batch.psutil, "Process", lambda pid: process)
    monkeypatch.setattr(batch, "engines", lambda: [])
    monkeypatch.setattr(batch, "require_paused_agent", lambda _: None)
    monkeypatch.setattr(batch.subprocess, "Popen", lambda *_, **__: child)
    monkeypatch.setattr(batch.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(batch.time, "sleep", lambda seconds: clock.__setitem__(0, clock[0] + seconds))
    directory = tmp_path / "capture"
    directory.mkdir()
    with pytest.raises(TimeoutError):
        batch.run_child(["python"], log=tmp_path / "log", agent={}, stops=[], deadline=.6,
                        capture_dir=directory)
    assert clock[0] == .6
    assert stopped == [(10, 123)]
    assert (directory / "STOP").is_file()


def test_cleanup_discovers_only_current_child_engines(monkeypatch):
    terminated = []
    engine = SimpleNamespace(pid=21, name=lambda: "SC2_x64.exe", create_time=lambda: 456,
                             terminate=lambda: terminated.append(21))
    unrelated_child = SimpleNamespace(pid=22, name=lambda: "not-sc2.exe")
    parent = SimpleNamespace(pid=10, create_time=lambda: 123,
        children=lambda **_: [engine, unrelated_child], terminate=lambda: terminated.append(10))
    monkeypatch.setattr(batch, "verified_process", lambda pid, created: {10: parent, 21: engine}[pid])
    owned = set()
    batch.stop_owned(parent, 123, owned)
    assert owned == {(21, 456)}
    assert terminated == [21, 10]


def capture(tmp_path):
    row = {"player_id": 2, "partition": "train", "replay_id": "original"}
    files = ["frames.jsonl.gz", "actions.jsonl.gz", "game-data.json", "game-info.json"]
    for name in files:
        (tmp_path / name).write_bytes(name.encode())
    meta = {**row, "replay": {"replay_id": "original"}, "status": "captured_full_replay", "full_replay": True,
        "engine_start_workers": 8, "original_replay_unchanged": True, "step_mul": 1,
        "rules": {"start_workers": 8, "max_apm": 200, "camera_restricted": True, "fog": True},
        "artifacts": {name: batch.digest(tmp_path / name) for name in files}}
    return row, meta


@pytest.mark.parametrize("fault", ["prefix", "player", "partition", "fog", "workers", "missing", "corrupt"])
def test_bad_capture_cannot_be_admitted(tmp_path, fault):
    row, meta = capture(tmp_path)
    if fault == "prefix":
        meta["full_replay"] = False
    elif fault == "player":
        meta["player_id"] = 1
    elif fault == "partition":
        meta["partition"] = "validation"
    elif fault == "fog":
        meta["rules"]["fog"] = False
    elif fault == "workers":
        meta["engine_start_workers"] = 12
    elif fault == "missing":
        meta["artifacts"].pop("game-info.json")
    else:
        (tmp_path / "frames.jsonl.gz").write_bytes(b"modified")
    dump(tmp_path / "capture.json", meta)
    with pytest.raises(ValueError):
        batch.capture_gate(tmp_path, row)


def test_complete_capture_is_proved_by_all_artifact_hashes(tmp_path):
    row, meta = capture(tmp_path)
    dump(tmp_path / "capture.json", meta)
    assert batch.capture_gate(tmp_path, row) == meta


def derivative(tmp_path):
    for name in ("samples.jsonl.gz", "action-admission.jsonl.gz"):
        (tmp_path / name).write_bytes(b"fixture")
    return {"status": "complete", "eligible_for_training": True, "source_artifacts_unchanged": True,
        "models_trained": False, "replay_partitions": {"heldout": "validation"},
        "counts": {"validation_samples": 3}, "samples_sha256": batch.digest(tmp_path / "samples.jsonl.gz"),
        "admission_sha256": batch.digest(tmp_path / "action-admission.jsonl.gz")}


@pytest.mark.parametrize("fault", ["mix", "wrong_identity", "missing", "trained", "corruption"])
def test_heldout_derivative_never_accepts_train_or_changed_rows(tmp_path, fault):
    meta = derivative(tmp_path)
    if fault == "mix":
        meta["counts"]["train_samples"] = 1
    elif fault == "wrong_identity":
        meta["replay_partitions"] = {"other": "validation"}
    elif fault == "missing":
        meta["counts"]["validation_samples"] = 0
    elif fault == "trained":
        meta["models_trained"] = True
    else:
        (tmp_path / "samples.jsonl.gz").write_bytes(b"corrupted")
    dump(tmp_path / "manifest.json", meta)
    with pytest.raises(ValueError):
        batch.derivative_gate(tmp_path, "validation", ["heldout"])


def test_separate_heldout_derivative_passes(tmp_path):
    meta = derivative(tmp_path)
    dump(tmp_path / "manifest.json", meta)
    assert batch.derivative_gate(tmp_path, "validation", ["heldout"]) == meta


@pytest.mark.parametrize("budget", [0, -1, 1501, float("inf"), float("nan")])
def test_bad_total_budget_rejected_before_any_io(tmp_path, budget):
    with pytest.raises(ValueError, match="Wall budget"):
        batch.run(tmp_path / "absent", "none", tmp_path / "output", wall_seconds=budget)
    assert not (tmp_path / "output").exists()


def test_plan_hash_pinned_before_launch(tmp_path):
    plan = tmp_path / "plan.json"
    dump(plan, {})
    with pytest.raises(ValueError, match="hash mismatch"):
        batch.run(plan, "0" * 64, tmp_path / "output")
    assert not (tmp_path / "output").exists()


def test_visible_native_collector_cannot_launch_even_with_valid_plan(tmp_path, monkeypatch):
    plan = tmp_path / "plan.json"
    dump(plan, {"schema": batch.SCHEMA, "candidates": [
        {"replay_id": rid, "partition": part, "matchup": mu} for rid, part, mu in batch.SELECTED]})
    monkeypatch.setattr(batch.subprocess, "Popen", lambda *_, **__: pytest.fail("must not spawn"))
    with pytest.raises(RuntimeError, match="no-foreground"):
        batch.run(plan, batch.digest(plan), tmp_path / "output")
    assert not (tmp_path / "output").exists()
