"""Native host guards and real paid-controller integration, without SC2/GPU."""
import asyncio
from copy import deepcopy
import json
from types import SimpleNamespace

import pytest
from s2clientprotocol import sc2api_pb2 as api

from pluto_sc2 import alphastar_live as live
from pluto_sc2 import alphastar_spool as spool
from pluto_sc2.policy_observation import LivePolicyObservation
from pluto_sc2.replays import ReplayError
from test_intent_runtime import advance, world
from test_policy_intents import SESSION, binding, convert, frame
from test_rich_replays import _observation, _unit


SHA = "a" * 64


def response(value):
    return {"checkpoint_sha256": SHA, "binding": binding(value),
            "intent": convert(value=value), "record": {"function_name": "Build_Pylon_pt"}, "sequence": 1}


def driver(client):
    return live.PredictionDriver(client, session_id=SESSION, checkpoint_sha256=SHA, emit=lambda *a, **k: None)


def test_actual_prediction_runs_one_paid_selection_and_command_without_second_inference():
    async def scenario():
        value = frame()
        bot = world(value)
        requests = []

        async def infer(observation):
            requests.append(deepcopy(observation))
            return response(observation)

        host = driver(SimpleNamespace(infer=infer))
        await host.step(bot, value)
        assert len(requests) == 1 and bot.fairplay.pending
        assert bot.fairplay.budget.total == 1 and host.executed_intents == 0
        advance(bot, value)
        await host.step(bot, value)
        assert len(requests) == 1 and host.executed_intents == 1
        assert bot.fairplay.budget.total == 2 and not bot.fairplay.pending
        action = bot.client.requests[-1].actions[0]
        assert action.HasField("action_feature_layer") and not action.HasField("action_raw")
        assert action.action_feature_layer.unit_command.ability_id == 881
        assert host.inference_wait_seconds >= 0

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["timeout", "advanced_loop", "bad_binding", "tampered_intent", "rejected"])
def test_failed_or_rejected_predictions_never_emit_fallback_inputs(failure):
    async def scenario():
        value = frame()
        bot = world(value)

        async def infer(observation):
            if failure == "timeout":
                raise TimeoutError("worker did not answer")
            result = response(observation)
            if failure == "advanced_loop":
                bot.state.game_loop += 8
            elif failure == "bad_binding":
                result["binding"]["session_id"] = "other-session"
            elif failure == "tampered_intent":
                result["intent"]["source_tags"] = [999]
            else:
                result["intent"] = {"admitted": False, "reasons": ["masked"]}
            return result

        host = driver(SimpleNamespace(infer=infer))
        if failure == "rejected":
            await host.step(bot, value)
            assert host.rejected_intents == 1
        else:
            with pytest.raises((TimeoutError, ValueError)):
                await host.step(bot, value)
        assert bot.client.requests == [] and bot.fairplay.budget.total == 0
        assert host.runtime is None

    asyncio.run(scenario())


@pytest.mark.parametrize("field,value", [("session_id", "wrong"), ("player_id", 1),
                                          ("game_loop", 0), ("frame_sha256", "b" * 64)])
def test_response_binding_is_exact(field, value):
    observation = frame()
    reply = response(observation)
    reply["binding"][field] = value
    with pytest.raises(ValueError, match="exact live"):
        live.validate_response(reply, observation, session_id=SESSION, checkpoint_sha256=SHA)


@pytest.mark.parametrize("payload", [{}, {"paused": False}, {"paused": "true"}, {"paused": 1}, [], None])
def test_capture_pause_requires_strict_true_and_never_discloses_state(tmp_path, payload):
    path = tmp_path / "agent.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    with pytest.raises(RuntimeError, match="SC2TOOLS") as error:
        live.require_capture_paused(path)
    assert str(path) not in str(error.value)


def test_capture_pause_accepts_only_pause_bit_and_fails_closed_on_missing_malformed(tmp_path):
    path = tmp_path / "agent.json"
    for value in (None, "broken secret-token-json"):
        if value is not None:
            path.write_text(value, encoding="utf-8")
        with pytest.raises(RuntimeError, match="could not be verified") as error:
            live.require_capture_paused(path)
        assert "secret-token" not in str(error.value)
    path.write_text(json.dumps({"paused": True, "device_token": "secret-token"}), encoding="utf-8")
    assert live.require_capture_paused(path) is None


def test_capture_pause_handles_legitimate_large_archive_and_detects_resume_immediately(tmp_path):
    path = tmp_path / "agent.json"
    state = {"paused": True, "historical_archive": "x" * (6 * 1024 * 1024)}
    path.write_text(json.dumps(state), encoding="utf-8")
    assert live.require_capture_paused(path) is None
    state["paused"] = False
    path.write_text(json.dumps(state), encoding="utf-8")
    with pytest.raises(RuntimeError, match="must remain paused"):
        live.require_capture_paused(path)


def test_catalog_patch_mismatch_fails_closed():
    live.require_catalog({"units": {"84": {"name": "Probe"}}}, {"units": {"84": {"name": "Probe"}}})
    with pytest.raises(ValueError, match="patch vocabulary"):
        live.require_catalog({"units": {"84": {"name": "Probe"}}}, {"units": {"84": {"name": "SCV"}}})


