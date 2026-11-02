"""Pairing code/candidate ownership using the actual central transaction seam."""
from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone
import json
import threading
from types import SimpleNamespace

import pytest

from sc2tools_agent.pairing import flow
from sc2tools_agent.pairing.flow import PairingControls, ensure_paired
from sc2tools_agent.state import (
    AgentState, _STATE_SAVE_LOCK, commit_state_credentials, credential_revision, save_state,
    load_state,
)
from sc2tools_agent.agent_credentials import CredentialIntent
from tests.test_agent_credentials import MemoryStorage, SyntheticCrypto


class LogicalControls(PairingControls):
    def __init__(self, *, advance=None, after_wait=lambda: None):
        super().__init__()
        self.value = datetime(2026, 11, 2, 12, tzinfo=timezone.utc)
        self.advance, self.after_wait, self.waits = advance, after_wait, []

    def wait(self, seconds, stop):
        self.waits.append(seconds)
        self.value += self.advance or timedelta(seconds=seconds)
        self.after_wait()
        if len(self.waits) > 6:
            stop.set()


@pytest.fixture(autouse=True)
def _owned_cache_only(monkeypatch):
    # The cache API is independent of the injected credential store. No real cache is read.
    monkeypatch.setattr("sc2tools_agent.player_handle.write_cache", lambda *_args, **_kwargs: None)


def unpaired(tmp_path):
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    state = AgentState(user_id="previous-owner", paired_at="previous-pairing")
    save_state(tmp_path, state, storage=storage, crypto=crypto)
    state._owner_epoch = object()
    state._owned_toons = ("previous-owned-toon",)
    return state, storage, crypto


def call(tmp_path, state, api, controls, stop, states, codes):
    return ensure_paired(cfg=SimpleNamespace(state_dir=tmp_path), state=state, api=api,
        on_code=codes.append, on_state=states.append, controls=controls, stop_event=stop,
        now=lambda: controls.value, jitter=lambda _low, _high: 1)


@pytest.mark.parametrize("response_status", ["ready", "pending"])
@pytest.mark.parametrize("rotation", ["epoch", "revision", "new-code"])
def test_held_old_response_cannot_adopt_its_code_under_new_unpaired_scope(tmp_path, response_status, rotation):
    state, storage, crypto = unpaired(tmp_path)
    controls, stop = LogicalControls(), threading.Event()
    entered, release = threading.Event(), threading.Event()
    states, codes, polls, result = [], [], [], []
    old_epoch = state._owner_epoch

    class Api:
        starts = 0
        def start_pairing(self):
            assert not _STATE_SAVE_LOCK._is_owned()
            self.starts += 1
            return {"code": "111111" if self.starts == 1 else "222222",
                "expiresAt": (controls.value + timedelta(minutes=10)).isoformat()}
        def poll_pairing(self, code):
            assert not _STATE_SAVE_LOCK._is_owned()
            polls.append((code, state._owner_epoch))
            if code == "111111":
                entered.set()
                assert release.wait(3)
                return {"status": response_status, "deviceToken": "old-device-private", "userId": "old-owner"}
            return {"status": "ready", "deviceToken": "current-device-private", "userId": "current-owner"}
    api = Api()
    worker = threading.Thread(target=lambda: result.append(call(tmp_path, state, api, controls, stop, states, codes)))
    worker.start()
    try:
        assert entered.wait(2)
        cutoff = len(states)
        if rotation == "new-code":
            controls.request_new_code()
        else:
            with _STATE_SAVE_LOCK:
                if rotation == "epoch":
                    state._owner_epoch = object()
                else:
                    commit_state_credentials(tmp_path, state, device=CredentialIntent("clear"),
                        expected_device_revision=1, expected_owner_epoch=state._owner_epoch)
        assert not state.is_paired
        release.set()
        worker.join(3)
        assert not worker.is_alive() and result == [True]
        assert [code for code, _epoch in polls] == ["111111", "222222"]
        assert polls[0][1] is old_epoch and api.starts == 2
        assert not any(item.kind == "showing" and item.code == "111111" for item in states[cutoff:])
        assert codes == ["111111", "222222"]
        assert state.device_token == "current-device-private" and state.user_id == "current-owner"
        assert load_state(tmp_path, storage=storage, crypto=crypto).device_token == "current-device-private"
        assert json.loads(storage.pointer)["user_id"] == "current-owner" and len(storage.generations) == 1
        assert all(b"old-device-private" not in value for value in (storage.pointer, *storage.generations.values()))
    finally:
        release.set()
        stop.set()
        worker.join(3)


