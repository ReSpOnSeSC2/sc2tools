"""Campaign persistence tests use fixture checkpoints and never launch SC2."""

import copy
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace

import pytest
import torch

from pluto_sc2 import campaign
from pluto_sc2.contract import model_metadata
from pluto_sc2.fairplay import FairPlayController
from pluto_sc2.learning import Policy, PPOConfig, PPOTrainer, load_checkpoint, save_checkpoint
from pluto_sc2.schema import ACTION_NAMES, OBSERVATION_SIZE


@pytest.fixture(autouse=True)
def bounded_test_resources(monkeypatch):
    before = torch.get_num_threads()
    torch.set_num_threads(1)
    monkeypatch.setattr(campaign.shutil, "disk_usage", lambda _: SimpleNamespace(free=100 * 1024**3))
    yield
    torch.set_num_threads(before)


@pytest.fixture
def make_campaign(tmp_path):
    created = 0

    def create(*, base_games=0, **overrides):
        nonlocal created
        created += 1
        maps = []
        for index in range(2):
            path = tmp_path / f"map-{index}.SC2Map"
            path.write_bytes(b"Test-only map placeholder; never launch this")
            maps.append(str(path))
        config = campaign.CampaignConfig(maps=tuple(maps), training_games_per_cycle=3,
                                         evaluation_games_per_matchup=1, **overrides)
        source = tmp_path / f"initial-{created}.pt"
        policy = Policy(OBSERVATION_SIZE, len(ACTION_NAMES), 8)
        trainer = PPOTrainer(policy)
        save_checkpoint(source, policy, optimizer=trainer.optimizer if base_games else None,
                        config=PPOConfig() if base_games else None,
                        metadata=model_metadata(stage="reinforcement" if base_games else "imitation"),
                        counters={"games": base_games} if base_games else {})
        output = tmp_path / f"campaign-{created}"
        campaign.initialize(output, source, config)
        return output, config

    return create


def read_state(output):
    return json.loads((output / "state.json").read_text())


def argument(command, flag):
    return command[command.index(flag) + 1]


def commit_training(command, *, count_delta=1):
    loaded = load_checkpoint(argument(command, "--resume"))
    count = loaded["counters"].get("games", 0) if loaded["metadata"]["stage"] == "reinforcement" else 0
    policy = loaded["policy"]
    trainer = PPOTrainer(policy, loaded["config"] or PPOConfig(),
                         reference_policy=loaded["reference_policy"] or policy)
    destination = Path(argument(command, "--output")) / "latest.pt"
    save_checkpoint(destination, policy, optimizer=trainer.optimizer, config=trainer.config,
                    counters={"games": count + count_delta}, reference_policy=trainer.reference_policy,
                    metadata=model_metadata(stage="reinforcement", reference_enabled=True))
    return destination


class FakeChild:
    def __init__(self, outcomes=None):
        self.calls = []
        self.outcomes = outcomes or {}
        self.after = None

    def __call__(self, command, log_path, timeout):
        mode = "train" if "train" in command else "evaluate"
        race = argument(command, "--opponent-race")
        self.calls.append({"mode": mode, "race": race, "map": argument(command, "--map"),
                           "seed": int(argument(command, "--seed")), "command": command.copy(),
                           "log": log_path})
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(f"Fixture child {len(self.calls)}: {mode} {race}; no game executed\n")
        if mode == "train":
            commit_training(command)
        else:
            folder = Path(argument(command, "--output"))
            folder.mkdir(parents=True)
            result, capped = self.outcomes.get(race, ("Victory", False))
            controller = FairPlayController()
            common = {"opponent_race": race, "difficulty": argument(command, "--difficulty"),
                      "seed": int(argument(command, "--seed")), "action_selection": "sampled"}
            campaign.write_json(folder / "evaluation.json", {
                **common, "games": 1, "results": {result: 1},
                "checkpoint_sha256": campaign.digest(argument(command, "--checkpoint")),
                "map": argument(command, "--map"), "max_game_seconds": int(argument(command, "--max-game-seconds")),
                "step_mul": 8,
            })
            campaign.append_json(folder / "matches.jsonl", {
                **common, "results": [result], "time_limit_reached": capped, "opponent": "builtin",
            })
            campaign.write_json(folder / "audit-0000.json", {"summary": controller.summary(), "actions": controller.audit})
        if self.after:
            self.after(mode)


def pending_evaluation(make_campaign):
    output, config = make_campaign()
    child = FakeChild()
    campaign.run(output, max_new_games=3, execute=child)
    config, extra, state = campaign._read(output)
    checkpoint = campaign.reconcile(output, extra, state)
    return output, config, state, checkpoint


