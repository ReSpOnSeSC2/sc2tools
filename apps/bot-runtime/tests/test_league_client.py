import asyncio
from types import SimpleNamespace as NS

from loguru import logger
import pytest
from sc2.client import Client
from sc2.data import Race, Result
from s2clientprotocol import sc2api_pb2 as api, raw_pb2 as raw, query_pb2 as query, common_pb2 as common

from pluto_sc2.fairplay import FEATURE_CAMERA_SIZE
from pluto_sc2.league_client import LeagueClient, league_clients
from pluto_sc2.runner import ManagedSC2Process


def request_action():
    return api.RequestAction(actions=[api.Action(action_raw=raw.ActionRaw(
        unit_command=raw.ActionRawUnitCommand(ability_id=16, unit_tags=[1])))])


@pytest.fixture
def recorder(monkeypatch):
    calls = []

    async def execute(self, **kwargs):
        calls.append(kwargs)
        return api.Response()

    monkeypatch.setattr(Client, "_execute", execute)
    return calls


def test_protoss_retains_original_spatial_interface_and_raw_command_rejection(recorder):
    client = LeagueClient(object())
    join = api.RequestJoinGame(race=Race.Protoss.value)
    asyncio.run(client._execute(join_game=join))
    assert join.options.feature_layer.width == FEATURE_CAMERA_SIZE
    with pytest.raises(RuntimeError, match="Raw actions"):
        asyncio.run(client._execute(action=request_action()))
    assert len(recorder) == 1


@pytest.mark.parametrize("race", [Race.Terran, Race.Zerg])
def test_adversaries_can_use_raw_commands_but_cannot_change_interface_or_disable_fog(recorder, race):
    client = LeagueClient(object())
    join = api.RequestJoinGame(race=race.value)
    join.options.show_cloaked = join.options.show_burrowed_shadows = True
    join.options.show_placeholders = True
    asyncio.run(client._execute(join_game=join))
    assert not join.options.show_cloaked
    assert not join.options.show_burrowed_shadows
    assert not join.options.show_placeholders
    assert not join.options.HasField("feature_layer")
    asyncio.run(client._execute(action=request_action()))
    assert client._last_api_request["kind"] == "action"
    assert client._last_api_request["actions"] == [
        {"interface": "action_raw", "kind": "unit_command", "ability": 16}]
    assert client._last_api_request["elapsed_seconds"] >= 0
    assert len(recorder) == 2
    with pytest.raises(RuntimeError, match="cannot change"):
        asyncio.run(client._execute(join_game=api.RequestJoinGame(race=Race.Protoss.value)))
    with pytest.raises(RuntimeError, match="fog"):
        asyncio.run(client._execute(observation=api.RequestObservation(disable_fog=True)))
    with pytest.raises(RuntimeError, match="modify"):
        asyncio.run(client._execute(debug=api.RequestDebug()))
    batched = request_action()
    batched.actions.add().CopyFrom(batched.actions[0])
    with pytest.raises(RuntimeError, match="individually"):
        asyncio.run(client._execute(action=batched))
    assert len(recorder) == 2


def test_race_must_be_explicit_and_ordinary_runner_is_restored_on_exception():
    import sc2.main
    names = ("Client", "SC2Process", "_play_game", "_host_game", "_join_game")
    original = {name: getattr(sc2.main, name) for name in names}
    with pytest.raises(RuntimeError, match="explicit"):
        asyncio.run(LeagueClient(object())._execute(join_game=api.RequestJoinGame(race=Race.Random.value)))
    with pytest.raises(ValueError):
        with league_clients():
            assert sc2.main.Client is LeagueClient
            assert sc2.main.SC2Process is ManagedSC2Process
            raise ValueError("test")
    assert {name: getattr(sc2.main, name) for name in names} == original


def test_raw_query_target_requirement_is_retained_without_an_extra_request(monkeypatch):
    calls = []

    async def execute(_self, **kwargs):
        calls.append(kwargs)
        return api.Response(query=query.ResponseQuery(abilities=[query.ResponseQueryAvailableAbilities(
            unit_tag=100, abilities=[common.AvailableAbility(ability_id=454, requires_point=True),
                                    common.AvailableAbility(ability_id=3682, requires_point=False)])]))

    monkeypatch.setattr(Client, "_execute", execute)
    client = LeagueClient(object())
    client._league_race = Race.Terran.value
    request = query.RequestQuery(abilities=[query.RequestQueryAvailableAbilities(unit_tag=100)])
    response = asyncio.run(client._execute(query=request))
    assert len(calls) == 1 and calls[0]["query"] is request
    assert response.query.abilities[0].unit_tag == 100
    assert client.available_ability_details == {100: {454: True, 3682: False}}


@pytest.fixture
def diagnostic_logs():
    messages = []
    sink = logger.add(messages.append, format="{message}", diagnose=False, backtrace=False)
    try:
        yield messages
    finally:
        logger.remove(sink)


def peer():
    player = NS(name="Protoss learner", race=Race.Protoss,
                ai=NS(state=NS(game_loop=7200), error=None, result=None))
    client = NS(_status=NS(name="launched"), _player_id=1, _game_result=None)
    return player, client


