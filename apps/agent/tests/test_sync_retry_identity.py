"""Exact native identity and held-work fences. All parsing/capture is synthetic."""
from concurrent.futures import Future, ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import Mock
import threading

import pytest

from sc2tools_agent import replay_pipeline as pipeline, watcher, runner
from sc2tools_agent.state import (AgentState, _STATE_SAVE_LOCK, save_state, load_state,
    commit_state_credentials, credential_revision)
from sc2tools_agent.agent_credentials import CredentialIntent
from .test_agent_state_credentials import synthetic_state_io
from sc2tools_agent.sync_retry import replay_ticket, publish_owned_toons, publish_local_hint
from sc2tools_agent.health import HealthFacts
from sc2tools_agent.sync_report import SyncReportTracker
from tests.test_upload_queue import _cfg, _game, _StubApi
from sc2tools_agent.uploader.queue import UploadQueue

OWN, OTHER = "2-S2-1-42", "1-S2-1-43"


def engine():
    pipeline.bootstrap_analyzer_path()
    from core import sc2_replay_parser
    return sc2_replay_parser


def players(same_name=False):
    return [SimpleNamespace(name="Other", toon_handle=OTHER, pid=1),
            SimpleNamespace(name="Other" if same_name else "Current", toon_handle=OWN, pid=2)]


@pytest.mark.parametrize("same_name", [False, True])
def test_exact_second_saved_toon_wins_before_perspective_even_when_hint_matches_opponent(same_name):
    parser = engine(); raw = SimpleNamespace(players=players(same_name))
    assert parser._resolve_me_opp(raw, "Other")[0].pid == 1  # unchanged unscoped/browser policy
    with parser.owned_toon_scope(("3-S2-1-999", OWN)):
        me, opp = parser._resolve_me_opp(raw, "Other")
        assert (me.pid, opp.pid) == (2, 1)
    assert parser._resolve_me_opp(raw, "Other")[0].pid == 1


def test_both_owned_unknown_and_ambiguous_fresh_name_fail_closed():
    parser = engine(); raw = SimpleNamespace(players=players(True))
    for toons in [(OWN, OTHER), (), None]:
        with parser.owned_toon_scope(toons):
            assert parser._resolve_me_opp(raw, "Other") == (None, None)


def test_owned_scopes_are_nested_thread_local_and_exception_safe():
    parser = engine(); raw = SimpleNamespace(players=players())
    def resolve(toon):
        with parser.owned_toon_scope((toon,)):
            with pytest.raises(RuntimeError), parser.owned_toon_scope(()):
                raise RuntimeError("synthetic")
            return parser._resolve_me_opp(raw, "Other")[0].toon_handle
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(resolve, (OWN, OTHER))) == [OWN, OTHER]
    assert parser._OWNED_TOONS.get() is None


def bare(tmp_path, state):
    instance = watcher.ReplayWatcher.__new__(watcher.ReplayWatcher)
    instance._state, instance._cfg, instance._stop = state, _cfg(tmp_path), threading.Event()
    instance._upload = UploadQueue(cfg=instance._cfg, state=state, api=_StubApi())
    instance._finish_replay = Mock(); instance._clear_settle_failure = Mock()
    instance._notify_skipped = Mock(); instance._notify_unresolved = Mock()
    instance._queue_automatic_capture = Mock(return_value=False)
    instance._sync_filter = lambda: SimpleNamespace(replay_in_range=lambda _: True)
    instance._analyzer_unavailable = False; instance._uses_processes = False
    instance._process_crash_strikes = 0
    return instance


