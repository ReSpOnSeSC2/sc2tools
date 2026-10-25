import copy
import json
import os
import threading
import time
from types import SimpleNamespace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

import pytest

from sc2tools_agent.streaming.cloud_client import CloudGoogleAPI, CloudStreamError, CloudStreamingClient
from sc2tools_agent.streaming.service import DEFAULT_CONFIG, StreamService
from sc2tools_agent.streaming.youtube_pair_backend import PairBackend, atomic_json


class Identity:
    def __init__(self):
        self.value = ("https://api.sc2tools.com", "synthetic-token-A", "account-A")

    def switch(self, account="B", token=None):
        self.value = (self.value[0], token or "synthetic-token-" + account, "account-" + account)


class Transport:
    def __init__(self):
        self.calls = []
        self.channel = "saved-channel"
        self.before_response = None

    def __call__(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        if self.before_response:
            self.before_response()
        if url.endswith("/status"):
            value = {"platforms": [{"platform": "youtube", "streamingReady": True, "platformUserId": self.channel}]}
        elif url.endswith("/catalog"):
            value = {"channel": {"id": self.channel, "title": "Synthetic private channel"}, "streams": [
                {"id": "saved-horizontal", "title": "Horizontal key", "channel": self.channel},
                {"id": "saved-portrait", "title": "Portrait key", "channel": self.channel}]}
        elif url.endswith("/obs-connection"):
            value = {"stream_id": "saved-horizontal", "server_url": "rtmps://a.rtmps.youtube.com/live2",
                "stream_key": "synthetic-private-key-A"}
        else:
            raise AssertionError("Unexpected synthetic request " + url)
        return SimpleNamespace(status_code=200, json=lambda: value)


class Reader:
    def __call__(self, names):
        return {"horizontal": False, "portrait": False}

    def close(self):
        pass


def cloud_client(identity, transport):
    return CloudStreamingClient(lambda: identity.value[:2], identity_provider=lambda: identity.value, transport=transport)


def configured_service(tmp_path, identity, transport, *, legacy=False, persisted=False, mode="sc2tools"):
    cloud = cloud_client(identity, transport)
    config = copy.deepcopy(DEFAULT_CONFIG)
    config.update(account_mode=mode, runtime_enabled=True, expected_channel_id="saved-channel",
        existing_reusable_keys_confirmed=True, user_approved_separate_events=True,
        streams={scope: {"reusable_stream_id": "saved-" + scope, "privacy": "unlisted", "made_for_kids": False}
            for scope in ("horizontal", "portrait")})
    config["metadata"]["title"] = "Synthetic owner A title"
    if not legacy:
        config["cloud_account_key"] = cloud.context()["accountKey"]
    if persisted:
        (tmp_path / "streaming").mkdir(exist_ok=True)
        atomic_json(tmp_path / "streaming" / "youtube-button-helper.config.private.json", config)
        service = StreamService(tmp_path, lambda: {}, output_reader=Reader(), cloud_client=cloud)
    else:
        backend = PairBackend(tmp_path, memory=True, config=config)
        service = StreamService(tmp_path, lambda: {}, backend=backend, output_reader=Reader(), cloud_client=cloud)
        service.account_mode = mode
    service.backend.connected = service.backend.writes_enabled = True
    service.backend.api = CloudGoogleAPI(cloud, lambda: service.backend.config["expected_channel_id"])
    service.catalog = {"channels": [{"id": "saved-channel", "title": "Synthetic private channel A"}],
        "streams": [{"id": "saved-horizontal", "title": "Horizontal key"}, {"id": "saved-portrait", "title": "Portrait key"}]}
    service._publish()
    return service


@pytest.mark.parametrize("change_at", ["transport", "json"])
def test_cloud_discards_late_owner_response(change_at):
    identity = Identity()

    def transport(*args, **kwargs):
        if change_at == "transport":
            identity.switch()
        def read():
            if change_at == "json":
                identity.switch()
            return {"platforms": []}
        return SimpleNamespace(status_code=200, json=read)

    cloud = cloud_client(identity, transport)
    with pytest.raises(CloudStreamError) as failure:
        cloud.statuses()
    assert failure.value.pairing_changed is True
    assert "synthetic" not in str(failure.value)


def test_whole_operation_cannot_continue_under_new_credentials():
    identity, transport = Identity(), Transport()
    cloud = cloud_client(identity, transport)
    with pytest.raises(CloudStreamError) as failure:
        with cloud.operation():
            cloud.statuses()
            identity.switch()
            cloud.update_title("twitch", "Must not write")
    assert failure.value.pairing_changed is True
    assert len(transport.calls) == 1
    assert transport.calls[0][2]["headers"]["Authorization"] == "Bearer synthetic-token-A"


def test_service_multistep_title_action_stops_before_next_platform(tmp_path, monkeypatch):
    identity, transport = Identity(), Transport()
    service = configured_service(tmp_path, identity, transport)

    def dispatch(payload):
        service.cloud_client.statuses()
        identity.switch()
        return {"ok": True, "future_template_saved": True}

    monkeypatch.setattr(service.backend, "dispatch", dispatch)
    service.adapters["twitch"] = SimpleNamespace(update_title=lambda title: service.cloud_client.update_title("twitch", title))
    with pytest.raises(CloudStreamError):
        service.action({"action": "set_metadata", "title": "New title"})
    assert len(transport.calls) == 1
    assert service.adapters == {} and service.platform_status == {} and service.platform_results == {}
    assert service.backend.api is None and not service.backend.writes_enabled


def test_cached_status_masks_new_owner_without_waiting_for_inflight_request(tmp_path):
    identity, transport = Identity(), Transport()
    service = configured_service(tmp_path, identity, transport)
    entered, release = threading.Event(), threading.Event()
    errors = []

    def delayed():
        entered.set()
        assert release.wait(3)

    def work():
        try:
            service.action({"action": "fetch_obs_connection", "scope": "horizontal",
                "expected_channel_id": "saved-channel", "stream_id": "saved-horizontal"})
        except Exception as error:
            errors.append(error)

    transport.before_response = delayed
    worker = threading.Thread(target=work)
    worker.start()
    assert entered.wait(2)
    try:
        identity.switch()
        started = time.monotonic()
        state = service.status()
        assert time.monotonic() - started < 0.25
        assert state["accountKey"] == service.cloud_client.context()["accountKey"]
        assert state["catalog"] == {"channels": [], "streams": []}
        assert state["platforms"] == {} and state["platform_results"] == {}
        assert not state["configured"] and not state["youtube"]["connected"]
        assert state["configuration"]["channel_id"] is None
        assert "Synthetic owner A" not in str(state)
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive()
    assert len(errors) == 1 and errors[0].pairing_changed is True
    assert service.backend.api is None and service.adapters == {}
    assert service.status()["catalog"] == {"channels": [], "streams": []}


def test_same_account_token_rotation_and_repair_restore_saved_session(tmp_path):
    identity, transport = Identity(), Transport()
    service = configured_service(tmp_path, identity, transport, persisted=True)
    account_key = service.status()["accountKey"]
    connection_key = service.status()["connectionKey"]
    service.backend.state.update(pair={"phase": "complete"}, cloud_account_key=account_key)
    service.backend._save()
    identity.value = (identity.value[0], None, "account-A")
    assert not service.status()["configured"]
    identity.switch("A", "rotated-token-A")
    state = service.action({"action": "refresh_accounts"})
    assert state["accountKey"] == account_key and state["connectionKey"] != connection_key
    assert state["configured"] is True
    assert service.backend.state["pair"] == {"phase": "complete"}
    service.close()
    restarted = StreamService(tmp_path, lambda: {}, output_reader=Reader(), cloud_client=cloud_client(identity, transport))
    try:
        assert restarted.status()["configured"] is True
        assert restarted.backend.state["pair"] == {"phase": "complete"}
        assert restarted.backend.config["cloud_account_key"] == account_key
    finally:
        restarted.close()
    assert all(call[0] == "GET" for call in transport.calls)


def test_foreign_owner_restart_cannot_reuse_saved_setup_or_run_old_session(tmp_path, monkeypatch):
    identity, transport = Identity(), Transport()
    original = configured_service(tmp_path, identity, transport, persisted=True)
    owner = original.status()["accountKey"]
    original.backend.state.update(pair={"phase": "complete"}, cloud_account_key=owner)
    original.backend._save()
    original.close()
    identity.switch()
    restarted = StreamService(tmp_path, lambda: {}, output_reader=Reader(), cloud_client=cloud_client(identity, transport))
    try:
        assert restarted.status()["configured"] is False
        state = restarted.action({"action": "refresh_accounts"})
        assert state["catalog"]["channels"] and state["configured"] is False
        assert restarted.backend.config["cloud_account_key"] == owner
        assert restarted.backend.state["pair"] == {"phase": "complete"}
        ticks = []
        monkeypatch.setattr(restarted.backend, "runtime_tick", lambda outputs: ticks.append(outputs))
        restarted._runtime_tick()
        assert ticks == []
        with pytest.raises(ValueError, match="Save YouTube setup"):
            restarted.action({"action": "prepare"})
    finally:
        restarted.close()
    assert all(call[0] == "GET" for call in transport.calls)


@pytest.mark.parametrize("proven", [False, True])
def test_legacy_setup_requires_current_authorized_channel_proof(tmp_path, proven):
    identity, transport = Identity(), Transport()
    service = configured_service(tmp_path, identity, transport, legacy=True)
    if not proven:
        transport.channel = "different-owned-channel"
    assert service.status()["configured"] is False
    state = service.action({"action": "refresh_accounts"})
    assert state["configured"] is proven
    assert bool(service.backend.config.get("cloud_account_key")) is proven
    assert service.config_path.exists() is proven
    assert [call[0] for call in transport.calls] == ["GET", "GET"]


def test_explicit_foreign_setup_archives_old_recovery_without_cloud_creation(tmp_path):
    identity, transport = Identity(), Transport()
    service = configured_service(tmp_path, identity, transport, legacy=True, persisted=True)
    service.backend.state["pair"] = {"phase": "live", "entries": {"horizontal": {"broadcast_id": "old-broadcast"}}}
    service.backend._save()
    old_pair = copy.deepcopy(service.backend.state["pair"])
    transport.channel = "new-owned-channel"
    identity.switch()
    service.action({"action": "refresh_accounts"})
    service.action({"action": "configure_youtube", "channel_id": transport.channel,
        "horizontal_id": "saved-horizontal", "portrait_id": "saved-portrait", "privacy": "unlisted",
        "made_for_kids": False, "auto_rearm": True})
    archives = list(service.directory.glob("youtube-recovery.*.private.json"))
    assert len(archives) == 1
    assert json.loads(archives[0].read_text())["state"]["pair"] == old_pair
    assert service.backend.state["pair"] is None and service.backend.state["auto_rearm_armed"] is False
    assert service.backend.config["cloud_account_key"] == service.cloud_client.context()["accountKey"]
    assert all(call[0] == "GET" for call in transport.calls)
    service.close()
    restarted = StreamService(tmp_path, lambda: {}, output_reader=Reader(), cloud_client=cloud_client(identity, transport))
    try:
        assert restarted.backend.state["pair"] is None
        assert restarted.status()["configured"] is True
    finally:
        restarted.close()


def test_local_oauth_mode_does_not_reset_on_sc2tools_owner_change(tmp_path):
    identity, transport = Identity(), Transport()
    service = configured_service(tmp_path, identity, transport, mode="local")
    adapter = SimpleNamespace()
    service.adapters["twitch"] = adapter
    before = service.status()
    identity.switch()
    assert service.status() == before
    with service._cloud_operation():
        pass
    assert service.adapters["twitch"] is adapter
    assert service.backend.connected and service.backend.api is not None
    assert transport.calls == []


@pytest.fixture
def app():
    pytest.importorskip("PySide6")
    from PySide6 import QtGui, QtWidgets
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    for font in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
        QtGui.QFontDatabase.addApplicationFont("C:/Windows/Fonts/" + font)
    return app


def ui_state(owner):
    return {"account_mode": "sc2tools", "accountKey": owner, "connectionKey": owner + "-connection",
        "configured": True, "youtube": {"connected": True}, "metadata": {"title": owner},
        "configuration": {"channel_id": "same-channel", "horizontal_id": "same-horizontal", "portrait_id": "same-portrait"},
        "catalog": {"channels": [{"id": "same-channel", "title": owner}], "streams": [
            {"id": "same-horizontal", "title": "Horizontal"}, {"id": "same-portrait", "title": "Portrait"}]}}


def pump(app, predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while not predicate() and time.monotonic() < deadline:
        app.processEvents()
        time.sleep(0.01)
    app.processEvents()
    assert predicate()


def test_ui_late_secret_cannot_replace_new_owner_job_even_when_ids_match(app):
    from PySide6 import QtCore, QtWidgets
    from sc2tools_agent.ui.streams_page import build_streams_page
    state = ui_state("A")
    entered = {owner: threading.Event() for owner in ("A", "B")}
    release = {owner: threading.Event() for owner in ("A", "B")}
    finished = []

    def handler(payload):
        owner = payload["accountKey"]
        entered[owner].set()
        assert release[owner].wait(3)
        finished.append(owner)
        return {"accountKey": owner, "connectionKey": owner + "-connection", "obs_connection": {
            "scope": "horizontal", "expected_channel_id": "same-channel", "stream_id": "same-horizontal",
            "server_url": "rtmps://a.rtmps.youtube.com/live2", "stream_key": "private-" + owner}}

    widget = build_streams_page(None, provider=lambda: state, handler=handler, QtCore=QtCore, QtWidgets=QtWidgets)
    try:
        widget.show()
        widget.obs_toggle.setChecked(True)
        widget.fetch_obs_connection()
        assert entered["A"].wait(2)
        state.clear()
        state.update(ui_state("B"))
        started = time.monotonic()
        widget.refresh()
        assert time.monotonic() - started < 0.25
        assert not widget.busy and not widget.obs_key.text()
        widget.fetch_obs_connection()
        assert entered["B"].wait(2)
        release["A"].set()
        pump(app, lambda: "A" in finished)
        assert widget.busy and not widget.obs_key.text()
        release["B"].set()
        pump(app, lambda: widget.obs_key.text() == "private-B")
        assert widget.obs_copy_key.isEnabled()
    finally:
        for event in release.values():
            event.set()
        widget.timer.stop()
        widget.close()


@pytest.mark.parametrize("action", ["copy", "reveal"])
def test_secret_controls_recheck_owner_before_timer(app, monkeypatch, action):
    from PySide6 import QtCore, QtWidgets
    from sc2tools_agent.ui.streams_page import build_streams_page
    state = ui_state("A")
    widget = build_streams_page(None, provider=lambda: state, handler=lambda payload: {}, QtCore=QtCore, QtWidgets=QtWidgets)
    clipboard = []
    monkeypatch.setattr(QtWidgets.QApplication, "clipboard", lambda: SimpleNamespace(setText=clipboard.append))
    try:
        widget.obs_toggle.setChecked(True)
        widget._accept_obs_connection({"accountKey": "A", "connectionKey": "A-connection", "obs_generation": widget._obs_generation,
            "obs_connection": {**widget._obs_selection(), "server_url": "rtmps://a.rtmps.youtube.com/live2", "stream_key": "private-A"}})
        assert widget.obs_key.text() == "private-A"
        state.clear()
        state.update(ui_state("B"))
        if action == "copy":
            widget.copy_obs_detail(widget.obs_key, "Copied")
        else:
            widget.obs_reveal.setChecked(True)
        assert clipboard == [] and not widget.obs_key.text()
        assert not widget.obs_copy_key.isEnabled()
        assert widget.obs_key.echoMode() == QtWidgets.QLineEdit.Password
    finally:
        widget.timer.stop()
        widget.close()
