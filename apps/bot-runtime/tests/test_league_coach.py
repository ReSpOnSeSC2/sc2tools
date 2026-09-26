"""Optional frozen-coach curriculum tests; no SC2 process is launched."""
from copy import deepcopy
import json

import pytest

from pluto_sc2 import league, league_coach
from test_coach_opening_io import multiple_library, sha
from test_league import FakeMatch, episode
import test_league as league_fixtures


@pytest.fixture(name="make_league")
def league_factory(tmp_path):
    return league_fixtures.make_league.__wrapped__(tmp_path)


def strategy(stance="defend"):
    return {"stance": stance, "scout": True, "worker_target": 44, "base_target": 2,
            "gas_workers_per_base": 6, "production_targets": {"GATEWAY": 4, "CYBERNETICSCORE": 1},
            "composition": {"ADEPT": 10, "SENTRY": 4}, "research": ["WARPGATERESEARCH"],
            "rationale": "Fixture bounded opening; later pressure requires own HUD army."}


def sources(tmp_path):
    opening = multiple_library(tmp_path)
    candidates = json.loads(opening.read_text())["protoss_candidates"]
    document = tmp_path / "review.md"
    document.write_text("Verified whole TRAIN replay review. No heldout examples.")
    plans = []
    for index, candidate in enumerate(candidates):
        plans.append({"id": f"plan-{index}", "replay_id": candidate["replay_id"],
                      "matchup": candidate["matchup"], "opening_horizon_seconds": 240,
                      "phases": [{"starts_at": 0, "min_attack_army_supply": 0, "strategy": strategy()},
                                 {"starts_at": 240, "min_attack_army_supply": 24,
                                  "strategy": strategy("pressure")}]})
    strategies = tmp_path / "strategies.json"
    strategies.write_text(json.dumps({"schema": 1, "source_documents": [{"path": str(document), "sha256": sha(document)}],
                                     "plans": plans}))
    config = tmp_path / "coach-opponent.json"
    config.write_text(json.dumps({"schema": 1, "enabled": True, "every_n_cycles": 2, "cycle_offset": 0,
        "opening_library": str(opening), "opening_library_sha256": sha(opening),
        "strategy_library": str(strategies), "strategy_library_sha256": sha(strategies), "speed": 50}))
    return config


def test_missing_disabled_and_neural_preserving_cadence(tmp_path):
    assert league_coach.configuration(tmp_path / "missing.json") is None
    config_path = sources(tmp_path)
    expected = {"Protoss": 1, "Terran": 1, "Zerg": 1}
    seen = {race: 0 for race in league.RACES}
    for game in range(10):
        learner, opponent = league.SCHEDULE[game % 5]
        selected = league_coach.select_opponent(tmp_path, {"games": game}, learner, opponent, game + 1, 5)
        if selected is not None:
            seen[learner] += 1
            assert opponent == "Protoss" and game < 5
            assert selected["plan"]["matchup"] == "Pv" + learner[0]
    assert seen == expected
    config_path.write_text('{"schema": 1, "enabled": false}')
    assert league_coach.configuration(config_path) is None
    assert league_coach.select_opponent(tmp_path, {"games": 1}, "Terran", "Protoss", 12, 5) is None


@pytest.mark.parametrize("changes", [{"every_n_cycles": 1}, {"cycle_offset": 2}, {"enabled": 1},
                                     {"speed": 1000}, {"opening_library": "relative.json"}])
def test_invalid_activation_rejected(tmp_path, changes):
    path = sources(tmp_path)
    data = json.loads(path.read_text())
    data.update(changes)
    path.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        league_coach.configuration(path)


@pytest.mark.parametrize("race", league.RACES)
def test_matchup_selected_from_coach_perspective_and_frozen(tmp_path, race):
    config = league_coach.configuration(sources(tmp_path))
    frozen = league_coach.freeze_opponent(config, race, 713)
    assert frozen == league_coach.freeze_opponent(config, race, 713)
    assert frozen["plan"]["matchup"] == "Pv" + race[0]
    assert frozen["opening"]["candidate"]["partition"] == "train"
    assert frozen["starting_workers"] == 8 and frozen["max_apm"] == 200
    assert frozen["camera_restricted"] and frozen["spatial_selection"] and frozen["obeys_fog"]
    assert not frozen["learned_policy"] and not frozen["external_model_api"] and not frozen["live_codex_decisions"]
    original = deepcopy(frozen)
    (tmp_path / "strategies.json").write_text("{}")
    assert frozen == original
    with pytest.raises(ValueError, match="source changed"):
        league_coach.freeze_opponent(config, race, 713)


@pytest.mark.parametrize("tamper", ["review.md", "source.SC2Replay", "response90-replay-split.json"])
def test_provenance_tampering_rejected(tmp_path, tamper):
    config = league_coach.configuration(sources(tmp_path))
    # Force the base fixture replay as the only selected PvT plan.
    document = json.loads((tmp_path / "strategies.json").read_text())
    document["plans"] = document["plans"][:1]
    (tmp_path / "strategies.json").write_text(json.dumps(document))
    config["strategy_library_sha256"] = sha(tmp_path / "strategies.json")
    (tmp_path / tamper).write_bytes(b"tampered")
    with pytest.raises(ValueError):
        league_coach.freeze_opponent(config, "Terran", 1)


