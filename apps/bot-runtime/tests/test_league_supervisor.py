"""Durable supervisor tests use real small PPO checkpoints and never launch SC2."""

import json
from types import SimpleNamespace

from filelock import FileLock, Timeout
import pytest

from pluto_sc2 import campaign, league, league_supervisor as supervisor
from pluto_sc2.learning import load_checkpoint
from test_campaign import FakeChild as EvaluationChild, argument
from test_league import FakeMatch, make_league as league_fixture, small_torch_pool  # noqa: F401

make_league = league_fixture


def read_state(output):
    return json.loads((output / "state.json").read_text())


@pytest.fixture
def make_supervisor(tmp_path, make_league, monkeypatch):
    monkeypatch.setattr(supervisor.shutil, "disk_usage", lambda _: SimpleNamespace(free=100 * 1024**3))
    created = 0

    def create(*, practice=False):
        nonlocal created
        created += 1
        league_path, state, _ = make_league(bootstrap_adversaries=True)
        if practice:
            state["builtin_practice"] = {race: "VeryEasy" for race in league.RACES}
            league.write_json(league_path / "state.json", state)
        map_path = tmp_path / f"map-{created}.SC2Map"
        map_path.write_bytes(b"Test placeholder; no game engine may read this")
        output = tmp_path / f"supervisor-{created}"
        supervisor.initialize(output, league_path, [map_path], games_per_cycle=15, eval_games=1, region="NA")
        return output, league_path

    return create


class Child:
    def __init__(self, outcomes=None):
        self.matches = FakeMatch()
        self.evaluations = EvaluationChild(outcomes)
        self.calls = []
        self.after = None

    def __call__(self, command, log, timeout):
        mode = "train" if "train" in command else "evaluate"
        self.calls.append({"mode": mode, "command": list(command), "log": log, "timeout": timeout})
        if mode == "train":
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("x") as stream:
                stream.write("Test child with real PPO, no SC2\n")
            maps = command[command.index("--maps") + 1:command.index("--games")]
            assert argument(command, "--games") == "1"
            league.train(argument(command, "--output"), maps, games=1, match_runner=self.matches)
        else:
            self.evaluations(command, log, timeout)
        if self.after:
            self.after(mode)


def make_review_due(output, league_path):
    # Advance actual immutable checkpoints, then make the next full cycle due.
    league.train(league_path, ["test-map"], games=15, match_runner=FakeMatch())
    assert read_state(output)["next_review_game"] == 15


def test_restart_resumes_next_committed_game_and_keeps_distinct_race_optimizers(make_supervisor):
    output, league_path = make_supervisor()
    child = Child()
    first = supervisor.run(output, max_new_games=2, execute=child)
    assert first["league_games"] == 2 and first["status"] == "batch_complete"
    second = supervisor.run(output, max_new_games=3, execute=child)
    assert second["league_games"] == 5 and second["completed_cycles"] == 0
    assert [(c["learner_race"], c["opponent_race"]) for c in child.matches.calls] == list(league.SCHEDULE)
    state = league._state(league_path)
    for race, updates in (("Protoss", 3), ("Terran", 1), ("Zerg", 1)):
        saved = load_checkpoint(league_path / state["snapshots"][race][-1]["path"])
        assert saved["counters"]["games"] == updates
        assert {int(v["step"]) for v in saved["optimizer_state"]["state"].values()} == {updates}
    assert state["measured_mmr"] is None and state["rating_status"] == "unrated"


def test_error_after_commit_never_replays_that_update(make_supervisor):
    output, league_path = make_supervisor()
    child = Child()

    def cleanup_failed(mode):
        if mode == "train":
            raise RuntimeError("Fixture child committed then cleanup failed")

    child.after = cleanup_failed
    result = supervisor.run(output, max_new_games=2, execute=child)
    assert result["league_games"] == 2 and len(child.calls) == 2
    assert [c["learner_race"] for c in child.matches.calls] == ["Protoss", "Terran"]
    assert len((output / "failures.jsonl").read_text().splitlines()) == 2
    assert league._state(league_path)["games"] == 2