@pytest.mark.parametrize("mode", ["thread", "process"])
def test_both_parse_paths_use_second_toon_and_not_stale_other_player_hint(tmp_path, monkeypatch, mode):
    parser = engine(); state = AgentState(user_id="owner", device_token="synthetic")
    ticket = replay_ticket(state)
    with _STATE_SAVE_LOCK: publish_owned_toons(state, {"displayName": "Other", "pulseIds": ["3-S2-1-999", OWN]}, ticket)
    ticket = replay_ticket(state); instance = bare(tmp_path, state)
    job = _game(tmp_path, "p.SC2Replay")
    raw = SimpleNamespace(players=players())
    def parse(path, **_kwargs):
        def deep(_path, hint):
            me, _opp = parser._resolve_me_opp(raw, hint)
            job.game.my_toon_handle = me.toon_handle
            job.game.my_build = "perspective-pid-" + str(me.pid)
            return job.game
        return pipeline._parse_with_preset_policy(deep, path, "Other", None), None
    monkeypatch.setattr(watcher, "_wait_for_file_ready", lambda *_: True)
    if mode == "thread":
        monkeypatch.setattr(watcher, "parse_replay_for_cloud_ex", parse)
        instance._handle_replay(job.file_path, ticket=ticket)
    else:
        monkeypatch.setattr(pipeline, "parse_replay_for_cloud_ex", parse)
        monkeypatch.setattr(watcher, "_install_worker_log_handler", lambda *_: None)
        result = watcher._parse_in_worker(str(job.file_path), str(tmp_path), ticket.toons, ticket.hint)
        future = Future(); future.set_result(result)
        instance._on_worker_done(future, str(job.file_path), ticket)
    queued = instance._upload._q.get_nowait()[2].game
    assert queued.my_toon_handle == OWN and queued.my_build == "perspective-pid-2"
    assert pipeline._OWNED_TOONS.get() is None and pipeline._NATIVE_IDENTITY_SCOPE.get() is False


@pytest.mark.parametrize("toons,hint", [((), None), (None, None), (None, "Current"), ((OWN, OTHER), "Other")])
def test_native_scope_never_uses_old_disk_or_folder_cache_promotion(tmp_path, monkeypatch, toons, hint):
    parser = engine(); raw = SimpleNamespace(players=players())
    seen = []
    def deep(_path, handle):
        seen.append(handle)
        me, opp = parser._resolve_me_opp(raw, handle)
        # Returning no opponent stops the real pipeline before expensive deep
        # output builders; its recovery/cache branches still execute normally.
        return SimpleNamespace(me=me, opponent=None, all_players=[SimpleNamespace(name=p.name, handle=p.toon_handle) for p in raw.players], is_ai_game=False)
    monkeypatch.setattr(parser, "parse_deep", deep)
    read = Mock(return_value="Other"); path = Mock(return_value=OTHER); write = Mock()
    monkeypatch.setattr(pipeline, "_read_player_handle", read)
    monkeypatch.setattr(pipeline, "_toon_handle_from_path", path)
    monkeypatch.setattr("sc2tools_agent.player_handle.write_cache", write)
    with pipeline.owned_replay_identity(toons, hint):
        assert pipeline.parse_replay_for_cloud_ex(tmp_path / "p.SC2Replay", state_dir=tmp_path) == (None, "player_unresolved")
    path.assert_not_called(); write.assert_not_called()
    if toons is None:
        assert seen == [hint or ""] and not read.called


@pytest.mark.parametrize("live", [False, True])
def test_queued_thread_captures_owner_at_admission_before_repair(tmp_path, monkeypatch, live):
    state = AgentState(user_id="a", device_token="a-token")
    with _STATE_SAVE_LOCK: publish_owned_toons(state, {"displayName": "Other"}, replay_ticket(state))
    instance = bare(tmp_path, state); calls = []
    class HeldExecutor:
        def submit(self, fn, *args, **kwargs): calls.append((fn, args, kwargs))
    instance._executor = instance._live_executor = instance._sweep_live_executor = HeldExecutor()
    instance._executor_lock = instance._sweep_live_lock = threading.Lock()
    instance._sweep_live_paths = {}
    parse = Mock(); monkeypatch.setattr(watcher, "parse_replay_for_cloud_ex", parse)
    instance._submit_parse(tmp_path / "p.SC2Replay", live=live)
    with _STATE_SAVE_LOCK:
        state.user_id, state.device_token, state._owner_epoch = "b", "b-token", object()
        # B has completed its own profile refresh before A's queued work is
        # released. An implementation that re-snapshots at worker start must
        # fail here rather than being accidentally masked by B's unknown gate.
        publish_owned_toons(state, {"displayName": "Current", "pulseIds": [OWN]}, replay_ticket(state))
    assert replay_ticket(state).toons == (OWN,)
    fn, args, kwargs = calls[0]; fn(*args, **kwargs)
    parse.assert_not_called(); assert instance._upload._q.empty() and not state.uploaded