def test_stop_while_old_ready_is_held_never_commits_or_emits_late_success(tmp_path):
    state, storage, _crypto = unpaired(tmp_path)
    before = storage.pointer
    controls, stop = LogicalControls(), threading.Event()
    entered, release = threading.Event(), threading.Event()
    states, codes, result = [], [], []
    class Api:
        def start_pairing(self):
            return {"code": "111111", "expiresAt": (controls.value + timedelta(minutes=10)).isoformat()}
        def poll_pairing(self, _code):
            entered.set()
            assert release.wait(3)
            return {"status": "ready", "deviceToken": "cancelled-device-private", "userId": "old-owner"}
    worker = threading.Thread(target=lambda: result.append(call(tmp_path, state, Api(), controls, stop, states, codes)))
    worker.start()
    try:
        assert entered.wait(2)
        cutoff = len(states)
        stop.set()
        release.set()
        worker.join(3)
        assert result == [False] and not worker.is_alive()
        assert storage.pointer == before and storage.generations == {} and state.device_token is None
        assert states[cutoff:] == []
    finally:
        release.set()
        stop.set()
        worker.join(3)


def test_definite_commit_retry_keeps_candidate_time_epoch_and_exact_cipher_after_code_expires(tmp_path, caplog):
    state, storage, _crypto = unpaired(tmp_path)
    initial_epoch = state._owner_epoch
    controls, stop = LogicalControls(advance=timedelta(hours=2)), threading.Event()
    instant = controls.value
    states, codes, attempted, epochs = [], [], [], []
    staged = {}
    replace_pointer = storage.replace_pointer
    def fail_once(expected, data):
        attempted.append(json.loads(data))
        epochs.append(state._owner_epoch)
        if len(attempted) == 1:
            staged.update(storage.generations)
            raise OSError("pairing-device-private raw native cause")
        replace_pointer(expected, data)
    storage.replace_pointer = fail_once
    class Api:
        starts = polls = 0
        def start_pairing(self):
            self.starts += 1
            return {"code": "111111", "expiresAt": (instant + timedelta(seconds=65)).isoformat()}
        def poll_pairing(self, _code):
            self.polls += 1
            return {"status": "ready", "deviceToken": "pairing-device-private", "userId": "current-owner"}
    api = Api()
    assert call(tmp_path, state, api, controls, stop, states, codes)
    assert api.starts == api.polls == 1 and controls.value > instant + timedelta(seconds=65)
    assert len(staged) == 1 and storage.generations == staged
    assert [document["paired_at"] for document in attempted] == [instant.isoformat(), instant.isoformat()]
    assert epochs[0] is epochs[1] is state._owner_epoch and state._owner_epoch is not initial_epoch
    assert state._owned_toons is None and state.device_token == "pairing-device-private"
    assert state.paired_at == instant.isoformat() and credential_revision(state, "device") == 2
    assert load_state(tmp_path, storage=storage, crypto=_crypto).device_token == "pairing-device-private"
    assert json.loads(storage.pointer)["credentials"]["device"]["revision"] == 2
    assert codes == ["111111"] and states[-1].kind == "paired"
    assert all(item.owner_epoch is not None for item in states)
    assert "pairing-device-private" not in caplog.text and "raw native cause" not in caplog.text
    for value in (storage.pointer, *storage.generations.values()):
        assert b"pairing-device-private" not in value


