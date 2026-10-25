from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
import threading
from unittest.mock import Mock

import pytest

from sc2tools_agent.api_client import ApiClient, ApiError
from sc2tools_agent.build_checkin.controller import BuildCheckinController
from sc2tools_agent.build_checkin.models import CheckinPrefs
from sc2tools_agent.build_checkin.records import CARD_DONE, CardOp, LiveGame, LiveOp, PostgameCard
from sc2tools_agent.pairing.flow import ensure_paired
from sc2tools_agent.pairing.recovery import RuntimeRecovery
from sc2tools_agent.runner import _RuntimeCell, _handle_checkin_game_accepted
from sc2tools_agent.session_stats import session_account_key
from sc2tools_agent.state import AgentState, _STATE_SAVE_LOCK
from sc2tools_agent.uploader.queue import UploadQueue, _UploadSessionChanged
from tests.build_checkin_fakes import FakeCheckinApi, ManualExecutor, SyncExecutor
from tests.test_upload_account_fences import switch
from tests.test_upload_queue import _cfg, _game, _StubApi, _wait_for


@pytest.mark.parametrize("mode", ["single", "batch"])
def test_half_published_credentials_never_admit_old_api_with_new_owner(tmp_path, monkeypatch, mode):
    request = Mock()
    monkeypatch.setattr(ApiClient, "upload_game", request)
    monkeypatch.setattr(ApiClient, "upload_games_batch", request)
    state = AgentState(user_id="owner-b", device_token="token-b")
    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state,
        api=ApiClient("https://example.test", "token-a"))
    job = _game(tmp_path, "publication-gap.SC2Replay")
    with pytest.raises(_UploadSessionChanged):
        (upload_queue._upload_one(job) if mode == "single" else upload_queue._upload_batch([job]))
    request.assert_not_called()
    assert not state.uploaded and not state.path_by_game_id


def test_terminal_error_construction_race_cannot_reject_new_owner_cursor(tmp_path, monkeypatch):
    import sc2tools_agent.uploader.queue as queue_module

    entered, release = threading.Event(), threading.Event()
    state = AgentState(user_id="owner-a", device_token="a")
    rejected = Mock()
    original = queue_module._ServerRejectedError

    class PausedRejection(original):
        def __init__(self, message):
            entered.set()
            assert release.wait(3)
            super().__init__(message)

    class Api(_StubApi):
        def upload_games_batch(self, payloads):
            raise ApiError(400, "fixture rejected old request")

    monkeypatch.setattr(queue_module, "_ServerRejectedError", PausedRejection)
    upload_queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=Api(), on_failure=rejected)
    job = _game(tmp_path, "terminal-gap.SC2Replay")
    upload_queue.submit(job)
    upload_queue.start()
    replacement = _StubApi()
    try:
        assert entered.wait(2)
        switch(upload_queue, state, replacement)
        release.set()
        assert _wait_for(lambda: not upload_queue.is_pending(job.file_path))
        assert not state.uploaded and not replacement.calls
        rejected.assert_not_called()
    finally:
        release.set()
        upload_queue.stop()


def test_tagged_acceptance_is_rejected_after_actor_queue_account_switch(tmp_path):
    state = AgentState(user_id="owner-a", device_token="token-a")
    old_api = ApiClient("https://example.test", "token-a")
    new_api = ApiClient("https://example.test", "token-b")
    controller = BuildCheckinController(api=old_api, executor=SyncExecutor())
    cell = SimpleNamespace(api=old_api, build_checkin=controller)
    job = _game(tmp_path, "accepted-gap.SC2Replay")
    row = {"gameId": job.game.game_id,
        "_uploadAccountKey": session_account_key(old_api.base_url, old_api.device_token)}
    _handle_checkin_game_accepted(tmp_path, state, cell, job.file_path, job.game, job.game.game_id, row)
    assert not controller._inbox.empty()
    with _STATE_SAVE_LOCK:
        state.device_token, state.user_id = "token-b", "owner-b"
        cell.api, controller._api = new_api, new_api
    controller.run_pending()
    assert job.game.game_id not in controller._seen_game_ids
    assert not controller._games and not controller._state_gens


