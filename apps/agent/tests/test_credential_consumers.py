"""Held synthetic work cannot borrow a later login's credentials."""
import threading
from types import SimpleNamespace
from unittest.mock import Mock
from pathlib import Path

import pytest

from sc2tools_agent.api_client import ApiClient
from sc2tools_agent.import_controller import ImportController
from sc2tools_agent.live.transport import CloudTransport, OverlayBackendTransport
from sc2tools_agent.pairing.recovery import RuntimeRecovery
from sc2tools_agent.state import _STATE_SAVE_LOCK
from sc2tools_agent.state import AgentState
from sc2tools_agent.sync_retry import replay_ticket
from sc2tools_agent.uploader.queue import UploadQueue, TerminalUploadError
from sc2tools_agent.watcher import ReplayWatcher
from tests.test_import_controller import FakeApi, FakeWatcher
from tests.test_upload_queue import _cfg


class HeldExecutor:
    def __init__(self):
        self.jobs = []

    def submit(self, fn, *args):
        self.jobs.append((fn, args))

    def settle(self):
        while self.jobs:
            fn, args = self.jobs.pop(0)
            fn(*args)

    def shutdown(self, **_kwargs):
        self.jobs.clear()


@pytest.mark.parametrize("kind", ["cloud", "overlay"])
@pytest.mark.parametrize("aba", [False, True])
def test_queued_live_payload_never_uses_replacement_authentication(kind, aba, monkeypatch):
    old, new = ApiClient("https://example.test", "private-A"), ApiClient("https://example.test", "private-B")
    posts, executor = [], HeldExecutor()
    monkeypatch.setattr(ApiClient, "push_agent_live", lambda api, **body: posts.append((api.device_token, body["envelope"])))
    session = SimpleNamespace(post=lambda *args, **kwargs:
        (posts.append((kwargs["headers"]["x-sc2tools-agent-token"], kwargs["json"])), SimpleNamespace(status_code=200))[1])
    transport = (CloudTransport(api_client=old) if kind == "cloud" else
        OverlayBackendTransport(device_token=old.device_token, session=session))
    transport._executor.shutdown(wait=True)
    transport._executor = executor
    transport.push({"owner": "A private queued payload"})
    RuntimeRecovery._replace_transport(transport, new)
    if aba:
        RuntimeRecovery._replace_transport(transport, old)
    executor.settle()
    assert posts == []
    transport.push({"owner": "current fresh payload"})
    executor.settle()
    assert posts == [("private-A" if aba else "private-B", {"owner": "current fresh payload"})]
    transport.shutdown()


def test_held_import_folder_callback_cannot_send_paths_after_rotation():
    old, new = FakeApi(), FakeApi()
    entered, release = threading.Event(), threading.Event()
    local = []

    def folders():
        assert not _STATE_SAVE_LOCK._is_owned()
        entered.set()
        assert release.wait(3)
        return ["C:/owned-synthetic-private-A"]

    subject = ImportController(api=old, watcher=FakeWatcher(), list_folders=folders, on_change=local.append)
    worker = threading.Thread(target=lambda: subject.handle_pick_folder_request({}))
    worker.start()
    try:
        assert entered.wait(2)
        with _STATE_SAVE_LOCK:
            subject.replace_api(new)
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and old.host_info_calls == new.host_info_calls == local == []
    subject._list_folders = lambda: ["C:/owned-current-B"]
    subject.handle_pick_folder_request({})
    assert new.host_info_calls == [{"replayFolders": ["C:/owned-current-B"]}]


def test_held_import_report_discards_old_body_before_cloud_and_local_publication():
    old, new, local = FakeApi(), FakeApi(), []
    subject = ImportController(api=old, watcher=FakeWatcher(), on_change=local.append)
    admission = subject._capture_auth()
    subject._job_id, subject._job_auth = "old-A-job", admission
    subject._total, subject._completed, subject._dirty = 10, 1, True
    subject._samples = [{"file": "private-A.SC2Replay", "errorCode": "synthetic"}]
    entered, release = threading.Event(), threading.Event()
    original_publish = subject._publish_local

    class OneTick:
        calls = 0
        def wait(self, _seconds):
            self.calls += 1
            return self.calls > 1

    def held(body):
        entered.set()
        assert release.wait(3)
        original_publish(body)

    subject._stop, subject._publish_local = OneTick(), held
    worker = threading.Thread(target=lambda: subject._run_reporter(admission))
    worker.start()
    try:
        assert entered.wait(2)
        subject.replace_api(new)
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and old.progress_calls == new.progress_calls == local == []
    subject._publish_local = original_publish
    subject.set_hold(connection="online")
    assert subject.snapshot()["phase"] == "idle"
    assert "private-A" not in repr(local)
    subject._post_progress({"jobId": "current-B", "completed": 1})
    assert new.progress_calls == [{"jobId": "current-B", "completed": 1}]


