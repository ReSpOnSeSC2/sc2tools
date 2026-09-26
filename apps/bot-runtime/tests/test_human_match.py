import asyncio
import json
from types import SimpleNamespace

import pytest
from s2clientprotocol import sc2api_pb2 as api
from sc2.client import Client
from sc2.data import Race, Result

from pluto_sc2 import human_match as match


@pytest.mark.parametrize("race", match.RACES)
def test_human_interface_keeps_physical_selection_and_fog(monkeypatch, race):
    calls = []

    async def execute(self, **kwargs):
        calls.append(kwargs)
        return api.Response(join_game=api.ResponseJoinGame(player_id=1))

    monkeypatch.setattr(Client, "_execute", execute)
    human = match.LocalHumanClient(object())
    assert asyncio.run(human.join_game("Local human", Race[race])) == 1
    options = calls[0]["join_game"].options
    assert options.raw and not options.raw_affects_selection
    assert not options.show_cloaked and not options.show_burrowed_shadows and not options.show_placeholders
    assert not options.HasField("feature_layer") and not options.HasField("render")


@pytest.mark.parametrize("message", [
    {"action": api.RequestAction()}, {"step": api.RequestStep(count=8)},
    {"debug": api.RequestDebug()}, {"quick_load": api.RequestQuickLoad()},
    {"observation": api.RequestObservation(disable_fog=True)},
    {"join_game": api.RequestJoinGame(observed_player_id=1)},
])
def test_human_client_rejects_automation_and_observer_bypasses(message):
    with pytest.raises((RuntimeError, ValueError)):
        asyncio.run(match.LocalHumanClient(object())._execute(**message))


@pytest.mark.parametrize("value", [[], {"close": "yes"}, {"close": 1}, {"close": None}])
def test_close_control_requires_real_boolean(tmp_path, value):
    path = tmp_path / "control.json"
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError):
        match.read_controls(path)


@pytest.mark.parametrize("race", match.RACES)
def test_policy_is_frozen_inference_with_existing_race_constraints(monkeypatch, race):
    from pluto_sc2 import league, sc2_adapter, adversary
    import torch

    policy = SimpleNamespace(eval=lambda: None, requires_grad_=lambda value: grad.append(value))
    grad, calls, threads = [], [], []
    monkeypatch.setattr(torch, "set_num_threads", lambda value: threads.append(value))
    monkeypatch.setattr(league, "_load", lambda path, race, **kwargs: {"policy": policy})

    def protoss(loaded, **kwargs):
        calls.append((loaded, kwargs))
        return "protoss"

    def adversary_bot(loaded, bot_race, **kwargs):
        calls.append((loaded, kwargs))
        assert bot_race == race
        return "adversary"

    monkeypatch.setattr(sc2_adapter, "NeuralBot", protoss)
    monkeypatch.setattr(adversary, "AdversaryBot", adversary_bot)
    result = match._load_bot("immutable.pt", race, 600, 3600)
    assert result == ("protoss" if race == "Protoss" else "adversary")
    assert threads == [2] and grad == [False]
    settings = calls[0][1]
    assert settings["record"] is False and settings["expected_start_workers"] == 8
    if race == "Protoss":
        assert "max_apm" not in settings  # Existing fixed 200 APM controller.
    else:
        assert settings["max_apm"] == 600 and settings["step_mul"] == 2


def observation(race, workers=8, loop=0):
    response = api.Response(observation=api.ResponseObservation(observation=api.Observation(game_loop=loop)))
    for _ in range(workers):
        response.observation.observation.raw_data.units.add(unit_type=match.WORKER_IDS[race], alliance=1)
    # Visible opponent workers cannot pass the owned-worker start guard.
    response.observation.observation.raw_data.units.add(unit_type=match.WORKER_IDS[race], alliance=4)
    return response


