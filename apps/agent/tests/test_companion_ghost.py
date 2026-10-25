from __future__ import annotations

from copy import deepcopy
import hashlib
import math
import threading

import pytest

from sc2tools_agent.companion_ghost import (
    GhostClient, GhostError, GhostSession, MAX_GHOST_STEPS,
    normalize_ghost_state, normalize_target, replay_target,
)


def target():
    return {"v": 1, "name": "Blink expand", "sourceGameId": "replay-1", "steps": [
        {"t": 50, "name": "Gateway", "kind": "building", "supply": 16},
        {"t": 100, "name": "Stalker", "kind": "unit", "supply": 22, "completeTime": 130},
        {"t": 200, "name": "BlinkTech", "kind": "upgrade", "supply": None},
    ]}


def state():
    return normalize_ghost_state({"v": 1, "enabled": True, "slots": {"PvT": target()}})


def snapshot(*, key="live-1", clock=100, phase="match_in_progress", now=1000, **extra):
    return {"liveGame": {"gameKey": key, "phase": phase, "displayTime": clock,
                         "capturedAt": now, "user": {"race": "Protoss"},
                         "opponent": {"race": "Terran"}, **extra}}


def test_targets_use_server_start_times_without_rewinding_twice_or_losing_repeats():
    result = replay_target({"myRace": "Protoss", "opponent": {"race": "Terran"}}, {
        "my_build": "Blink expand", "events": [
            {"name": "Probe", "time": 12, "category": "unit"},
            {"name": "Stalker", "time": 100, "complete_time": 130, "category": "unit", "supply": 22},
            {"name": "Gateway", "time": 50, "category": "building"},
            {"name": "Stalker", "time": 120, "category": "unit"},
            {"name": "Bad", "time": math.inf},
        ],
    }, "my-replay")
    assert result["matchup"] == "PvT"
    steps = result["target"]["steps"]
    assert [(row["name"], row["t"]) for row in steps] == [("Gateway", 50), ("Stalker", 100), ("Stalker", 120)]
    assert steps[1] == {"name": "Stalker", "t": 100, "completeTime": 130, "kind": "unit", "timing": "started", "supply": 22}


def test_target_normalization_bounds_and_rejects_any_invalid_step():
    for invalid in (-1, True, math.nan, math.inf, 14401, 10 ** 500):
        value = target()
        value["steps"][0]["t"] = invalid
        assert normalize_target(value) is None
    value = target()
    value["steps"][0]["kind"] = {}
    assert normalize_target(value) is None
    value = target()
    value["steps"] *= 100
    assert normalize_target(value) is None
    value = target()
    value["name"] = "\x00  Blink\nexpand "
    value["steps"].reverse()
    assert normalize_target(value)["name"] == "Blinkexpand"
    assert normalize_target(value)["steps"][0]["t"] == 50
    assert normalize_ghost_state({"v": 1, "enabled": True, "slots": {"any": target()}}) == {
        "v": 1, "enabled": False, "slots": {},
    }


def test_replay_target_requires_concrete_races_real_events_and_caps_sorted_opening():
    with pytest.raises(GhostError, match="concrete races"):
        replay_target({"myRace": "Random"}, {"opp_race": "Terran", "events": []}, "replay")
    with pytest.raises(GhostError, match="no usable timed"):
        replay_target({}, {"my_race": "P", "opp_race": "T", "events": [{"name": "Probe", "time": 10}]}, "replay")
    result = replay_target({}, {"my_race": "P", "opp_race": "T", "events": [
        {"name": "Gateway", "time": index} for index in range(300, 0, -1)
    ]}, "replay")
    assert len(result["target"]["steps"]) == MAX_GHOST_STEPS
    assert result["target"]["steps"][0]["t"] == 1
    assert result["target"]["steps"][-1]["t"] == 250