def partial_evaluation(make_campaign):
    output, config, state, checkpoint = pending_evaluation(make_campaign)
    child = FakeChild()
    child.after = lambda mode: (output / "STOP").write_text("fixture stop after one evaluation")
    assert campaign.evaluate_cycle(output, config, state, checkpoint, child) is None
    (output / "STOP").unlink()
    root = output / "evaluations" / "cycle-00000"
    assert len(json.loads((root / "results.json").read_text())) == 1
    return output, config, state, checkpoint, root


def test_balanced_round_robin_and_map_rotation_survive_restarts(make_campaign):
    output, config = make_campaign()
    child = FakeChild()
    first = campaign.run(output, max_new_games=2, execute=child)
    assert first["new_training_games"] == 2
    second = campaign.run(output, max_new_games=3, execute=child)
    training = [call for call in child.calls if call["mode"] == "train"]
    assert [call["race"] for call in training] == ["Terran", "Protoss", "Zerg", "Terran", "Protoss"]
    assert [call["map"] for call in training] == [config.maps[0]] * 3 + [config.maps[1]] * 2
    assert [second["matchups"][key]["training_games"] for key in campaign.MATCHUPS] == [2, 2, 1]
    assert second["completed_cycles"] == 1
    assert second["status"] == "batch_complete"
    assert load_checkpoint(output / "training" / "latest.pt")["counters"]["games"] == 5


def test_reinforcement_initial_counter_is_not_miscounted_as_campaign_games(make_campaign):
    output, _ = make_campaign(base_games=20)
    child = FakeChild()
    result = campaign.run(output, max_new_games=2, execute=child)
    assert result["new_training_games"] == 2
    assert [call["race"] for call in child.calls] == ["Terran", "Protoss"]
    assert load_checkpoint(output / "training" / "latest.pt")["counters"]["games"] == 22


def test_failed_child_after_commit_preserves_checkpoint_and_resumes_next_race(make_campaign):
    output, _ = make_campaign()
    child = FakeChild()

    def failed_after_commit(command, log_path, timeout):
        child(command, log_path, timeout)
        raise RuntimeError("Fixture committed update, then process cleanup failed")

    with pytest.raises(ValueError, match="committed a checkpoint"):
        campaign.run(output, max_new_games=1, execute=failed_after_commit)
    assert len(child.calls) == 1
    checkpoint = output / "training" / "latest.pt"
    committed_hash = campaign.digest(checkpoint)
    state = read_state(output)
    assert state["status"] == "failed" and state["new_training_games"] == 1
    assert load_checkpoint(checkpoint)["counters"]["games"] == 1
    assert campaign.status(output)["checkpoint_sha256"] == committed_hash
    resumed = FakeChild()
    final = campaign.run(output, max_new_games=2, execute=resumed)
    assert [call["race"] for call in resumed.calls] == ["Protoss", "Zerg"]
    assert final["new_training_games"] == 3
    assert all(final["matchups"][key]["training_games"] == 1 for key in campaign.MATCHUPS)
    assert "cleanup failed" in (output / "failures.jsonl").read_text()


def test_checkpoint_counter_ahead_of_state_is_reconciled_and_older_checkpoint_rejected(make_campaign):
    output, _ = make_campaign()
    config, extra, state = campaign._read(output)
    command = campaign.training_command(output, config, extra, state, output / "initial.pt")
    commit_training(command)
    child = FakeChild()
    result = campaign.run(output, max_new_games=1, execute=child)
    assert child.calls[0]["race"] == "Protoss"
    assert result["new_training_games"] == 2
    latest = output / "training" / "latest.pt"
    loaded = load_checkpoint(latest)
    save_checkpoint(latest, loaded["policy"], counters={"games": 1}, metadata=loaded["metadata"])
    with pytest.raises(ValueError, match="older than campaign state"):
        campaign.run(output, max_new_games=1, execute=child)
    assert len(child.calls) == 1


def test_completed_evaluation_entries_resume_without_repeating_games(make_campaign):
    output, config, state, checkpoint, root = partial_evaluation(make_campaign)
    first = json.loads((root / "results.json").read_text())[0]
    snapshot_hash = campaign.digest(root / "checkpoint.pt")
    child = FakeChild()
    results = campaign.evaluate_cycle(output, config, state, checkpoint, child)
    assert [call["race"] for call in child.calls] == ["Protoss", "Zerg"]
    assert results[0] == first
    assert campaign.digest(root / "checkpoint.pt") == snapshot_hash
    assert set(results[0]["artifact_sha256"]) == {"evaluation.json", "matches.jsonl", "audit-0000.json"}
    assert all(call["seed"] >= 1_000_000_000 for call in child.calls)