def test_current_local_settings_hint_and_profile_empty_hint_do_not_cross_repair(tmp_path):
    parser = engine(); state = AgentState(user_id="a", device_token="a-token")
    ticket = replay_ticket(state)
    with _STATE_SAVE_LOCK: publish_owned_toons(state, {"displayName": "Other", "pulseIds": []}, ticket)
    publish_local_hint(state, "Current")
    ticket = replay_ticket(state); assert ticket.toons is None and ticket.hint == "Current"
    with parser.owned_toon_scope(ticket.toons):
        assert parser._resolve_me_opp(SimpleNamespace(players=players()), ticket.hint)[0].pid == 2
    with _STATE_SAVE_LOCK: state.user_id, state.device_token, state._owner_epoch = "b", "b-token", object()
    assert replay_ticket(state).toons == () and replay_ticket(state).hint is None
    with _STATE_SAVE_LOCK: publish_owned_toons(state, {"pulseIds": []}, replay_ticket(state))
    assert replay_ticket(state).toons is None and replay_ticket(state).hint is None
    with parser.owned_toon_scope(None):
        assert parser._resolve_me_opp(SimpleNamespace(players=players()), "") == (None, None)


def test_old_owner_candidates_and_held_callback_cannot_repopulate_new_report(tmp_path):
    state = AgentState(user_id="a", device_token="a-token")
    ticket = replay_ticket(state); ui = SimpleNamespace(sync_report=SyncReportTracker())
    for number in range(3):
        path = str(tmp_path / str(number)); state.uploaded[path] = "skipped:player_unresolved"
        runner._record_sync_unresolved(ui, state, path, [("Private A", OWN)], ticket)
    owner = (ticket.owner, ticket.token, ticket.epoch)
    assert ui.sync_report.report(HealthFacts(), state.uploaded, owner=owner)["unresolvedNames"]
    with _STATE_SAVE_LOCK: state.user_id, state.device_token, state._owner_epoch = "b", "b-token", object()
    new = replay_ticket(state); ui.sync_report.set_owner((new.owner, new.token, new.epoch))
    runner._record_sync_unresolved(ui, state, "held", [("Private A", OWN)], ticket)
    assert "unresolvedNames" not in ui.sync_report.report(HealthFacts(), state.uploaded, owner=(new.owner, new.token, new.epoch))
    assert "unresolvedNames" not in ui.sync_report.report(HealthFacts(), state.uploaded, owner=owner)


def test_successful_contact_recovers_unknown_profile_once_without_restart(tmp_path, monkeypatch):
    from sc2tools_agent.pairing.recovery import RuntimeRecovery
    state = AgentState(user_id="b", device_token="b-token")
    entered, release, published = threading.Event(), threading.Event(), threading.Event()
    def profile(**kwargs):
        assert kwargs == {"interactive": True}
        entered.set(); assert release.wait(3)
        return {"displayName": "Other", "pulseIds": [OWN]}
    api = SimpleNamespace(get_profile=profile)
    cell = SimpleNamespace(api=api, upload=Mock())
    recovery = RuntimeRecovery(cell=cell, cfg=_cfg(tmp_path), state=state, ui=Mock(), stop_event=threading.Event())
    from sc2tools_agent.pairing import recovery as recovery_module
    original = recovery_module.publish_owned_toons
    def publish(*args):
        result = original(*args); published.set(); return result
    monkeypatch.setattr(recovery_module, "publish_owned_toons", publish)
    assert replay_ticket(state).toons == ()
    recovery.connected(); assert entered.wait(3)
    recovery.connected(); assert recovery._identity_lock.locked()
    release.set(); assert published.wait(3)
    assert replay_ticket(state).toons == (OWN,)
    recovery.connected()  # known profile does not refetch


def test_same_owner_explicit_override_survives_restart_refresh_and_retry_but_not_owner_change(tmp_path, monkeypatch):
    from sc2tools_agent.player_handle import read_settings_hint, refresh_from_cloud, write_cache
    from sc2tools_agent.sync_retry import SyncRetryController, current_identity_source
    state = AgentState(user_id="a", device_token="a-token")
    write_cache(tmp_path, "Current", owner="a", source="settings")
    # A restart creates a new runtime epoch while retaining the private source.
    ticket = replay_ticket(state)
    api = SimpleNamespace(get_profile=lambda **_: {"displayName": "Other", "pulseIds": []})
    assert refresh_from_cloud(api, tmp_path, owner="a", current_guard=lambda: ticket.current(state),
        on_profile=lambda profile: publish_owned_toons(state, profile, ticket)) == "Current"
    assert replay_ticket(state).hint == "Current" and current_identity_source(state, tmp_path) == "settings"
    cell = SimpleNamespace(upload=Mock(), watcher=Mock(), recent_history=Mock())
    cell.upload.retry_sync_reason.return_value = []
    # Use a function descriptor accepting ApiClient self for the mocked HTTP.
    monkeypatch.setattr("sc2tools_agent.api_client.ApiClient.get_profile", lambda *_a, **_k: {"displayName": "Other", "pulseIds": []})
    controller = SyncRetryController(cfg=_cfg(tmp_path), state=state, cell=cell, stop_event=threading.Event(), clock=lambda: 1.0)
    assert controller.handle({"reason": "player_unresolved", "expiresAt": 2000}, "a-token", lambda: True) == ("no_matches", 0)
    assert replay_ticket(state).hint == "Current" and read_settings_hint(tmp_path, "a") == "Current"
    with _STATE_SAVE_LOCK: state.user_id, state.device_token, state._owner_epoch = "b", "b-token", object()
    new = replay_ticket(state)
    refresh_from_cloud(api, tmp_path, owner="b", current_guard=lambda: new.current(state),
        on_profile=lambda profile: publish_owned_toons(state, profile, new))
    assert replay_ticket(state).hint == "Other" and read_settings_hint(tmp_path, "b") is None