def test_retry_exhaustion_preserves_all_logs_and_checkpoints_across_restart(make_supervisor):
    output, league_path = make_supervisor()
    initial = read_state(league_path)
    logs = []

    def failed(command, log, timeout):
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("x") as stream:
            stream.write(f"Failure {len(logs)}")
        logs.append(log)
        raise RuntimeError("Fixture engine startup failed")

    for run_index in range(2):
        with pytest.raises(RuntimeError, match="startup failed"):
            supervisor.run(output, max_new_games=1, execute=failed)
        assert read_state(output)["status"] == "failed"
        assert len(logs) == 3 * (run_index + 1)
        assert read_state(league_path) == initial
    assert len(set(logs)) == 6
    assert [log.read_text() for log in logs] == [f"Failure {i}" for i in range(6)]
    assert len((output / "failures.jsonl").read_text().splitlines()) == 6


@pytest.mark.parametrize("marker", ["supervisor", "league"])
def test_either_stop_marker_prevents_children_and_stops_after_committed_game(make_supervisor, marker):
    output, league_path = make_supervisor()
    stop = (output if marker == "supervisor" else league_path) / "STOP"
    stop.write_text("Test stop")
    child = Child()
    assert supervisor.run(output, max_new_games=2, execute=child)["status"] == "stopped"
    assert not child.calls
    stop.unlink()
    child.after = lambda _: stop.write_text("Stop after this completed game")
    state = supervisor.run(output, max_new_games=2, execute=child)
    assert state["status"] == "stopped" and state["league_games"] == 1
    assert len(child.calls) == 1


def test_completed_cycle_is_evaluated_before_exact_batch_limit(make_supervisor):
    output, league_path = make_supervisor()
    child = Child()
    result = supervisor.run(output, max_new_games=15, execute=child)
    assert result["status"] == "batch_complete" and result["league_games"] == 15
    assert result["completed_cycles"] == 1 and result["next_review_game"] == 30
    assert [c["mode"] for c in child.calls] == ["train"] * 15 + ["evaluate"] * 3
    assert [c["race"] for c in child.evaluations.calls] == list(campaign.RACES)
    assert all(entry["evaluation_games"] == 1 for entry in result["matchups"].values())
    assert all(entry["measured_mmr"] is None for entry in result["matchups"].values())
    assert league._state(league_path)["games"] == 15


@pytest.mark.parametrize("marker", ["supervisor", "league"])
def test_stop_between_evaluations_keeps_ledger_and_resumes_remaining_games(make_supervisor, marker):
    output, league_path = make_supervisor()
    make_review_due(output, league_path)
    child = Child()
    stop = (output if marker == "supervisor" else league_path) / "STOP"
    child.after = lambda mode: stop.write_text("Stop after first evaluation")
    state = supervisor.run(output, max_new_games=1, execute=child)
    assert state["status"] == "stopped" and state["completed_cycles"] == 0
    assert len(child.calls) == 1
    ledger = output / "evaluations" / "cycle-00000" / "results.json"
    first = json.loads(ledger.read_text())
    assert len(first) == 1
    stop.unlink()
    resumed = Child()
    state = supervisor.run(output, max_new_games=1, execute=resumed)
    assert [c["mode"] for c in resumed.calls] == ["evaluate", "evaluate", "train"]
    assert [c["race"] for c in resumed.evaluations.calls] == ["Protoss", "Zerg"]
    assert json.loads(ledger.read_text())[0] == first[0]
    assert state["completed_cycles"] == 1 and state["league_games"] == 16