def test_client_uses_owned_endpoints_escapes_ids_and_uploads_only_explicit_assignments():
    calls = []
    saved = [state()]

    def request(method, path, **options):
        calls.append((method, path, options))
        if path == "/v1/games":
            return {"items": [{"gameId": "mine"}], "nextBefore": "2026-10-22"}
        if path.endswith("/build-order"):
            return {"my_build": "Blink expand", "events": [{"name": "Gateway", "time": 50}]}
        if path == "/v1/me/ghost-builds":
            return {"v": 1, "slots": {"PvT": options["body"]["target"]} if method == "PUT" and options["body"]["target"] else {}, "references": {}}
        return {"myRace": "P", "opponent": {"race": "T"}}

    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    assert client.action({"action": "ghost_games", "before": "2026-10-23"})["items"] == [{"gameId": "mine"}]
    assert calls[-1] == ("GET", "/v1/games", {"params": {"limit": 50, "before": "2026-10-23"}})
    result = client.action({"action": "ghost_target", "gameId": "my/replay"})
    assert calls[-2][1] == "/v1/games/my%2Freplay"
    assert calls[-1][1] == "/v1/games/my%2Freplay/build-order"
    network_count = len(calls)
    client.action({"action": "ghost_save", **result})
    client.action({"action": "ghost_save", "enabled": False})
    assert saved[0]["slots"]["PvT"]["sourceGameId"] == "my/replay"
    assert len(calls) == network_count + 1
    assert calls[-1][0:2] == ("PUT", "/v1/me/ghost-builds")
    assert not client.action({"action": "ghost_state"})["ghost"]["enabled"]
    assert calls[-1][0:2] == ("GET", "/v1/me/ghost-builds")
    client.action({"action": "ghost_save", "matchup": "PvT", "target": None})
    assert not saved[0]["slots"]
    with pytest.raises(GhostError):
        client.action({"action": "ghost_save", "enabled": "yes"})
    with pytest.raises(GhostError):
        client.action({"action": "ghost_target", "gameId": ""})


def test_concurrent_preference_saves_preserve_other_matchup_assignments():
    saved = [state()]
    account = {"v": 1, "slots": deepcopy(saved[0]["slots"]), "references": {}}

    def request(_method, _path, **options):
        account["slots"][options["body"]["matchup"]] = options["body"]["target"]
        return deepcopy(account)

    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    threads = [threading.Thread(target=client.action, args=({"action": "ghost_save", "matchup": matchup, "target": target()},))
               for matchup in ("PvZ", "TvZ", "ZvP")]
    for worker in threads:
        worker.start()
    for worker in threads:
        worker.join()
    assert set(saved[0]["slots"]) == {"PvT", "PvZ", "TvZ", "ZvP"}
    assert saved[0]["enabled"] is True


def test_runtime_follows_live_clock_and_resets_on_game_change_without_claiming_completion():
    runtime = GhostSession()
    runtime.update_snapshot(snapshot(clock=125))
    view, _ = runtime.view(state(), now=1000)
    assert view["index"] == 1
    assert view["clock"] == 125
    assert runtime.view(state(), now=1002)[0]["clock"] == 125
    runtime.update_snapshot(snapshot(key="new-live", clock=10))
    view, _ = runtime.view(state(), now=1000)
    assert view["index"] == 0
    assert view["passed"] == 0
    runtime.update_snapshot(snapshot(key="new-live", clock=250))
    assert runtime.view(state(), now=1000)[0]["complete"] is True


@pytest.mark.parametrize("extra", [
    {"phase": "menu"}, {"phase": "match_ended"}, {"phase": "match_loading"},
    {"isReplay": True}, {"capturedAt": 900}, {"capturedAt": 1010},
    {"capturedAt": None}, {"displayTime": None}, {"displayTime": True},
    {"gameKey": None}, {"opponent": {"race": "Zerg"}}, {"user": {"race": "unknown"}},
    {"playerCount": 4}, {"matchFormat": "team"},
    {"players": [{"name": "one"}, {"name": "two"}, {"name": "three"}, {"name": "four"}]},
])
def test_runtime_hides_unsupported_or_stale_contexts(extra):
    runtime = GhostSession()
    runtime.update_snapshot(snapshot(**extra))
    assert runtime.view(state(), now=1000)[0] is None


def test_random_signal_is_latched_for_game_and_clears_for_new_game():
    runtime = GhostSession()
    runtime.update_snapshot(snapshot(phase="match_loading", opponent={"race": "Random"}))
    runtime.update_snapshot(snapshot(opponent={"race": "Terran"}))
    assert runtime.view(state(), now=1000)[0] is None
    runtime.update_snapshot(snapshot(key="new", opponent={"race": "Terran"}, receivedAt=1000000, capturedAt=0))
    assert runtime.view(state(), now=1000)[0]["matchup"] == "PvT"


def test_loading_configuration_never_exposes_mutable_saved_targets():
    original = state()
    normalized = normalize_ghost_state(original)
    normalized["slots"]["PvT"]["steps"][0]["t"] = 900
    assert original["slots"]["PvT"]["steps"][0]["t"] == 50


