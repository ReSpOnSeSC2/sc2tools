from collections import Counter
from contextlib import contextmanager, nullcontext
import json
from types import SimpleNamespace as NS

import pytest
from sc2.bot_ai import BotAI
from sc2.data import Result

from pluto_sc2 import coach_session


def read_state(path):
    return json.loads((path / "session.json").read_text())


def initialize(tmp_path, monkeypatch, **kwargs):
    monkeypatch.setattr(coach_session, "resolve_map", lambda name: NS(path=name))
    return coach_session.initialize(tmp_path / "coach", "Known Eight Worker Map", **kwargs)


def test_initialize_preserves_resolvable_installed_map_name_and_separate_profile(tmp_path, monkeypatch):
    state = initialize(tmp_path, monkeypatch)
    assert state["map"] == "Known Eight Worker Map"
    assert state["status"] == "ready"
    assert state["learned_policy"] is False and state["external_model_api"] is False
    assert read_state(tmp_path / "coach") == state


def test_initialize_cannot_overwrite_existing_session_or_league_files(tmp_path, monkeypatch):
    directory = tmp_path / "coach"
    directory.mkdir()
    manifest = directory / "state.json"
    manifest.write_text("existing league data")
    monkeypatch.setattr(coach_session, "resolve_map", lambda name: NS(path=name))
    with pytest.raises(ValueError, match="empty"):
        coach_session.initialize(directory, "Known Map")
    assert manifest.read_text() == "existing league data"
    assert list(directory.iterdir()) == [manifest]


@pytest.mark.parametrize("options", [
    {"seconds": 59}, {"seconds": 3601}, {"seconds": float("inf")},
    {"speed": 0}, {"speed": float("nan")}, {"speed": 51},
    {"opponent_race": "Random"}, {"difficulty": "CheatInsane"},
])
def test_initialization_rejects_unbounded_or_unsupported_configuration(tmp_path, monkeypatch, options):
    with pytest.raises(ValueError):
        initialize(tmp_path, monkeypatch, **options)


def test_constructor_failure_records_failed_session_instead_of_stuck_running(tmp_path, monkeypatch):
    initialize(tmp_path, monkeypatch)

    def failed(*_args, **_kwargs):
        raise RuntimeError("constructor failure")

    monkeypatch.setattr(coach_session, "CoachBot", failed)
    with pytest.raises(RuntimeError, match="constructor failure"):
        coach_session.run(tmp_path / "coach")
    state = read_state(tmp_path / "coach")
    assert state["status"] == "failed"
    assert "constructor failure" in state["error"]


class FakeBot(BotAI):
    def __init__(self, *_args, **_kwargs):
        super().__init__()
        self.error = None
        self._episode_finished = True
        self.state = NS(game_loop=224)
        self.action_counts = Counter(train_probe=4)
        self.forfeit_reason = None
        self.control_summary = {"learned_policy": False}
        self.mailbox = NS(status={})
        self.fairplay = NS(summary=lambda: {"max_apm": 200}, audit=[])


def test_run_uses_spatial_client_ordinary_opponent_and_no_fog_bypass(tmp_path, monkeypatch):
    initialize(tmp_path, monkeypatch)
    monkeypatch.setattr(coach_session, "CoachBot", FakeBot)
    boundaries, calls = [], []

    @contextmanager
    def spatial():
        boundaries.append("enter")
        try:
            yield
        finally:
            boundaries.append("exit")

    def game(map_data, players, **kwargs):
        calls.append((map_data, players, kwargs))
        return Result.Victory

    monkeypatch.setattr(coach_session, "spatial_client", spatial)
    monkeypatch.setattr(coach_session, "run_game", game)
    monkeypatch.setattr(coach_session, "validate_action_audit", lambda audit: {"valid": True})
    state = coach_session.run(tmp_path / "coach")
    assert boundaries == ["enter", "exit"]
    assert calls[0][2]["disable_fog"] is False
    assert calls[0][2]["realtime"] is False
    assert calls[0][2]["game_time_limit"] == 600
    assert calls[0][1][1].difficulty.name == "VeryEasy"
    assert state["status"] == "complete" and state["result"] == "Victory"
    assert (tmp_path / "coach" / "audit.json").is_file()
    with pytest.raises(ValueError, match="ready"):
        coach_session.run(tmp_path / "coach")


def test_engine_failure_is_recorded_and_spatial_context_closes(tmp_path, monkeypatch):
    initialize(tmp_path, monkeypatch)
    monkeypatch.setattr(coach_session, "CoachBot", FakeBot)
    closed = []

    @contextmanager
    def spatial():
        try:
            yield
        finally:
            closed.append(True)

    def game(*_args, **_kwargs):
        raise RuntimeError("engine disconnected")

    monkeypatch.setattr(coach_session, "spatial_client", spatial)
    monkeypatch.setattr(coach_session, "run_game", game)
    with pytest.raises(RuntimeError, match="engine disconnected"):
        coach_session.run(tmp_path / "coach")
    assert closed == [True]
    assert read_state(tmp_path / "coach")["status"] == "failed"