def test_independent_curriculum_updates_only_enabled_practice_difficulties(make_supervisor):
    output, league_path = make_supervisor(practice=True)
    state = read_state(output)
    for entry in state["matchups"].values():
        entry["promotion_streak"] = 1
    supervisor.write_json(output / "state.json", state)
    make_review_due(output, league_path)
    child = Child({"Terran": ("Victory", False), "Protoss": ("Victory", True), "Zerg": ("Tie", True)})
    result = supervisor.run(output, max_new_games=1, execute=child)
    assert [result["matchups"][key]["difficulty_index"] for key in campaign.MATCHUPS] == [1, 0, 0]
    assert league._state(league_path)["builtin_practice"] == {"Terran": "Easy", "Protoss": "VeryEasy", "Zerg": "VeryEasy"}
    assert result["matchups"]["PvP"]["last_wins"] == 0
    assert result["matchups"]["PvZ"]["last_time_limits"] == 1
    assert all(entry["measured_mmr"] is None for entry in result["matchups"].values())


def test_disabled_practice_stays_disabled_after_evaluation(make_supervisor):
    output, league_path = make_supervisor()
    make_review_due(output, league_path)
    supervisor.run(output, max_new_games=1, execute=Child())
    assert league._state(league_path)["builtin_practice"] is None


def test_failed_curriculum_commit_resumes_completed_evaluations_without_losing_promotion(make_supervisor, monkeypatch):
    output, league_path = make_supervisor(practice=True)
    state = read_state(output)
    state["matchups"]["PvT"]["promotion_streak"] = 1
    supervisor.write_json(output / "state.json", state)
    make_review_due(output, league_path)
    original = supervisor.write_json

    def fail_league_commit(path, data):
        if path == league_path / "state.json":
            raise OSError("Fixture curriculum write failed")
        original(path, data)

    child = Child()
    with monkeypatch.context() as context:
        context.setattr(supervisor, "write_json", fail_league_commit)
        with pytest.raises(OSError, match="curriculum write failed"):
            supervisor.run(output, max_new_games=1, execute=child)
    assert len(child.calls) == 3
    failed = read_state(output)
    assert failed["completed_cycles"] == 0 and failed["next_review_game"] == 15
    assert failed["matchups"]["PvT"]["difficulty_index"] == 0
    assert league._state(league_path)["builtin_practice"]["Terran"] == "VeryEasy"
    resumed = Child()
    result = supervisor.run(output, max_new_games=1, execute=resumed)
    assert [call["mode"] for call in resumed.calls] == ["train"]
    assert result["completed_cycles"] == 1 and result["matchups"]["PvT"]["difficulty_index"] == 1
    assert "error" not in result
    assert league._state(league_path)["builtin_practice"]["Terran"] == "Easy"


def test_plateau_blocks_training_until_acknowledged(make_supervisor):
    output, league_path = make_supervisor()
    config = json.loads((output / "config.json").read_text())
    config["review_after_stagnant_cycles"] = 1
    supervisor.write_json(output / "config.json", config)
    state = read_state(output)
    for entry in state["matchups"].values():
        entry["best_wins"] = 0
    supervisor.write_json(output / "state.json", state)
    make_review_due(output, league_path)
    child = Child({race: ("Defeat", False) for race in campaign.RACES})
    state = supervisor.run(output, max_new_games=1, execute=child)
    assert state["status"] == "needs_review" and state["league_games"] == 15
    assert len(child.calls) == 3 and state["completed_cycles"] == 1
    with pytest.raises(ValueError, match="review reason"):
        supervisor.run(output, max_new_games=1, execute=child)
    assert len(child.calls) == 3
    state = supervisor.run(output, max_new_games=1, acknowledge_review=True, execute=child)
    assert state["league_games"] == 16 and state["stagnant_cycles"] == 0
    assert "reason" not in state


def test_low_disk_enters_review_before_any_child_even_when_acknowledged(make_supervisor, monkeypatch):
    output, _ = make_supervisor()
    monkeypatch.setattr(supervisor.shutil, "disk_usage", lambda _: SimpleNamespace(free=0))
    child = Child()
    for acknowledge in (False, True):
        state = supervisor.run(output, max_new_games=1, acknowledge_review=acknowledge, execute=child)
        assert state["status"] == "needs_review" and "disk" in state["reason"]
    assert not child.calls