def test_foreign_epoch_after_definite_failure_retires_candidate_and_requires_a_fresh_code(tmp_path):
    state, storage, _crypto = unpaired(tmp_path)
    stop = threading.Event()
    rotated = []
    def rotate_once():
        if not rotated:
            with _STATE_SAVE_LOCK:
                state._owner_epoch = object()
            rotated.append(True)
    controls = LogicalControls(after_wait=rotate_once)
    states, codes, polls, attempted = [], [], [], []
    replace_pointer = storage.replace_pointer
    def fail_once(expected, data):
        attempted.append(json.loads(data))
        if len(attempted) == 1: raise OSError("definite pointer failure")
        replace_pointer(expected, data)
    storage.replace_pointer = fail_once
    class Api:
        starts = 0
        def start_pairing(self):
            self.starts += 1
            return {"code": "111111" if self.starts == 1 else "222222",
                "expiresAt": (controls.value + timedelta(minutes=10)).isoformat()}
        def poll_pairing(self, code):
            polls.append(code)
            return {"status": "ready", "deviceToken": "old-private" if code == "111111" else "new-private",
                "userId": "current-owner"}
    api = Api()
    assert call(tmp_path, state, api, controls, stop, states, codes)
    assert api.starts == 2 and polls == codes == ["111111", "222222"]
    assert state.device_token == "new-private" and len(attempted) == 2
    assert load_state(tmp_path, storage=storage, crypto=_crypto).device_token == "new-private"
    selected = json.loads(storage.pointer)["credentials"]["device"]["generation"]
    assert selected in storage.generations and len(storage.generations) == 2
    assert b"old-private" not in storage.pointer and b"new-private" not in storage.pointer


def test_indeterminate_commit_never_repolls_or_claims_a_paired_activation(tmp_path):
    state, storage, _crypto = unpaired(tmp_path)
    controls, stop = LogicalControls(), threading.Event()
    states, codes, polls = [], [], []
    def indeterminate(_expected, data):
        document = json.loads(data)
        document["window_page"] = "settings"
        storage.pointer = json.dumps(document).encode()
        raise OSError("unknown result")
    storage.replace_pointer = indeterminate
    class Api:
        def start_pairing(self):
            return {"code": "111111", "expiresAt": (controls.value + timedelta(minutes=10)).isoformat()}
        def poll_pairing(self, code):
            polls.append(code)
            return {"status": "ready", "deviceToken": "uncertain-private", "userId": "current-owner"}
    assert not call(tmp_path, state, Api(), controls, stop, states, codes)
    assert polls == ["111111"] and state.device_token is None
    assert not any(item.kind == "paired" for item in states) and controls.waits == []
    assert b"uncertain-private" not in storage.pointer and len(storage.generations) == 1


def test_network_errors_and_private_candidate_representations_do_not_expose_secret_or_coerce_raw_objects(tmp_path, caplog):
    state, storage, _crypto = unpaired(tmp_path)
    stop = threading.Event()
    controls = LogicalControls(after_wait=stop.set)
    states, codes = [], []
    class Api:
        def start_pairing(self): raise RuntimeError("network-private-token in raw exception")
    assert not call(tmp_path, state, Api(), controls, stop, states, codes)
    assert "network-private-token" not in caplog.text and "raw exception" not in caplog.text
    touched = []
    class Private:
        def __str__(self): touched.append(True); return "coerced-private"
        def __bool__(self): touched.append(True); return True
    stop.clear()
    controls = LogicalControls(after_wait=stop.set)
    class InvalidApi:
        def start_pairing(self):
            return {"code": "111111", "expiresAt": (controls.value + timedelta(minutes=10)).isoformat()}
        def poll_pairing(self, _code):
            return {"status": "ready", "deviceToken": Private(), "userId": "current-owner"}
    assert not call(tmp_path, state, InvalidApi(), controls, stop, states, codes)
    assert touched == [] and state.device_token is None and storage.generations == {}
    scope = flow._PairingScope(object(), 1, object())
    candidate = flow._ApprovedCandidate("candidate-private-token", "private-owner", "private-time", scope, True)
    assert "candidate-private-token" not in repr(candidate) and "private-owner" not in repr(candidate)
    with pytest.raises(FrozenInstanceError): candidate.token = "changed"