def test_tagged_acceptance_rejected_before_latest_race_or_controller_enqueue(tmp_path):
    state = AgentState(user_id="owner-b", device_token="token-b", last_known_race="Terran")
    cell = SimpleNamespace(api=ApiClient("https://example.test", "token-b"), build_checkin=Mock())
    job = _game(tmp_path, "runner-gap.SC2Replay")
    row = {"_uploadAccountKey": session_account_key("https://example.test", "token-a")}
    _handle_checkin_game_accepted(tmp_path, state, cell, job.file_path, job.game, job.game.game_id, row)
    assert state.last_known_race == "Terran"
    cell.build_checkin.on_game_accepted.assert_not_called()


def test_queued_checkin_http_and_results_are_bound_to_their_api():
    executor = ManualExecutor()
    first_api, replacement = Mock(), Mock()
    controller = BuildCheckinController(api=first_api, executor=executor)
    delivered = Mock()
    controller._call(delivered, "old", first_api.get_checkin_prefs)
    controller._api = replacement
    executor.run_all()
    controller.run_pending()
    first_api.get_checkin_prefs.assert_not_called()
    delivered.assert_not_called()
    controller._call(delivered, "queued-result", replacement.get_checkin_prefs)
    executor.run_all()
    controller._api = first_api
    controller.run_pending()
    delivered.assert_not_called()


@pytest.mark.parametrize("replacement_connection", [
    ("https://example.test", None),
    ("https://replacement.example.test", "token-a"),
    ("https://example.test", "token-b"),
])
def test_queued_checkin_acceptance_http_and_results_reject_unpublished_connection_changes(replacement_connection):
    first = FakeCheckinApi()
    first.base_url, first.device_token = "https://example.test", "token-a"
    connection = [first.base_url, first.device_token]
    executor = ManualExecutor()
    controller = BuildCheckinController(api=first, executor=executor,
        connection_provider=lambda: tuple(connection))
    row = {"_uploadAccountKey": session_account_key(*connection)}
    controller.on_game_accepted(None, object(), "old-game", row)
    request, delivered = Mock(), Mock()
    controller._call(delivered, "old", request)
    connection[:] = replacement_connection
    controller.run_pending()
    executor.run_all()
    assert "old-game" not in controller._seen_game_ids
    request.assert_not_called()
    delivered.assert_not_called()

    connection[:] = [first.base_url, first.device_token]
    controller._call(delivered, "queued-result", request)
    executor.run_all()
    connection[:] = replacement_connection
    controller.run_pending()
    delivered.assert_not_called()


def owned_checkin_fixture():
    api = FakeCheckinApi()
    api.base_url, api.device_token = "https://example.test", "token-a"
    identity = [api.base_url, api.device_token, "owner-a"]
    executor = ManualExecutor()
    controller = BuildCheckinController(api=api, executor=executor,
        identity_provider=lambda: tuple(identity), prefs=CheckinPrefs())
    game = LiveGame("game-key", 1000, 0, game_id="game-a", my_race="Protoss", opp_race="Zerg")
    game.op_inflight = LiveOp("register")
    game.live_read_inflight = game.live_refetch = game.resend_inflight = game.scouting_fetching = True
    card = PostgameCard("card-a", 1, 0, game.game_key, game_id="game-a", notes="private draft")
    card.op_inflight = CardOp("notes", notes=card.notes)
    card.busy = card.state_fetching = card.opponent_note_busy = True
    controller._games[game.game_key] = game
    controller._cards[card.card_id] = card
    return controller, executor, api, identity, game, card