@pytest.mark.parametrize("tamper", ["snapshot", "training_checkpoint", "ledger_hash", "artifact", "audit", "path"])
def test_pending_evaluation_rejects_changed_checkpoint_ledger_or_evidence(make_campaign, tamper):
    output, config, state, checkpoint, root = partial_evaluation(make_campaign)
    ledger = json.loads((root / "results.json").read_text())
    first_folder = Path(ledger[0]["path"])
    if tamper in {"snapshot", "training_checkpoint"}:
        (root / "checkpoint.pt" if tamper == "snapshot" else checkpoint).write_bytes(b"changed checkpoint fixture")
    elif tamper == "ledger_hash":
        ledger[0]["checkpoint_sha256"] = "f" * 64
        campaign.write_json(root / "results.json", ledger)
    elif tamper == "artifact":
        path = first_folder / "evaluation.json"
        path.write_text(path.read_text() + "\n")  # Same JSON meaning, different committed evidence bytes.
    elif tamper == "audit":
        path = first_folder / "audit-0000.json"
        data = json.loads(path.read_text())
        data["summary"]["raw_unit_commands"] = 1
        campaign.write_json(path, data)
    else:
        ledger[0]["path"] = str(output.parent)
        campaign.write_json(root / "results.json", ledger)
    child = FakeChild()
    with pytest.raises(ValueError):
        campaign.evaluate_cycle(output, config, state, checkpoint, child)
    assert not child.calls


@pytest.mark.parametrize("corruption", ["second_match", "unknown_result", "string_time_limit", "wrong_seed", "wrong_map", "wrong_race", "wrong_count"])
def test_fresh_evaluation_result_is_validated_before_it_enters_ledger(make_campaign, corruption):
    output, config, state, checkpoint = pending_evaluation(make_campaign)
    child = FakeChild()

    def malformed(command, log_path, timeout):
        child(command, log_path, timeout)
        folder = Path(argument(command, "--output"))
        match_path, summary_path = folder / "matches.jsonl", folder / "evaluation.json"
        match, summary = json.loads(match_path.read_text()), json.loads(summary_path.read_text())
        if corruption == "second_match":
            campaign.append_json(match_path, match)
        elif corruption in {"unknown_result", "string_time_limit"}:
            if corruption == "unknown_result":
                match["results"] = ["Unknown"]
            else:
                match["time_limit_reached"] = "false"
            match_path.write_text(json.dumps(match) + "\n")
        else:
            key, value = {"wrong_seed": ("seed", 1), "wrong_map": ("map", "other.SC2Map"),
                          "wrong_race": ("opponent_race", "Zerg"), "wrong_count": ("games", 2)}[corruption]
            summary[key] = value
            campaign.write_json(summary_path, summary)

    with pytest.raises(ValueError):
        campaign.evaluate_cycle(output, config, state, checkpoint, malformed)
    assert not (output / "evaluations" / "cycle-00000" / "results.json").exists()


def evaluation_rows(outcomes):
    return [{"matchup": key, "result": result, "time_limit_reached": capped}
            for key, (result, capped) in zip(campaign.MATCHUPS, outcomes)]


def test_promotions_are_per_race_and_time_limit_victories_cannot_promote(make_campaign):
    output, _ = make_campaign()
    state = read_state(output)
    results = evaluation_rows([("Victory", False), ("Victory", True), ("Tie", True)])
    campaign.apply_evaluation(state, results, 1)
    assert state["matchups"]["PvT"]["promotion_streak"] == 1
    assert state["matchups"]["PvP"]["promotion_streak"] == 0
    campaign.apply_evaluation(state, results, 1)
    assert [state["matchups"][key]["difficulty_index"] for key in campaign.MATCHUPS] == [1, 0, 0]
    assert state["matchups"]["PvP"]["last_wins"] == 0
    assert state["matchups"]["PvZ"]["last_time_limits"] == 1
    assert all(state["matchups"][key]["measured_mmr"] is None for key in campaign.MATCHUPS)


@pytest.mark.parametrize("bad", ["missing", "duplicate_race", "result", "time_limit"])
def test_invalid_evaluation_cannot_partially_mutate_promotions(make_campaign, bad):
    output, _ = make_campaign()
    state = read_state(output)
    state["matchups"]["PvT"]["promotion_streak"] = 1
    before = copy.deepcopy(state)
    rows = evaluation_rows([("Victory", False)] * 3)
    if bad == "missing":
        rows.pop()
    elif bad == "duplicate_race":
        rows[-1]["matchup"] = "PvP"
    elif bad == "result":
        rows[-1]["result"] = "Unknown"
    else:
        rows[-1]["time_limit_reached"] = "false"
    with pytest.raises(ValueError):
        campaign.apply_evaluation(state, rows, 1)
    assert state == before