def test_native_reserved_catalog_slots_do_not_invalidate_named_observations():
    data = api.ResponseData()
    data.units.add(unit_id=0, name="", available=False)
    data.units.add(unit_id=905, name="", available=False)
    data.units.add(unit_id=59, name="Nexus", available=True)
    data.units.add(unit_id=84, name="Probe", available=True)
    data.units.add(unit_id=342, name="VespeneGeyser", available=False)
    complete_catalog = live.public_catalog(data)
    names = live.observation_unit_names(data)
    assert names == {59: "Nexus", 84: "Probe", 342: "VespeneGeyser"}
    assert complete_catalog == live.public_catalog(data) and "0" in complete_catalog["units"]
    builder = LivePolicyObservation(session_id=SESSION, player_id=1, map_size=[200, 200], unit_names=names)
    observation = _observation(loop=1)
    _unit(observation, tag=101, unit_type=84)
    assert builder.observe(observation)["entities"][0]["type_name"] == "Probe"
    observation.game_loop = 2
    observation.raw_data.units[0].unit_type = 905
    with pytest.raises(ReplayError, match="metadata"):
        builder.observe(observation)


@pytest.mark.parametrize("change", ["stale", "future", "missing", "nan", "warming", "wrong_worker", "not_warmed",
                                    "wrong_session", "wrong_checkpoint"])
def test_worker_must_be_fresh_ready_and_warmed(tmp_path, monkeypatch, change):
    session = {"session_id": SESSION, "checkpoint_sha256": SHA}
    status = {"worker_id": "worker-123", "status": "ready", "warmup_complete": True, "updated_unix": 100.0,
              **session}
    monkeypatch.setattr(spool, "validate_worker", lambda worker, session: {"worker_id": "worker-123"})
    monkeypatch.setattr(spool, "read_json", lambda path: status if path.name == "worker-status.json" else {})
    assert live.require_ready_worker(tmp_path, session, now=105)["worker_id"] == "worker-123"
    if change == "stale":
        status["updated_unix"] = 94
    elif change == "future":
        status["updated_unix"] = 109
    elif change == "missing":
        status.pop("updated_unix")
    elif change == "nan":
        status["updated_unix"] = float("nan")
    elif change == "warming":
        status["status"] = "initializing"
    elif change == "wrong_worker":
        status["worker_id"] = "other"
    elif change == "wrong_session":
        status["session_id"] = "other"
    elif change == "wrong_checkpoint":
        status["checkpoint_sha256"] = "b" * 64
    else:
        status["warmup_complete"] = False
    with pytest.raises(ValueError, match="warmup"):
        live.require_ready_worker(tmp_path, session, now=105)


def fixture_checkpoint(tmp_path, monkeypatch):
    source = tmp_path / "checkpoint"
    source.mkdir()
    weights = source / "checkpoint.msgpack"
    weights.write_bytes(b"test-only-immutable-weights")
    (source / "registry.json").write_text("[]", encoding="utf-8")
    catalog = tmp_path / "catalog.json"
    catalog.write_text('{"units": {}, "abilities": {}}', encoding="utf-8")
    result = {"status": "passed", "checkpoint_restore_verified": True, "learned_from_actual_replay": True,
              "checkpoint_sha256": live.digest(weights), "dataset_hashes": {"game_data": live.digest(catalog)},
              "tensor_config": {"max_entities": 512, "max_selected": 64},
              "capacity_adapter": "empty-affine-preserving-entity-pool128-v1", "matmul_precision": "highest",
              "optimizer_updates": 5065}
    (source / "result.json").write_text(json.dumps(result), encoding="utf-8")
    (source / "reproduction-recipe.json").write_text(json.dumps({"checkpoint_sha256": live.digest(weights),
        "result_sha256": live.digest(source / "result.json")}), encoding="utf-8")
    map_path = tmp_path / "test.SC2Map"
    map_path.write_bytes(b"native-map-fixture")
    monkeypatch.setattr(live, "resolve_map", lambda value: SimpleNamespace(path=map_path))
    monkeypatch.setattr(live, "stop_paths", lambda output, checkpoint: [tmp_path / "STOP", output / "STOP"])
    return source, catalog


def test_prepare_pins_inputs_without_launch_and_refuses_reuse(tmp_path, monkeypatch):
    source, catalog = fixture_checkpoint(tmp_path, monkeypatch)
    monkeypatch.setattr(live, "run_game", lambda *a, **k: pytest.fail("prepare launched a game"))
    output = tmp_path / "new-session"
    result = live.prepare(output, source, catalog, "test")
    assert result["checkpoint_updates"] == 5065 and result["difficulty"] == "Hard"
    assert result["opponent_race"] == "Terran" and result["speed"] == 1
    assert all(live.digest(path) == checksum for path, checksum in result["input_hashes"].items())
    session = spool.validate_session(spool.read_json(output / "session.json"))
    assert session["player_id"] == 1 and session["session_id"] == result["session_id"]
    assert not (output / "launch.json").exists()
    with pytest.raises(ValueError, match="new session"):
        live.prepare(output, source, catalog, "test")


def test_prepare_never_admits_changed_checkpoint_or_stop(tmp_path, monkeypatch):
    source, catalog = fixture_checkpoint(tmp_path, monkeypatch)
    output = tmp_path / "new-session"
    (source / "checkpoint.msgpack").write_bytes(b"changed")
    with pytest.raises(ValueError, match="immutable expanded"):
        live.prepare(output, source, catalog, "test")
    assert not output.exists()
    (tmp_path / "STOP").write_text("stop", encoding="utf-8")
    with pytest.raises(RuntimeError, match="STOP marker"):
        live.prepare(output, source, catalog, "test")
    assert (tmp_path / "STOP").read_text() == "stop" and not output.exists()


def test_any_existing_native_client_blocks_launch_without_termination(monkeypatch):
    process = SimpleNamespace(info={"name": "SC2_x64.exe"})
    monkeypatch.setattr(live.psutil, "process_iter", lambda attrs: [process])
    with pytest.raises(RuntimeError, match="client is active"):
        live.check_no_engine()