def test_supervisor_lock_excludes_second_runner_and_evaluation_locks_league(make_supervisor):
    output, league_path = make_supervisor()
    with FileLock(str(output / ".supervisor.lock"), timeout=0):
        with pytest.raises(Timeout):
            supervisor.run(output, max_new_games=1, execute=Child())
    make_review_due(output, league_path)
    child = Child()
    locks_checked = []

    def locked_child(command, log, timeout):
        if "evaluate" in command:
            with pytest.raises(Timeout):
                with FileLock(str(league_path / ".league.lock"), timeout=0):
                    pytest.fail("Evaluation allowed a concurrent league writer")
            locks_checked.append(True)
        child(command, log, timeout)

    supervisor.run(output, max_new_games=1, execute=locked_child)
    assert len(locks_checked) == 3


def test_rollback_of_committed_league_manifest_fails_before_new_children(make_supervisor):
    output, league_path = make_supervisor()
    original = read_state(league_path)
    supervisor.run(output, max_new_games=1, execute=Child())
    league.write_json(league_path / "state.json", original)
    child = Child()
    with pytest.raises(ValueError, match="older|rollback"):
        supervisor.run(output, max_new_games=1, execute=child)
    assert not child.calls
    assert read_state(output)["league_games"] == 1


@pytest.mark.parametrize("delta", [0, 2])
def test_child_must_commit_exactly_one_game(make_supervisor, delta):
    output, league_path = make_supervisor()
    calls = []

    def bad_child(command, log, timeout):
        calls.append(command)
        if delta:
            league.train(league_path, ["test-map"], games=delta, match_runner=FakeMatch())

    with pytest.raises(ValueError, match="exactly one game"):
        supervisor.run(output, max_new_games=1, execute=bad_child)
    assert len(calls) == 1
    assert read_state(output)["status"] == "failed"


@pytest.mark.parametrize("limit", [0, -1, True, 1.5])
def test_invalid_batch_limits_fail_before_work(make_supervisor, limit):
    output, _ = make_supervisor()
    with pytest.raises(ValueError, match="Batch size"):
        supervisor.run(output, max_new_games=limit, execute=Child())


@pytest.mark.parametrize("practice", [False, True])
def test_optional_practice_is_only_main_protoss_in_odd_rounds(make_league, tmp_path, practice):
    _, _, sources = make_league(bootstrap_adversaries=True)
    output = tmp_path / "practice-league"
    league.initialize(output, sources["Protoss"], terran=sources["Terran"], zerg=sources["Zerg"],
                      hidden_dim=8, builtin_practice=practice)
    matches = FakeMatch()
    options_seen = []

    def match(learner, learner_race, opponent, opponent_race, map_name, **options):
        options_seen.append({"learner": learner_race, "opponent": opponent_race, **options})
        bots, record = matches(learner, learner_race, opponent, opponent_race, map_name, **options)
        # Built-in practice has only the main bot's rollout/audit; learned
        # opponents carry deliberately invalid transitions to catch merging.
        if options["builtin_difficulty"] is not None:
            bots = bots[:1]
        return bots, record

    state = league.train(output, ["test-map"], games=10, match_runner=match)
    expected = [None] * 5 + (["VeryEasy", None, "VeryEasy", "VeryEasy", None] if practice else [None] * 5)
    assert [item["builtin_difficulty"] for item in options_seen] == expected
    assert all(item["max_apm"] == 600 for item in options_seen)
    for race, updates in (("Protoss", 6), ("Terran", 2), ("Zerg", 2)):
        saved = load_checkpoint(output / state["snapshots"][race][-1]["path"])
        assert saved["counters"]["games"] == updates
        assert {int(v["step"]) for v in saved["optimizer_state"]["state"].values()} == {updates}
        assert saved["metadata"]["max_apm"] == (200 if race == "Protoss" else 600)
        if race != "Protoss":
            assert saved["metadata"]["camera_restricted"] is False
    assert state["rating_status"] == "unrated" and state["measured_mmr"] is None