@pytest.fixture
def rig(tmp_path, monkeypatch):
    from pluto_sc2 import league_client, runner, adversary
    from sc2 import portconfig

    checkpoint = tmp_path / "frozen.pt"
    checkpoint.write_bytes(b"immutable weights")
    output = tmp_path / "game"
    settings = SimpleNamespace(human_race="Protoss", bot_race="Terran", workers=8,
                               drive_error=None, result=[Result.Victory, Result.Defeat], close=False)
    controllers, processes, clients, events = {}, [], {}, []
    bot = SimpleNamespace(fairplay=SimpleNamespace(summary=lambda: {"max_apm": 600}, audit=[]),
                          time=35.0, state=SimpleNamespace(game_loop=784))

    class Controller:
        def __init__(self, role):
            self._ws = role

        async def ping(self):
            return api.Response(ping=api.ResponsePing(base_build=97563, data_version="ABC"))

        async def create_game(self, map_settings, players, **kwargs):
            events.append(("create", kwargs, players))
            return api.Response(create_game=api.ResponseCreateGame())

    class Process:
        def __init__(self, **kwargs):
            self.role = "bot" if not processes else "human"
            self.configuration = kwargs
            self._process = SimpleNamespace(pid=987600 + len(processes), poll=lambda: None)
            self.closed = False
            processes.append(self)

        async def __aenter__(self):
            controller = Controller(self.role)
            controllers[self.role] = controller
            return controller

        async def __aexit__(self, *args):
            # The UI must not offer a second match during process cleanup.
            assert json.loads((output / "status.json").read_text())["status"] not in (
                "finished", "closed", "failed")
            self.closed = True
            events.append(("cleanup", self.role))

    class TestClient:
        def __init__(self, role):
            self.role = role
            clients[role] = self

        async def join_game(self, name, race, portconfig):
            self._player_id = 1 if self.role == "human" else 2
            self.race = race.name
            events.append(("join", self.role))
            return self._player_id

        async def observation(self):
            return observation(self.race, workers=settings.workers)

        async def save_replay(self, path):
            events.append(("save", self.role))
            assert json.loads((output / "status.json").read_text())["status"] not in (
                "finished", "closed", "failed")
            from pathlib import Path
            Path(path).write_bytes(b"SC2 test replay")

        async def leave(self):
            events.append(("leave", self.role))

    class Ports:
        def clean(self):
            events.append(("clean_ports",))

    async def drive(bot, client, initial, publish, closed_reason, max_game_seconds):
        assert client.role == "bot"
        if settings.drive_error:
            raise ValueError(settings.drive_error)
        publish("playing")
        if settings.close:
            return "closed", None, "Closed from the local match controls"
        return "finished", dict(zip((1, 2), settings.result)), None

    monkeypatch.setattr(match, "_created_at", lambda pid: 123.)
    monkeypatch.setattr(match, "_load_bot", lambda *args: bot)
    monkeypatch.setattr(match, "resolve_map", lambda path: SimpleNamespace(name="Practice Map"))
    monkeypatch.setattr(match, "seed_everything", lambda seed: None)
    monkeypatch.setattr(match, "LocalHumanClient", TestClient)
    monkeypatch.setattr(league_client, "LeagueClient", TestClient)
    monkeypatch.setattr(portconfig, "Portconfig", Ports)
    monkeypatch.setattr(runner, "validate_action_audit", lambda audit: audit)
    monkeypatch.setattr(adversary, "validate_adversary_audit", lambda audit: audit)
    monkeypatch.setattr(match, "_drive_bot", drive)
    # Player construction only needs the bot's type; isolate actual lifecycle in
    # the _drive_bot tests below.
    from sc2 import player
    monkeypatch.setattr(player, "Bot", lambda *args, **kwargs: SimpleNamespace(name=kwargs["name"]))

    def run(**kwargs):
        return asyncio.run(match.play(checkpoint, output, human_race=settings.human_race,
            bot_race=settings.bot_race, map_path="Practice.SC2Map", process_factory=Process, **kwargs))

    return SimpleNamespace(run=run, output=output, checkpoint=checkpoint, settings=settings,
                           processes=processes, events=events, clients=clients)


def test_two_clients_realtime_human_result_replay_and_owned_cleanup(rig):
    result = rig.run()
    assert result["status"] == "finished" and result["result"] == "Victory"
    assert result["results"] == ["Victory", "Defeat"]
    assert result["start_workers"] == {"human": 8, "bot": 8}
    assert result["training_updated"] is False
    assert rig.checkpoint.read_bytes() == b"immutable weights"
    assert len(rig.processes) == 2 and all(p.closed for p in rig.processes)
    assert rig.processes[0].configuration["resolution"] == (640, 480)
    assert rig.processes[1].configuration["resolution"] == (1280, 720)
    creation = next(event for event in rig.events if event[0] == "create")
    assert creation[1]["realtime"] is True and creation[1]["disable_fog"] is False
    assert rig.events.index(("save", "human")) < rig.events.index(("leave", "human"))
    saved = json.loads((rig.output / "match.json").read_text())
    assert saved["learner_race"] == "Protoss" and saved["opponent_race"] == "Terran"
    assert saved["game_seconds"] == [35.0, 35.0] and saved["exhibition"]