def test_legacy_cache_never_gets_settings_provenance_without_explicit_reentry(tmp_path):
    from sc2tools_agent.player_handle import read_settings_hint, write_cache
    write_cache(tmp_path, "Old A")
    assert read_settings_hint(tmp_path, "b") is None
    state = AgentState(user_id="b", device_token="b-token")
    # Unrelated Settings writes use KEEP (None) and cannot attribute the cache.
    monkey_payload = runner.SettingsPayload(background_import_speed="gentle")
    # Exercise only the private intent helpers here; full GUI dirty/form-origin
    # routing is covered by the native Settings regression below.
    assert monkey_payload.player_handle is None and replay_ticket(state).toons == ()
    write_cache(tmp_path, "Current", owner="b", source="settings")
    publish_local_hint(state, "Current")
    assert replay_ticket(state).hint == "Current" and read_settings_hint(tmp_path, "b") == "Current"
    publish_local_hint(state, "")
    assert replay_ticket(state).toons == () and replay_ticket(state).hint is None


def test_capture_rechecks_owner_after_recording_and_preserves_exact_scope(tmp_path, monkeypatch):
    from sc2tools_agent import replay_capture
    state = AgentState(user_id="a", device_token="a-token", replay_capture_enabled=True)
    publish_owned_toons(state, {"pulseIds": [OWN]}, replay_ticket(state))
    ticket = replay_ticket(state); instance = bare(tmp_path, state)
    instance._activity_gate = SimpleNamespace(busy=False)
    instance._capture_notice = Mock()
    job = _game(tmp_path, "capture.SC2Replay")
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", lambda *_: True)
    parse = Mock(); monkeypatch.setattr(watcher, "parse_replay_for_cloud_ex", parse)
    def capture(*_a, **_k):
        with _STATE_SAVE_LOCK: state.user_id, state.device_token, state._owner_epoch = "b", "b-token", object()
    monkeypatch.setattr(replay_capture, "capture_exact_replay", capture)
    instance._capture_and_upload(job.file_path, job.game, ticket=ticket)
    parse.assert_not_called(); assert instance._upload._q.empty() and not state.uploaded


def test_capture_reparse_keeps_owned_toon_perspective_without_enabling_capture(tmp_path, monkeypatch):
    from sc2tools_agent import replay_capture
    state = AgentState(user_id="a", device_token="a-token", replay_capture_enabled=False)
    publish_owned_toons(state, {"pulseIds": [OWN]}, replay_ticket(state))
    ticket = replay_ticket(state); instance = bare(tmp_path, state)
    instance._activity_gate = SimpleNamespace(busy=False)
    instance._capture_notice = Mock()
    job = _game(tmp_path, "capture.SC2Replay")
    capture = Mock(); monkeypatch.setattr(replay_capture, "capture_exact_replay", capture)
    monkeypatch.setattr(replay_capture, "replay_capture_enabled", lambda *_: False)
    def parse(*_a, **_k):
        assert pipeline._OWNED_TOONS.get() == (OWN,)
        job.game.my_toon_handle = OWN
        return job.game, None
    monkeypatch.setattr(watcher, "parse_replay_for_cloud_ex", parse)
    instance._has_engine_playback = lambda game: game is job.game
    instance._capture_and_upload(job.file_path, job.game, ticket=ticket)
    capture.assert_not_called()
    assert instance._upload._q.get_nowait()[2].game.my_toon_handle == OWN


