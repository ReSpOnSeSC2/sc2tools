"""Read-only opening comparisons must distinguish orders from observed results."""
from copy import deepcopy
import hashlib
import json

import pytest

from scripts.compare_coach_openings import compare_openings, inspect_opening


def report(at, *, own=(), pause=False, core=False, history=(), workers=17):
    return {"game_id": "fixture", "time": at, "current_own": list(own),
            "own_memory": [{"type": "STALKER", "tag": 999, "current": False}],
            "opening_bases": [{"base_index": 0, "position": [50, 50]}],
            "hud": {"supply_workers": workers, "supply_used": workers, "supply_cap": 21,
                    "minerals": 200, "vespene": 100},
            "opening": {"decision": {"pause_probe_production": pause},
                        "core_foundation_observed": core, "history": list(history)},
            "action_costs": {"train_stalker": {"minerals": 125, "vespene": 50}}}


def unit(kind, tag, at, progress=1):
    return {"type": kind, "tag": tag, "position": [50, 50], "current": True,
            "first_seen_loop": int(at * 22.4), "is_ready": progress == 1, "build_progress": progress,
            "orders": []}


def fixture(path, commands=(), reports=None, *, difficulty="Hard", result="Defeat"):
    path.mkdir()
    session = {"game_id": "fixture", "profile": "session-coached-protoss-v1", "learned_policy": False,
               "status": "complete", "result": result, "game_seconds": 360,
               "map": "TestMap", "opponent_race": "Terran", "difficulty": difficulty, "seed": 1}
    actions, execution = [], []
    for at, name, accepted in commands:
        index = len(actions)
        actions.append({"time": at - .4, "kind": "selection", "result": [1]})
        actions.append({"time": at, "game_loop": round(at * 22.4), "kind": "command",
                        "selection_audit_index": index, "result": [1] if accepted else [2],
                        "source_tags": [1], "effective_target": [53, 50], "unit_target_tag": 1})
        execution.append({"game_seconds": at + .4, "action": name,
                          "command_result": "accepted" if accepted else "engine_rejected",
                          "selection_audit_index": index})
    (path / "session.json").write_text(json.dumps(session))
    (path / "audit.json").write_text(json.dumps({"actions": actions, "summary": {}}))
    (path / "execution.jsonl").write_text("".join(json.dumps(x) + "\n" for x in execution))
    reports = reports if reports is not None else [report(0, own=[unit("NEXUS", 1, 0)], workers=8), report(360)]
    (path / "reports.jsonl").write_text("".join(json.dumps(x) + "\n" for x in reports))
    return path


def test_native_command_time_is_not_later_confirmation_time(tmp_path):
    path = fixture(tmp_path / "run", [(10, "train_stalker", True), (11, "chrono_boost", False)])
    result = inspect_opening(path)
    command = result["first_stalker"]["accepted_command"]
    assert command["command_time"] == 10 and command["confirmation_record_time"] == 10.4
    assert result["first_two_chronos"] == []
    assert result["first_stalker"]["current_unit_observation"] is None


def test_accepted_build_input_does_not_invent_foundation_or_completion(tmp_path):
    path = fixture(tmp_path / "run", [(10, "build_cyberneticscore", True)], [
        report(0), report(20, own=[unit("CYBERNETICSCORE", 2, 15, .1)]), report(360)])
    result = inspect_opening(path)
    observed = result["observed_structures"][0]
    assert observed["first_current_report_time"] == 20
    assert observed["recorded_first_seen_time"] == pytest.approx(15)
    assert observed["observed_under_construction"] is True
    assert result["workers"]["core_foundation_record"] is None
    assert result["workers"]["first_confirmed_probe_after_core"] is None


def test_only_current_queue_and_unit_rows_supply_production_evidence(tmp_path):
    gateway = unit("GATEWAY", 2, 10)
    gateway["orders"] = [{"ability_id": 917, "progress": .15}]
    path = fixture(tmp_path / "run", [(10, "train_stalker", True)], [
        report(0), report(15, own=[gateway]), report(40, own=[unit("STALKER", 3, 38)])])
    result = inspect_opening(path)["first_stalker"]
    assert result["current_queue_observation"]["report_time"] == 15
    assert result["current_unit_observation"]["tag"] == 3  # Not remembered tag999.
    assert result["current_unit_observation"]["first_current_report_time"] == 40