def test_account_refresh_preserves_explicit_local_only_slots_enabled_and_never_uploads_local_replays():
    saved = [state()]
    saved[0]["enabled"] = False
    saved[0]["localOnlyMatchups"] = ["PvT"]
    remote_target = target()
    remote_target["name"] = "Cloud build"
    calls = []

    def request(method, path, **options):
        calls.append((method, path))
        return {"v": 1, "slots": {"PvZ": remote_target}, "references": {
            "you:PvZ:cloud": {"matchup": "PvZ", "side": "you", "gameId": "replay-1", "target": remote_target},
        }}

    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    result = client.action({"action": "ghost_state"})
    assert calls == [("GET", "/v1/me/ghost-builds")]
    assert set(result["ghost"]["slots"]) == {"PvT", "PvZ"}
    assert result["ghost"]["enabled"] is False
    assert result["references"]["you:PvZ:cloud"]["target"]["name"] == "Cloud build"


def test_web_clear_removes_cached_account_target_after_native_restart():
    saved = [state()]
    client = GhostClient(lambda *_args, **_kwargs: {"v": 1, "slots": {}, "references": {}},
                         lambda: saved[0], lambda value: saved.__setitem__(0, value))
    result = client.action({"action": "ghost_state"})
    assert not result["ghost"]["slots"]
    assert result["ghost"]["enabled"] is True
    assert not saved[0]["slots"]


def test_remote_clear_keeps_unrelated_offline_assignment_and_offline_clear_without_upload():
    saved = [state()]
    offline = [True]
    calls = []

    def request(method, path, **options):
        calls.append((method, path))
        if offline[0]:
            raise OSError("offline")
        return {"v": 1, "slots": {"TvZ": target()}, "references": {}}

    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    client.action({"action": "ghost_save", "matchup": "PvZ", "target": target()})
    client.action({"action": "ghost_save", "matchup": "TvZ", "target": None})
    assert saved[0]["localOnlyMatchups"] == ["PvZ", "TvZ"]
    offline[0] = False
    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    result = client.action({"action": "ghost_state"})
    assert set(result["ghost"]["slots"]) == {"PvZ"}
    assert calls[-1] == ("GET", "/v1/me/ghost-builds")
    assert [method for method, _path in calls] == ["PUT", "PUT", "GET"]


def test_unavailable_cloud_keeps_local_targets_and_explicit_save_never_retries_later():
    saved = [state()]
    calls = []

    def request(method, path, **options):
        calls.append((method, path))
        raise OSError("offline")

    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    result = client.action({"action": "ghost_state"})
    assert result["ghost"]["slots"]["PvT"]
    assert "saved on this PC" in result["warning"]
    result = client.action({"action": "ghost_save", "matchup": "TvZ", "target": target()})
    assert saved[0]["slots"]["TvZ"]
    assert "Saved on this PC" in result["warning"]
    client.action({"action": "ghost_state"})
    assert calls == [("GET", "/v1/me/ghost-builds"), ("PUT", "/v1/me/ghost-builds"), ("GET", "/v1/me/ghost-builds")]


def test_reference_actions_share_account_slots_and_clear_only_matching_replay():
    saved = [state()]
    calls = []

    def request(method, path, **options):
        calls.append((method, path, options))
        clear = options.get("body", {}).get("clear")
        return {"v": 1, "slots": {} if clear else {"PvT": target()}, "references": {} if clear else {
            "you:PvT:Blink": {"gameId": "replay-1", "side": "you", "matchup": "PvT", "target": target()},
        }}

    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    result = client.action({"action": "ghost_reference", "gameId": "replay-1", "side": "you"})
    assert result["references"]
    assert calls[-1] == ("PUT", "/v1/me/ghost-builds/reference", {"body": {"gameId": "replay-1", "side": "you", "clear": False}})
    client.action({"action": "ghost_save", "enabled": False})
    result = client.action({"action": "ghost_reference", "gameId": "replay-1", "side": "you", "clear": True})
    assert result["ghost"]["enabled"] is False
    assert not result["ghost"]["slots"]
    assert not result["references"]