def test_strategy_phases_gate_attack_and_renew_without_live_file(tmp_path):
    config = league_coach.configuration(sources(tmp_path))
    frozen = league_coach.freeze_opponent(config, "Terran", 4)
    permitted = {"army_supply": 6, "defense_alert": False}
    mailbox = league_coach.FrozenStrategyMailbox(tmp_path / "coach", "game-1", frozen["plan"], lambda: permitted)
    assert mailbox.poll(0, 0).stance == "defend"
    first = mailbox.poll(240, 1)
    assert first.stance == "defend" and mailbox.status["attack_gate"] == "insufficient_own_army"
    permitted["army_supply"] = 24
    second = mailbox.poll(241, 2)
    assert second.stance == "pressure" and second.revision > first.revision
    permitted["defense_alert"] = True
    assert mailbox.poll(242, 3).stance == "defend"
    assert mailbox.status["attack_gate"] == "current_defense_alert"
    permitted["defense_alert"] = False
    renewed = mailbox.poll(1600, 4)
    assert renewed.stance == "pressure" and renewed.issued_game_seconds == 1440
    assert renewed.valid_until_game_seconds == 2040 and renewed.based_on_report == 0
    assert mailbox.poll(1601, 5).revision == renewed.revision
    # No read of a mutable strategy.json is possible.
    (tmp_path / "coach" / "strategy.json").write_text("malicious unparsed junk")
    assert mailbox.poll(1602, 6).composition == renewed.composition
    records = list((tmp_path / "coach" / "frozen-strategy-orders").glob("*.json"))
    assert len(records) == mailbox.status["accepted_orders"] == 5


def test_only_learner_updates_coach_has_no_checkpoint_and_schedule_survives_restart(make_league, tmp_path):
    output, initial, _ = make_league()
    assets = tmp_path / "assets"
    assets.mkdir()
    config_path = sources(assets)
    (output / "coach-opponent.json").write_bytes(config_path.read_bytes())
    neural = FakeMatch()
    coach_calls = []

    def runner(policy, race, opponent, opponent_race, map_name, **options):
        frozen = options.get("coached_opponent")
        if frozen is None:
            return neural(policy, race, opponent, opponent_race, map_name, **options)
        assert opponent is None and opponent_race == "Protoss"
        coach_calls.append((race, deepcopy(frozen)))
        learner = episode(policy, race)
        # Opponent poison must never reach PPO; a coach has no learned policy.
        from types import SimpleNamespace
        from pluto_sc2.fairplay import FairPlayController
        coach = SimpleNamespace(policy=None, transitions=[object()], fairplay=FairPlayController())
        return [learner, coach], {"results": ["Victory", "Defeat"], "engine_results": ["Victory", "Defeat"]}

    first = league.train(output, ["fixture-map"], games=3, match_runner=runner)
    assert first["games"] == 3
    final = league.train(output, ["fixture-map"], games=7, match_runner=runner)
    assert [race for race, _ in coach_calls] == ["Terran", "Protoss", "Zerg"]
    assert len(neural.calls) == 7
    assert [final["snapshots"][race][-1]["updates"] for race in league.RACES] == [6, 2, 2]
    assert all(row["training_games"] == 2 for row in final["matchups"].values())
    for race in league.RACES:
        assert league.sha256(output / initial["snapshots"][race][0]["path"]) == initial["snapshots"][race][0]["sha256"]
    coached_records = [json.loads(path.read_text()) for path in (output / "matches").glob("*/match.json")]
    coached_records = [row for row in coached_records if row["opponent"].get("kind") == "frozen_coach"]
    assert len(coached_records) == 3
    for row in coached_records:
        assert row["rating_status"] == "unrated"
        assert row["opponent"]["coach_matchup"] in {"PvT", "PvP", "PvZ"}
        assert row["opponent"]["configuration_sha256"] == sha(config_path)
    for race, frozen in coach_calls:
        checkpoint = output / final["snapshots"][race][-1]["path"]
        ancestry = league._load(checkpoint, race)["metadata"]["training_ancestry"]
        assert frozen["plan"]["replay_id"] in ancestry["known_train_replay_ids"]
    assert league._state(output) == final


def test_constructed_coach_has_no_policy_optimizer_or_rollout_and_copies_provenance(tmp_path):
    frozen = league_coach.freeze_opponent(league_coach.configuration(sources(tmp_path)), "Zerg", 1)
    output = tmp_path / "coach"
    bot = league_coach.make_bot(frozen, output, "isolated-coach", 900)
    assert bot.policy is None and not bot.record and bot.transitions == []
    assert not hasattr(bot, "optimizer") and getattr(bot, "teacher", None) is None
    assert bot.speed == 50
    assert bot.control_summary["brain"] == league_coach.PROFILE
    assert not bot.control_summary["live_codex_decisions"]
    assert bot.opening.replay_id == frozen["plan"]["replay_id"]
    assert json.loads((output / "opponent.json").read_text()) == frozen
    assert (output / "source-documents" / "00-review.md").read_bytes() == (tmp_path / "review.md").read_bytes()
    with pytest.raises(ValueError, match="must be new"):
        league_coach.make_bot(frozen, output, "isolated-coach", 900)


def test_play_match_rejects_mixed_coach_and_builtin_or_neural():
    with pytest.raises(ValueError, match="Coached opponent requires"):
        league.play_match(None, "Terran", object(), "Protoss", "fixture", coached_opponent={"schema": 1})
    with pytest.raises(ValueError, match="Coached opponent requires"):
        league.play_match(None, "Protoss", None, "Protoss", "fixture", coached_opponent={"schema": 1},
                          replay_path="fixture.SC2Replay", builtin_difficulty="VeryEasy")