def test_probe_resume_uses_observed_core_evidence_and_retains_sampled_cut(tmp_path):
    core = {"step": 4, "action": "build_cyberneticscore", "via": "observed_foundation",
            "observed_or_accepted_at": 25}
    path = fixture(tmp_path / "run", [(10, "train_probe", True), (22, "train_probe", True),
                   (26, "train_probe", True), (45, "train_probe", True)], [
        report(0, workers=8), report(20, pause=True), report(30, core=True, history=[core]),
        report(60, core=True, history=[core], workers=20)])
    result = inspect_opening(path)["workers"]
    assert result["first_pause_sample"]["report_time"] == 20
    assert result["first_confirmed_probe_after_core"]["command_time"] == 26
    assert result["maximum_post_core_probe_command_gap"]["gap_seconds"] == 19
    assert result["timeline"][-1]["supply_workers"] == 20


def test_discretionary_inputs_exclude_first_gateway_and_after_first_stalker(tmp_path):
    path = fixture(tmp_path / "run", [(5, "build_gateway", True), (10, "build_gateway", True),
        (12, "train_sentry", False), (14, "train_sentry", True), (20, "train_stalker", True),
        (21, "build_forge", True)])
    result = inspect_opening(path)
    assert result["optional_input_counts"] == {"build_gateway": 1, "train_sentry": 1}
    assert result["first_stalker"]["accepted_command"]["public_cost"] == {"minerals": 125, "vespene": 50}


def test_unmatched_and_duplicate_receipts_are_not_extra_confirmed_commands(tmp_path):
    path = fixture(tmp_path / "run", [(10, "train_stalker", True)])
    source = path / "execution.jsonl"
    row = json.loads(source.read_text())
    other = dict(row, selection_audit_index=999)
    source.write_text("\n".join(json.dumps(x) for x in [row, row, other]))
    result = inspect_opening(path)
    assert len(result["accepted_commands"]) == 1
    assert len(result["unresolved_accepted_receipts"]) == 1


def test_input_cap_counts_rejected_attempts_and_honors_horizon(tmp_path):
    path = fixture(tmp_path / "run", [(1 + n / 10, "train_probe", False) for n in range(110)])
    result = inspect_opening(path, seconds=12)
    assert result["input_cap"]["recorded_inputs"] == 220
    assert result["input_cap"]["within_200_inputs"] is False
    assert result["accepted_commands"] == []


def test_missing_input_timestamp_cannot_be_a_positive_cap_verdict(tmp_path):
    path = fixture(tmp_path / "run")
    (path / "audit.json").write_text(json.dumps({"actions": [{"kind": "camera"}], "summary": {}}))
    result = inspect_opening(path)
    assert result["input_cap"]["within_200_inputs"] is None
    assert result["input_cap"]["invalid_input_timestamps"] == 1


def test_comparison_records_conditions_and_preserves_all_input_bytes(tmp_path):
    left = fixture(tmp_path / "baseline", [(20, "train_stalker", True)])
    right = fixture(tmp_path / "candidate", [(10, "train_stalker", True)], difficulty="VeryHard")
    files = [x for root in (left, right) for x in root.iterdir()]
    before = {str(x): hashlib.sha256(x.read_bytes()).hexdigest() for x in files}
    result = compare_openings(left, right)
    assert result["timing_deltas"]["first_stalker_command"]["candidate_minus_baseline_seconds"] == -10
    assert result["condition_differences"] == {"difficulty": ["Hard", "VeryHard"]}
    assert result["timing_deltas"]["second_chrono"]["candidate"] is None
    assert before == {str(x): hashlib.sha256(x.read_bytes()).hexdigest() for x in files}


@pytest.mark.parametrize("change", ["wrong_id", "learned", "invalid_time"])
def test_incompatible_sources_fail_before_comparison(tmp_path, change):
    path = fixture(tmp_path / "run")
    if change == "learned":
        file = path / "session.json"
        row = json.loads(file.read_text())
        row["learned_policy"] = True
        file.write_text(json.dumps(row))
    else:
        row = deepcopy(report(0))
        row["game_id" if change == "wrong_id" else "time"] = "wrong" if change == "wrong_id" else None
        (path / "reports.jsonl").write_text(json.dumps(row) + "\n")
    with pytest.raises(ValueError):
        inspect_opening(path)