def test_same_owner_relink_releases_all_slots_preserves_drafts_and_retries_with_new_api():
    controller, executor, first, identity, game, card = owned_checkin_fixture()
    controller._handle_refresh_prefs(True)
    controller._ensure_options("PvZ")
    identity[1] = None
    controller.on_connection_changed()
    controller.run_pending()
    assert not controller._prefs_read_inflight and not controller._prefs_write_inflight
    assert not controller._options_inflight
    assert not game.live_read_inflight and not game.live_refetch and not game.resend_inflight and not game.scouting_fetching
    assert game.op_inflight is None and card.op_inflight is None
    assert not card.busy and not card.state_fetching and not card.opponent_note_busy
    assert card.notes == "private draft" and card.ops and game.ops
    second = FakeCheckinApi()
    second.base_url, second.device_token = first.base_url, "token-renewed"
    controller._api, identity[1] = second, second.device_token
    controller.on_connection_changed()
    controller.run_pending()
    assert controller._prefs_read_inflight and card.op_inflight is not None
    executor.run(0)
    controller.run_pending()
    assert controller._prefs_read_inflight and card.op_inflight is not None
    executor.run_all()
    controller.run_pending()
    assert not controller._prefs_read_inflight and not card.busy and card.op_inflight is None
    assert second.calls_to("put_game_intent")
    assert second.calls_to("put_game_intent")[0][0] == ("game-a", {"action": "notes", "notes": "private draft"})
    assert not first.calls


def test_foreign_relink_clears_old_cards_cached_options_and_queued_writes():
    controller, executor, first, identity, game, card = owned_checkin_fixture()
    controller._handle_refresh_prefs(True)
    controller._ensure_options("PvZ")
    controller._prefs_write_pending = CheckinPrefs(enabled=False)
    controller._post(controller._handle_set_prefs, {"enabled": False})
    identity[1] = None
    controller.on_connection_changed()
    controller.run_pending()
    second = FakeCheckinApi()
    second.base_url, second.device_token = first.base_url, "token-b"
    controller._api = second
    identity[1:] = [second.device_token, "owner-b"]
    controller.on_connection_changed()
    controller.run_pending()
    executor.run_all()
    controller.run_pending()
    assert not controller._games and not controller._cards and not controller._options
    assert controller._prefs_write_pending is None and not controller._prefs_write_inflight
    assert not second.calls_to("put_game_intent") and not second.calls_to("put_live_intent")
    assert not second.calls_to("put_checkin_prefs") and not first.calls


def test_completed_cards_remain_terminal_across_same_owner_relink():
    controller, executor, first, identity, game, card = owned_checkin_fixture()
    card.state = CARD_DONE
    card.ops.append(CardOp("confirm", build_key="old-confirmed-build", final=True))
    identity[1] = None
    controller.on_connection_changed()
    controller.run_pending()
    assert card.state == CARD_DONE and not card.undecided
    second = FakeCheckinApi()
    second.base_url, second.device_token = first.base_url, "token-renewed"
    controller._api, identity[1] = second, second.device_token
    controller.on_connection_changed()
    controller.run_pending()
    executor.run_all()
    controller.run_pending()
    assert card.state == CARD_DONE and not card.undecided
    assert not second.calls_to("put_game_intent") and not card.ops


def test_linked_user_input_keeps_captured_api_if_owner_changes_after_admission():
    controller, executor, first, identity, game, card = owned_checkin_fixture()
    card.busy = False
    card.op_inflight = None
    card.ops.clear()
    second = FakeCheckinApi()
    second.base_url, second.device_token = first.base_url, "token-b"
    original = controller._handle_confirm

    def switch_then_confirm(*args):
        with _STATE_SAVE_LOCK:
            controller._api = second
            identity[1:] = [second.device_token, "owner-b"]
        original(*args)

    controller._handle_confirm = switch_then_confirm
    controller.confirm(card.card_id, "private-a", "private A note")
    controller.run_pending()
    executor.run_all()
    controller.run_pending()
    assert not second.calls_to("put_game_intent") and not first.calls