def test_queued_a_settings_edit_cannot_publish_after_b_or_aba_repair(tmp_path, synthetic_state_io):
    from sc2tools_agent.player_handle import read_settings_hint, write_cache, read_cache
    from sc2tools_agent.sync_retry import settings_identity_origin
    from tests.test_runner_save_settings import _cell
    state = AgentState(user_id="a", device_token="a-token")
    save_state(tmp_path, state)
    initial_revision = credential_revision(state, "device")
    origin = settings_identity_origin(state)
    payload = runner.SettingsPayload(player_handle="A pending edit", player_handle_origin=origin)
    write_cache(tmp_path, "B current", owner="b", source="settings")
    with _STATE_SAVE_LOCK:
        state._owner_epoch = epoch_b = object()
        state._owned_toons = None
        commit_state_credentials(tmp_path, state, device=CredentialIntent("set", "b-token"),
            expected_device_revision=credential_revision(state, "device"), expected_owner_epoch=epoch_b,
            device_owner=("b", state.paired_at))
    runner._handle_save_settings(_cfg(tmp_path), state, payload, _cell(), Mock())
    assert read_settings_hint(tmp_path, "b") == "B current" and read_cache(tmp_path) == "B current"
    assert load_state(tmp_path).device_token == "b-token" and credential_revision(state, "device") == initial_revision + 1
    with _STATE_SAVE_LOCK:
        state._owner_epoch = epoch_a = object()
        state._owned_toons = None
        commit_state_credentials(tmp_path, state, device=CredentialIntent("set", "a-token"),
            expected_device_revision=credential_revision(state, "device"), expected_owner_epoch=epoch_a,
            device_owner=("a", state.paired_at))
    runner._handle_save_settings(_cfg(tmp_path), state, payload, _cell(), Mock())
    assert read_settings_hint(tmp_path, "a") is None and read_cache(tmp_path) == "B current"
    assert origin[1] is not epoch_b and epoch_b is not epoch_a and origin[1] is not epoch_a
    loaded = load_state(tmp_path)
    assert (loaded.user_id, loaded.device_token) == ("a", "a-token")
    assert credential_revision(state, "device") == initial_revision + 2
    raw = (tmp_path / "agent.json").read_bytes()
    assert b"a-token" not in raw and b"b-token" not in raw


def test_explicit_clear_requests_guarded_profile_recovery_and_keeps_exact_ids(tmp_path):
    from sc2tools_agent.sync_retry import settings_identity_origin
    from tests.test_runner_save_settings import _cell
    state = AgentState(user_id="a", device_token="a-token")
    publish_local_hint(state, "Current")
    cell = _cell(); cell.recovery = Mock()
    runner._handle_save_settings(_cfg(tmp_path), state,
        runner.SettingsPayload(player_handle="", player_handle_origin=settings_identity_origin(state)), cell, Mock())
    assert replay_ticket(state).toons == () and replay_ticket(state).hint is None
    cell.recovery.refresh_unknown_identity.assert_called_once_with(force=True)
    publish_owned_toons(state, {"pulseIds": [OWN]}, replay_ticket(state))
    publish_local_hint(state, "")
    assert replay_ticket(state).toons == (OWN,)


def test_heartbeat_never_sends_held_private_report_under_replacement_api(tmp_path):
    from sc2tools_agent.heartbeat import Heartbeat
    api_a = SimpleNamespace(device_token="a-token", _post=Mock(return_value={}))
    api_b = SimpleNamespace(device_token="b-token", _post=Mock(return_value={}))
    success = Mock()
    def report(api):
        assert api is api_a
        beat._api = api_b  # replacement while the old provider is held
        return {"unresolvedNames": [{"name": "Private A", "toonHandle": OWN, "count": 3}]}
    provider = Mock(); provider.for_api = report
    beat = Heartbeat(api_a, sync_provider=provider, on_success=success)
    beat._send_one()
    assert api_a._post.call_args.kwargs["body"]["sync"]["unresolvedNames"][0]["name"] == "Private A"
    api_b._post.assert_not_called(); success.assert_not_called()
    from sc2tools_agent.health import HealthMonitor
    ui = runner._Multiplexer(Mock(), health=HealthMonitor())
    state = AgentState(user_id="b", device_token="b-token")
    current = runner._sync_report_provider(ui, state, SimpleNamespace(state_dir=tmp_path, replay_folder=None))
    assert current.for_api(api_a) == {}