def test_successful_result_and_arguments_are_unchanged(monkeypatch):
    import sc2.main
    calls = []

    async def play(*args, **kwargs):
        calls.append((args, kwargs))
        return Result.Defeat

    monkeypatch.setattr(sc2.main, "_play_game", play)
    player, client = peer()
    with league_clients():
        result = asyncio.run(sc2.main._play_game(player, client, realtime=False, game_time_limit=900))
    assert result is Result.Defeat
    assert calls == [((player, client), dict(realtime=False, game_time_limit=900))]
    assert sc2.main._play_game is play


def test_original_exception_is_logged_before_gather_assert_and_exposed_as_cause(monkeypatch, diagnostic_logs):
    import sc2.main
    original = OSError("transport_end_of_game")

    async def play(*args, **kwargs):
        raise original

    monkeypatch.setattr(sc2.main, "_play_game", play)
    player, client = peer()

    async def gathered():
        return await asyncio.gather(sc2.main._play_game(player, client, False), return_exceptions=True)

    with pytest.raises(RuntimeError, match="_play_game.*Protoss learner.*OSError.*transport_end_of_game") as captured:
        with league_clients():
            results = asyncio.run(gathered())
            assert results == [original]
            assert all(isinstance(result, Result) for result in results)
    assert captured.value.__cause__ is original
    assert sc2.main._play_game is play
    messages = "\n".join(str(message) for message in diagnostic_logs)
    assert "League engine exception before result collection" in messages
    assert "game_loop': 7200" in messages and "bot_error': None" in messages
    assert "client_status': 'launched'" in messages
    assert "Traceback" in messages and "OSError: transport_end_of_game" in messages


@pytest.mark.parametrize("phase", ["_host_game", "_join_game"])
def test_setup_or_cleanup_error_cannot_hide_behind_successful_peer(monkeypatch, diagnostic_logs, phase):
    import sc2.main
    original = PermissionError("replay file unavailable")

    async def failed_peer(*args, **kwargs):
        raise original

    monkeypatch.setattr(sc2.main, phase, failed_peer)
    player, _client = peer()
    players = [player, NS(name="Terran snapshot", race=Race.Terran, ai=NS(error=None))]
    args = (object(), players) if phase == "_host_game" else (players,)

    async def gathered():
        return await asyncio.gather(getattr(sc2.main, phase)(*args), return_exceptions=True)

    with pytest.raises(RuntimeError, match="PermissionError: replay file unavailable") as captured:
        with league_clients():
            results = asyncio.run(gathered())
            results.append(Result.Victory)
            assert all(isinstance(result, Result) for result in results)
    assert captured.value.__cause__ is original
    assert getattr(sc2.main, phase) is failed_peer
    assert any(phase in str(message) for message in diagnostic_logs)


def test_same_exception_crossing_play_and_host_is_logged_once(monkeypatch, diagnostic_logs):
    import sc2.main
    original = ValueError("terminal callback failed")
    player, client = peer()

    async def play(*args, **kwargs):
        raise original

    async def host(_map, _players):
        return await sc2.main._play_game(player, client, False)

    monkeypatch.setattr(sc2.main, "_play_game", play)
    monkeypatch.setattr(sc2.main, "_host_game", host)
    with pytest.raises(ValueError) as captured:
        with league_clients():
            asyncio.run(sc2.main._host_game(object(), [player]))
    assert captured.value is original
    assert len(diagnostic_logs) == 1


def test_non_result_return_is_diagnosed_and_never_inferred_from_other_peer(monkeypatch, diagnostic_logs):
    import sc2.main

    async def play(*args, **kwargs):
        return None

    monkeypatch.setattr(sc2.main, "_play_game", play)
    with pytest.raises(RuntimeError, match="invalid result.*NoneType: None"):
        with league_clients():
            result = asyncio.run(sc2.main._play_game(*peer(), False))
            assert result is None
            assert all(isinstance(value, Result) for value in [result, Result.Victory])
    assert any("invalid result" in str(message) for message in diagnostic_logs)
    assert sc2.main._play_game is play


def test_recorded_failure_cannot_be_swallowed_by_caller(monkeypatch):
    import sc2.main
    original = OSError("read failed")

    async def play(*args, **kwargs):
        raise original

    monkeypatch.setattr(sc2.main, "_play_game", play)
    with pytest.raises(RuntimeError, match="match rejected") as captured:
        with league_clients():
            try:
                asyncio.run(sc2.main._play_game(*peer(), False))
            except OSError:
                pass
    assert captured.value.__cause__ is original


def test_real_game_assertion_and_cancellation_are_not_replaced(monkeypatch):
    import sc2.main
    for original in (AssertionError("real engine assertion"), asyncio.CancelledError()):
        async def play(*args, **kwargs):
            raise original

        monkeypatch.setattr(sc2.main, "_play_game", play)
        with pytest.raises(type(original)) as captured:
            with league_clients():
                asyncio.run(sc2.main._play_game(*peer(), False))
        assert captured.value is original
        assert sc2.main._play_game is play