def test_wrong_start_never_runs_bot_and_still_cleans_up(rig):
    rig.settings.workers = 12
    result = rig.run()
    assert result["status"] == "failed" and "eight starting workers" in result["error"]
    assert result["result"] is None
    assert all(process.closed for process in rig.processes)
    assert (rig.output / "game.SC2Replay").exists()


def test_bot_error_is_not_reported_as_human_win(rig):
    rig.settings.drive_error = "model failed"
    result = rig.run()
    assert result["status"] == "failed" and "model failed" in result["error"]
    assert result["result"] is None and all(p.closed for p in rig.processes)


def test_user_close_is_not_reported_as_a_completed_win(rig):
    rig.settings.close = True
    result = rig.run()
    assert result["status"] == "closed" and result["results"] is None
    assert (rig.output / "game.SC2Replay").exists()
    assert all(p.closed for p in rig.processes)


def test_preexisting_close_starts_no_sc2_process(rig):
    rig.output.mkdir()
    (rig.output / "control.json").write_text('{"close": true}')
    result = rig.run()
    assert result["status"] == "closed" and not rig.processes


def test_existing_game_is_never_overwritten(rig):
    rig.output.mkdir()
    previous = rig.output / "game.SC2Replay"
    previous.write_bytes(b"previous game")
    with pytest.raises(ValueError, match="already contains"):
        rig.run()
    assert previous.read_bytes() == b"previous game" and not rig.processes


@pytest.mark.parametrize("argument,value", [("max_wall_seconds", -1), ("max_game_seconds", float("inf")),
                                            ("max_apm", True)])
def test_invalid_limits_fail_before_process_launch(rig, argument, value):
    result = rig.run(**{argument: value})
    assert result["status"] == "failed" and not rig.processes


@pytest.mark.parametrize("duration", [3600, .1])
def test_real_time_bot_driver_never_steps_engine(monkeypatch, duration):
    from sc2 import game_state

    events, published = [], []

    class Bot:
        error = None

        def _initialize_variables(self):
            pass

        def _prepare_start(self, client, player_id, info, data, **kwargs):
            assert kwargs["realtime"] is True

        def _prepare_step(self, state, info):
            self.state, self.time = state, state.game_loop / 22.4

        def _prepare_first_step(self):
            pass

        async def on_before_start(self):
            pass

        async def on_start(self):
            events.append("start")

        async def on_end(self, result):
            events.append(result)

        async def issue_events(self):
            pass

        async def on_step(self, iteration):
            events.append("policy input")

        async def _after_step(self):
            pass

    class BotClient:
        _player_id, game_step, _game_result, loop = 2, 8, None, 0

        async def get_game_data(self):
            return None

        async def get_game_info(self):
            return None

        async def ping(self):
            return api.Response(ping=api.ResponsePing(base_build=97563))

        async def _execute(self, **kwargs):
            assert set(kwargs) == {"game_info"}

        async def observation(self, requested):
            assert requested == self.loop + 8
            self.loop = requested
            if requested == 16:
                self._game_result = {1: Result.Defeat, 2: Result.Victory}
            return observation("Protoss", loop=requested)

        async def step(self, *args):
            pytest.fail("Realtime matches must not step the engine")

    monkeypatch.setattr(game_state, "GameState", lambda obs, *args:
                        SimpleNamespace(game_loop=obs.observation.game_loop))
    result = asyncio.run(match._drive_bot(Bot(), BotClient(), observation("Protoss"),
        lambda *args, **kwargs: published.append((args, kwargs)), lambda: None, duration))
    assert result[0] == "finished"
    if duration == 3600:
        assert result[1][1] == Result.Defeat
        assert events == ["start", "policy input", Result.Victory]
    else:
        assert result[1] == {1: Result.Tie, 2: Result.Tie}
        assert result[2] == "Game time limit reached"
        assert events == ["start", Result.Tie]
    assert published[0][0] == ("playing",)