def test_bound_socket_import_callback_cannot_adopt_same_api_after_aba():
    api, posts = FakeApi(), []
    api.device_token = "synthetic-A"
    subject = ImportController(api=api, watcher=FakeWatcher(), list_folders=lambda: posts.append(True) or [])
    callback = subject.bind_authenticated(subject.handle_pick_folder_request, api.device_token)
    subject.replace_api(FakeApi())
    subject.replace_api(api)
    callback({})
    assert posts == api.host_info_calls == []
    subject.bind_authenticated(subject.handle_pick_folder_request, api.device_token)({})
    assert posts == [True] and api.host_info_calls == [{"replayFolders": []}]


def test_held_hold_publication_cannot_relabel_old_snapshot_as_current(monkeypatch):
    old, new, local = FakeApi(), FakeApi(), []
    subject = ImportController(api=old, watcher=FakeWatcher(), on_change=local.append)
    subject._publish_local({"phase": "import", "errorSamples": [{"file": "private-A"}]})
    local.clear()
    entered, release, publish = threading.Event(), threading.Event(), subject._publish_local
    def held(body):
        entered.set()
        assert release.wait(3)
        publish(body)
    monkeypatch.setattr(subject, "_publish_local", held)
    worker = threading.Thread(target=lambda: subject.set_hold(paused=True))
    worker.start()
    try:
        assert entered.wait(2)
        subject.replace_api(new)
        publish({"phase": "import", "jobId": "current-B", "completed": 3})
        current = subject.snapshot()
        local.clear()
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and local == [] and subject.snapshot() == current


@pytest.mark.parametrize("source", ["upload-success", "upload-error", "watcher-skip"])
def test_actual_producer_context_rejects_old_hook_after_new_job_activation(tmp_path, monkeypatch, source):
    state = AgentState(device_token="synthetic-A", user_id="owner-A")
    old, new = ApiClient("https://example.test", state.device_token), ApiClient("https://example.test", "synthetic-B")
    first = replay_ticket(state)
    subject = ImportController(api=old, watcher=FakeWatcher(), owner_epoch=first.epoch)
    monkeypatch.setattr(subject, "_run_reporter", lambda *_args: None)
    subject._activate("A-job", 10)
    queue = UploadQueue(cfg=_cfg(tmp_path), state=state, api=old)
    watcher = ReplayWatcher(cfg=_cfg(tmp_path), state=state, upload=queue)
    entered, release = threading.Event(), threading.Event()
    def held_upload(context, path, exc):
        entered.set()
        assert release.wait(3)
        subject.on_owned_upload(context, path, exc)
    def held_skip(ticket, path, reason):
        entered.set()
        assert release.wait(3)
        subject.on_owned_skipped(ticket, path, reason)
    queue._on_owned_outcome, watcher._on_owned_skipped = held_upload, held_skip
    path = Path("private-A.SC2Replay")
    context = queue._upload_context()
    exc = TerminalUploadError("private-A error sample") if source == "upload-error" else None
    worker = threading.Thread(target=(lambda: watcher._notify_skipped(path, "parse_failed", ticket=first))
        if source == "watcher-skip" else lambda: queue._notify_outcome(context, path, exc))
    worker.start()
    try:
        assert entered.wait(2)
        with _STATE_SAVE_LOCK:
            state.user_id, state.device_token, state._owner_epoch = "owner-B", new.device_token, object()
            queue.replace_api(new)
            subject.replace_api(new, owner_epoch=state._owner_epoch)
        subject._activate("B-job", 8)
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive()
    assert subject._completed == subject._errors == 0 and subject._samples == []
    if source == "watcher-skip":
        watcher._on_owned_skipped = subject.on_owned_skipped
        watcher._notify_skipped(Path("current-B.SC2Replay"), "ai_game", ticket=replay_ticket(state))
    else:
        queue._on_owned_outcome = subject.on_owned_upload
        queue._notify_outcome(queue._upload_context(), Path("current-B.SC2Replay"))
    assert subject._completed == 1 and subject._errors == 0 and subject._samples == []
    subject.stop()


def test_hold_revalidates_after_waiting_for_controller_admission(monkeypatch):
    old, new = FakeApi(), FakeApi()
    subject = ImportController(api=old, watcher=FakeWatcher())
    entered, release = threading.Event(), threading.Event()
    original, held = subject._auth_current, []
    def current(admission=None):
        value = original(admission)
        if threading.current_thread() is worker and not held:
            held.append(True)
            entered.set()
            assert release.wait(3)
        return value
    monkeypatch.setattr(subject, "_auth_current", current)
    worker = threading.Thread(target=lambda: subject.set_hold(paused=True, connection="offline"))
    worker.start()
    try:
        assert entered.wait(2)
        subject.replace_api(new)
        subject._publish_local({"phase": "import", "jobId": "B-current"})
    finally:
        release.set()
        worker.join(3)
    assert not worker.is_alive() and subject._paused is False and subject._connection_held is False
    assert subject.snapshot()["jobId"] == "B-current"