def test_pairing_publishes_credentials_and_save_as_one_short_transaction(tmp_path, monkeypatch):
    state = AgentState()
    entered, release, reader_started, observed = (threading.Event() for _ in range(4))
    stop = threading.Event()
    instant = datetime.now(timezone.utc)

    class Api:
        def start_pairing(self):
            assert not _STATE_SAVE_LOCK._is_owned()
            return {"code": "123456", "expiresAt": (instant + timedelta(minutes=5)).isoformat()}

        def poll_pairing(self, code):
            assert not _STATE_SAVE_LOCK._is_owned()
            return {"status": "ready", "deviceToken": "token-a", "userId": "owner-a"}

    def save(directory, current):
        assert _STATE_SAVE_LOCK._is_owned()
        entered.set()
        assert release.wait(3)

    monkeypatch.setattr("sc2tools_agent.pairing.flow.save_state", save)
    paired = []
    worker = threading.Thread(target=lambda: paired.append(ensure_paired(cfg=_cfg(tmp_path), state=state,
        api=Api(), on_code=lambda code: None, stop_event=stop, now=lambda: instant)))
    values = []

    def read():
        reader_started.set()
        with _STATE_SAVE_LOCK:
            values.append((state.device_token, state.user_id, state.paired_at))
        observed.set()

    reader = threading.Thread(target=read)
    worker.start()
    try:
        assert entered.wait(2)
        reader.start()
        assert reader_started.wait(2)
        assert not observed.wait(.05)
    finally:
        release.set()
        stop.set()
        worker.join(3)
        reader.join(3)
    assert paired == [True]
    assert values == [("token-a", "owner-a", instant.isoformat())]


def test_failed_pairing_publication_restores_old_credentials(tmp_path, monkeypatch):
    state = AgentState(user_id="previous-owner", paired_at="previous-pairing")
    stop = threading.Event()
    instant = datetime.now(timezone.utc)
    api = Mock()
    api.start_pairing.return_value = {"code": "123456", "expiresAt": (instant + timedelta(minutes=5)).isoformat()}
    api.poll_pairing.return_value = {"status": "ready", "deviceToken": "new-token", "userId": "new-owner"}

    def save(directory, current):
        stop.set()
        raise OSError("fixture write failed")

    monkeypatch.setattr("sc2tools_agent.pairing.flow.save_state", save)
    assert not ensure_paired(cfg=_cfg(tmp_path), state=state, api=api,
        on_code=lambda code: None, stop_event=stop, now=lambda: instant)
    assert (state.device_token, state.user_id, state.paired_at) == (None, "previous-owner", "previous-pairing")


def test_recovery_publishes_api_replacements_under_lock_then_starts_transport_outside(tmp_path, monkeypatch):
    state = AgentState(user_id="owner-a", device_token="old")
    cell = _RuntimeCell()
    cell.gui = object()
    cell.api = ApiClient("https://example.test", "old")
    cell.upload = UploadQueue(cfg=_cfg(tmp_path), state=state, api=cell.api)
    cell.heartbeat = SimpleNamespace(_api=cell.api)
    cell.import_ctl = SimpleNamespace(_api=cell.api)
    cell.build_checkin = SimpleNamespace(_api=cell.api)
    old_socket, new_socket = Mock(), Mock()
    cell.socket_client = old_socket
    paired = threading.Event()

    def pair(**kwargs):
        assert not _STATE_SAVE_LOCK._is_owned()
        with _STATE_SAVE_LOCK:
            state.device_token = "new"
        return True

    def rebuild(token):
        assert _STATE_SAVE_LOCK._is_owned()
        assert token == "new"
        assert cell.api is cell.upload._api is cell.heartbeat._api is cell.import_ctl._api is cell.build_checkin._api
        return new_socket

    def unlocked(*args):
        assert not _STATE_SAVE_LOCK._is_owned()

    old_socket.stop.side_effect = unlocked
    old_socket.with_device_token.side_effect = rebuild
    new_socket.set_session_enabled.side_effect = unlocked
    new_socket.start.side_effect = unlocked
    ui = Mock()
    ui.on_paired.side_effect = lambda user_id: paired.set()
    monkeypatch.setattr("sc2tools_agent.pairing.recovery.ensure_paired", pair)
    recovery = RuntimeRecovery(cell=cell, cfg=_cfg(tmp_path), state=state, ui=ui, stop_event=threading.Event())
    recovery.link_again()
    assert paired.wait(3)
    assert cell.api.device_token == "new" and cell.socket_client is new_socket
    new_socket.start.assert_called_once()