def failing_game(tmp_path, monkeypatch, error):
    initialize(tmp_path, monkeypatch)
    monkeypatch.setattr(coach_session, "CoachBot", FakeBot)
    monkeypatch.setattr(coach_session, "spatial_client", nullcontext)
    actions = [{"time": 9.5, "kind": "selection", "selected_tags": [7],
                "result": [1], "selection_confirmation": "confirmed"}]

    def game(_map, players, **_kwargs):
        players[0].ai.fairplay.audit.extend(actions)
        raise error

    monkeypatch.setattr(coach_session, "run_game", game)
    return tmp_path / "coach", actions


def test_failed_native_run_preserves_partial_receipts_without_claiming_verification(tmp_path, monkeypatch):
    original = KeyError(4135)
    output, actions = failing_game(tmp_path, monkeypatch, original)
    monkeypatch.setattr(coach_session, "validate_action_audit",
                        lambda _: pytest.fail("An incomplete game must not undergo success validation"))
    with pytest.raises(KeyError) as caught:
        coach_session.run(output)
    assert caught.value is original
    partial = json.loads((output / "audit.partial.json").read_text())
    assert partial["actions"] == actions
    assert partial["partial"] is True and partial["completed"] is False
    assert partial["verification_passed"] is False
    assert partial["validation"]["status"] == "not_run"
    assert partial["failure"] == "KeyError: 4135"
    state = read_state(output)
    assert state["status"] == "failed" and state["error"] == "KeyError: 4135"
    assert state["partial_audit"]["status"] == "saved"
    assert state["partial_audit"]["actions"] == 1
    assert "input_validation" not in state
    assert not (output / "audit.json").exists()


def test_normal_validation_failure_preserves_receipts_and_original_exception(tmp_path, monkeypatch):
    original = ValueError("audit did not pass")
    output, _ = failing_game(tmp_path, monkeypatch, original)
    actions = [{"time": 2, "kind": "camera", "result": [1]}]

    def game(_map, players, **_kwargs):
        players[0].ai.fairplay.audit.extend(actions)
        return Result.Victory

    validations = []

    def invalid(audit):
        validations.append(audit)
        raise original

    monkeypatch.setattr(coach_session, "run_game", game)
    monkeypatch.setattr(coach_session, "validate_action_audit", invalid)
    with pytest.raises(ValueError) as caught:
        coach_session.run(output)
    assert caught.value is original and len(validations) == 1
    partial = json.loads((output / "audit.partial.json").read_text())
    assert partial["actions"] == actions and partial["completed"] is False
    assert partial["verification_passed"] is False
    assert read_state(output)["status"] == "failed"
    assert not (output / "audit.json").exists()


def test_partial_summary_failure_does_not_discard_actions(tmp_path, monkeypatch):
    original = RuntimeError("native failure")
    output, actions = failing_game(tmp_path, monkeypatch, original)

    class BrokenSummaryBot(FakeBot):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)

            def summary():
                raise ValueError("summary failed")

            self.fairplay.summary = summary

    monkeypatch.setattr(coach_session, "CoachBot", BrokenSummaryBot)
    with pytest.raises(RuntimeError) as caught:
        coach_session.run(output)
    assert caught.value is original
    partial = json.loads((output / "audit.partial.json").read_text())
    assert partial["actions"] == actions and partial["summary"] == {}
    assert partial["summary_error"] == "ValueError: summary failed"


def test_partial_audit_write_failure_cannot_replace_original_native_error(tmp_path, monkeypatch):
    original = RuntimeError("native failure")
    output, _ = failing_game(tmp_path, monkeypatch, original)
    real_write = coach_session.write_json

    def cannot_write(path, value):
        if path.name == "audit.partial.json":
            raise PermissionError("audit file locked")
        return real_write(path, value)

    monkeypatch.setattr(coach_session, "write_json", cannot_write)
    with pytest.raises(RuntimeError) as caught:
        coach_session.run(output)
    assert caught.value is original
    state = read_state(output)
    assert state["status"] == "failed" and state["error"] == "RuntimeError: native failure"
    assert state["partial_audit"]["status"] == "preservation_failed"
    assert "audit file locked" in state["partial_audit"]["error"]
    assert any("Partial action audit" in note for note in original.__notes__)


def test_failed_manifest_write_cannot_replace_original_native_error(tmp_path, monkeypatch):
    original = RuntimeError("native failure")
    output, actions = failing_game(tmp_path, monkeypatch, original)
    real_write = coach_session.write_json

    def cannot_write(path, value):
        if path.name == "session.json" and value["status"] == "failed":
            raise PermissionError("session file locked")
        return real_write(path, value)

    monkeypatch.setattr(coach_session, "write_json", cannot_write)
    with pytest.raises(RuntimeError) as caught:
        coach_session.run(output)
    assert caught.value is original
    assert json.loads((output / "audit.partial.json").read_text())["actions"] == actions
    assert any("session file locked" in note for note in original.__notes__)


def test_stop_marker_prevents_engine_start(tmp_path, monkeypatch):
    initialize(tmp_path, monkeypatch)
    (tmp_path / "coach" / "STOP").write_text("stop")
    monkeypatch.setattr(coach_session, "run_game", lambda *_args, **_kwargs: pytest.fail("must not start"))
    with pytest.raises(ValueError, match="unstopped"):
        coach_session.run(tmp_path / "coach")
    assert read_state(tmp_path / "coach")["status"] == "ready"