def test_stop_prevents_work_and_stops_after_committed_current_game(make_campaign):
    output, _ = make_campaign()
    child = FakeChild()
    (output / "STOP").write_text("fixture explicit stop")
    assert campaign.run(output, max_new_games=3, execute=child)["status"] == "stopped"
    assert not child.calls
    (output / "STOP").unlink()
    child.after = lambda _: (output / "STOP").write_text("fixture stop current game")
    stopped = campaign.run(output, max_new_games=3, execute=child)
    assert stopped["status"] == "stopped" and stopped["new_training_games"] == 1
    assert len(child.calls) == 1
    assert campaign.status(output)["stop_requested"]


def test_plateau_requires_explicit_acknowledgment_before_more_training(make_campaign):
    output, _ = make_campaign(review_after_stagnant_cycles=1)
    state = read_state(output)
    for entry in state["matchups"].values():
        entry["best_wins"] = 0
    campaign.write_json(output / "state.json", state)
    child = FakeChild({race: ("Defeat", False) for race in campaign.RACES})
    result = campaign.run(output, max_new_games=4, execute=child)
    assert result["status"] == "needs_review" and result["new_training_games"] == 3
    count = len(child.calls)
    with pytest.raises(ValueError, match="needs review"):
        campaign.run(output, max_new_games=1, execute=child)
    assert len(child.calls) == count
    result = campaign.run(output, max_new_games=1, acknowledge_review=True, execute=child)
    assert result["new_training_games"] == 4 and result["stagnant_cycles"] == 0
    assert "reason" not in result


def test_retry_exhaustion_retains_every_log_across_restart(make_campaign):
    output, _ = make_campaign()
    seen = []

    def failing(command, log_path, timeout):
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(f"Failure evidence {len(seen)}")
        seen.append(log_path)
        raise RuntimeError("Fixture child failed before checkpoint")

    original = campaign.digest(output / "initial.pt")
    for attempt in range(2):
        with pytest.raises(RuntimeError, match="before checkpoint"):
            campaign.run(output, max_new_games=1, execute=failing)
        assert read_state(output)["status"] == "failed"
        assert len(seen) == 3 * (attempt + 1)
    assert len(set(seen)) == 6
    assert [path.read_text() for path in seen] == [f"Failure evidence {index}" for index in range(6)]
    assert len((output / "failures.jsonl").read_text().splitlines()) == 6
    assert campaign.digest(output / "initial.pt") == original
    assert not (output / "training" / "latest.pt").exists()


def test_failed_evaluation_attempts_keep_partial_artifacts_and_retry_unique_folders(make_campaign):
    output, config, state, checkpoint = pending_evaluation(make_campaign)
    child = FakeChild()
    failed_folder = None

    def flaky(command, log_path, timeout):
        nonlocal failed_folder
        child(command, log_path, timeout)
        if failed_folder is None:
            failed_folder = Path(argument(command, "--output"))
            raise RuntimeError("Fixture error after evaluation files")

    results = campaign.evaluate_cycle(output, config, state, checkpoint, flaky)
    assert len(child.calls) == 4
    assert failed_folder.is_dir()
    assert failed_folder != Path(results[0]["path"])
    assert failed_folder.with_suffix(".log").is_file()
    assert child.calls[0]["seed"] == child.calls[1]["seed"]


def test_child_timeout_invokes_owned_tree_cleanup_and_never_overwrites_log(tmp_path, monkeypatch):
    cleanup = []
    child = SimpleNamespace(wait=lambda **_: (_ for _ in ()).throw(subprocess.TimeoutExpired("fixture", 12)))
    monkeypatch.setattr(campaign.subprocess, "Popen", lambda *args, **kwargs: child)
    monkeypatch.setattr(campaign, "_terminate_tree", lambda process: cleanup.append(process))
    log = tmp_path / "child.log"
    with pytest.raises(subprocess.TimeoutExpired):
        campaign.execute_child(["fixture-never-executed"], log, 12)
    assert cleanup == [child]
    log.write_text("preserved previous evidence")
    with pytest.raises(FileExistsError):
        campaign.execute_child(["fixture-never-executed"], log, 12)
    assert log.read_text() == "preserved previous evidence"


@pytest.mark.parametrize("limit", [0, -1, True, 1.5])
def test_programmatic_campaign_rejects_invalid_batch_limit(make_campaign, limit):
    output, _ = make_campaign()
    with pytest.raises(ValueError, match="max_new_games"):
        campaign.run(output, max_new_games=limit, execute=FakeChild())


def test_changed_initial_checkpoint_is_rejected_before_child_runs(make_campaign):
    output, _ = make_campaign()
    (output / "initial.pt").write_bytes(b"altered fixture")
    child = FakeChild()
    with pytest.raises(ValueError, match="initial checkpoint has changed"):
        campaign.run(output, max_new_games=1, execute=child)
    assert not child.calls