def test_refresh_and_assignment_are_serialized_to_prevent_stale_remote_response_overwrite():
    saved = [state()]
    refresh_started = threading.Event()
    release_refresh = threading.Event()
    remote = {"v": 1, "slots": {}, "references": {}}

    def request(method, path, **options):
        if method == "GET":
            refresh_started.set()
            assert release_refresh.wait(2)
        else:
            remote["slots"][options["body"]["matchup"]] = options["body"]["target"]
        return deepcopy(remote)

    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    refresh = threading.Thread(target=client.action, args=({"action": "ghost_state"},))
    assignment = threading.Thread(target=client.action, args=({"action": "ghost_save", "matchup": "TvZ", "target": target()},))
    refresh.start()
    assert refresh_started.wait(2)
    assignment.start()
    release_refresh.set()
    refresh.join(2)
    assignment.join(2)
    assert not refresh.is_alive() and not assignment.is_alive()
    assert saved[0]["slots"]["TvZ"]


def test_curated_examples_are_read_from_bounded_owned_api_without_exposing_credentials():
    calls = []

    def request(method, path, **options):
        calls.append((method, path))
        if path == "/v1/ghost-examples":
            return {"items": [{"id": "curated", "name": "Example"}] * 101}
        return {"matchup": "PvT", "target": target()}

    client = GhostClient(request, lambda: state(), lambda _value: None)
    assert len(client.action({"action": "ghost_examples"})["items"]) == 100
    assert client.action({"action": "ghost_example_target", "exampleId": "admin/example"})["matchup"] == "PvT"
    assert calls[-1] == ("GET", "/v1/ghost-examples/admin%2Fexample")


def test_team_cloud_replay_cannot_be_reinterpreted_as_one_matchup():
    calls = []

    def request(method, path, **options):
        calls.append(path)
        return {"myRace": "Protoss", "opponent": {"race": "Terran"}, "matchFormat": "team", "playerCount": 4}

    client = GhostClient(request, lambda: state(), lambda _value: None)
    with pytest.raises(GhostError, match="one-versus-one"):
        client.action({"action": "ghost_target", "gameId": "team-game"})
    assert calls == ["/v1/games/team-game"]


def test_long_game_ids_hash_to_canonical_source_and_preserve_target_perspective():
    game_id = "long-replay-" + "a" * 170
    result = replay_target({"myRace": "P", "opponent": {"race": "T"}},
                           {"events": [{"name": "Gateway", "time": 50}]}, game_id)
    assert result["target"]["sourceGameId"] == "replay:" + hashlib.sha256(game_id.encode()).hexdigest()
    assert normalize_target({**target(), "perspective": "opponent"})["perspective"] == "opponent"
    assert normalize_target({**target(), "perspective": "wrong"}) is None


def test_account_history_is_bounded_and_restored_with_expected_current_revision():
    saved = [state()]
    calls = []
    old_target = {**target(), "name": "Previous reference"}
    old = {"revision": "old", "gameId": "previous", "side": "you", "matchup": "PvT", "target": old_target}
    current = {"revision": "current", "gameId": "replay-1", "side": "you", "matchup": "PvT", "target": target()}

    def request(method, path, **options):
        calls.append((method, path, options))
        if method == "PUT":
            return {"v": 1, "slots": {"PvT": old_target}, "references": {"family": old}, "history": {"family": [current]}}
        return {"v": 1, "slots": {"PvT": target()}, "references": {"family": current}, "history": {"family": [old] * 9}}

    client = GhostClient(request, lambda: saved[0], lambda value: saved.__setitem__(0, value))
    assert len(client.action({"action": "ghost_state"})["history"]["family"]) == 3
    result = client.action({"action": "ghost_reference_restore", "referenceKey": "family", "revision": "old", "expectedCurrentRevision": "current"})
    assert calls[-1] == ("PUT", "/v1/me/ghost-builds/reference/restore", {"body": {"referenceKey": "family", "revision": "old", "expectedCurrentRevision": "current"}})
    assert result["ghost"]["enabled"] is True
    assert result["ghost"]["slots"]["PvT"]["name"] == "Previous reference"


def test_comparison_uses_owned_replay_and_side_and_bounds_rows():
    calls = []

    def request(method, path, **options):
        calls.append((method, path, options))
        return {"status": "ready", "rows": [{"name": "Gateway", "targetSec": 50, "actualSec": 55, "deltaSec": 5}] * 300}

    client = GhostClient(request, lambda: state(), lambda _value: None)
    result = client.action({"action": "ghost_comparison", "gameId": "replay-2", "side": "opponent", "buildKey": "Bio"})
    assert len(result["rows"]) == MAX_GHOST_STEPS
    assert calls[-1] == ("GET", "/v1/me/ghost-builds/comparison", {"params": {"gameId": "replay-2", "side": "opponent", "buildKey": "Bio"}})
