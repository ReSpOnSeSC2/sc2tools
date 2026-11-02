"""Credential revisions retire actual support publication/review admissions."""
import threading
import time
from unittest.mock import Mock

import pytest

from sc2tools_agent.api_client import ApiClient
from sc2tools_agent.agent_credentials import CredentialIntent
from sc2tools_agent.state import _STATE_SAVE_LOCK, commit_state_credentials, credential_revision, load_state
from sc2tools_agent.agent_credentials import CredentialStorageError
from sc2tools_agent.support_diagnostics import DiagnosticRow
from sc2tools_agent.support_probes import ProbeResult
from sc2tools_agent import support_runtime
from tests.test_agent_state_credentials import initialized
from tests.test_support_runtime import service, joined
from tests.test_agent_credentials import SyntheticCrypto


def secure_service(tmp_path):
    subject, _old_state, cell, threads = service(tmp_path)
    state, storage, crypto = initialized(tmp_path)
    subject.state = state
    cell.api = ApiClient(subject.cfg.api_base, state.device_token)
    return subject, state, storage, crypto, threads


def same_obs_set(tmp_path, state, storage, crypto):
    commit_state_credentials(tmp_path, state,
        obs=CredentialIntent("set", state.obs_password),
        expected_obs_revision=credential_revision(state, "obs"), storage=storage, crypto=crypto)


def test_same_value_obs_revision_retires_review_and_blocks_actual_save_admission(tmp_path, monkeypatch):
    subject, state, storage, crypto, threads = secure_service(tmp_path)
    monkeypatch.setattr(support_runtime, "read_log_selections", lambda *_args, **_kwargs: ())
    writes, results = [], []
    monkeypatch.setattr(support_runtime, "write_reviewed_bundle", lambda *args, **kwargs: writes.append(True))
    try:
        nonce = subject.prepare_bundle(results.append)
        joined(threads)
        assert len(results) == 1 and subject.is_current(nonce)
        before = state.obs_password
        same_obs_set(tmp_path, state, storage, crypto)
        assert state.obs_password == before
        assert not subject.is_current(nonce)
        assert subject.save_reviewed(nonce, tmp_path / "must-not-be-saved.zip", results.append) is None
        assert writes == [] and not (tmp_path / "must-not-be-saved.zip").exists()
    finally:
        subject.close()


@pytest.mark.parametrize("mode", ["unavailable", "environment", "cleared"])
def test_support_obs_never_turns_unreadable_password_into_anonymous_probe(tmp_path, monkeypatch, mode):
    subject, state, storage, crypto, _threads = secure_service(tmp_path)
    if mode == "cleared":
        commit_state_credentials(tmp_path, state, obs=CredentialIntent("clear"),
            expected_obs_revision=credential_revision(state, "obs"), storage=storage, crypto=crypto)
    else:
        class UnavailableCrypto(SyntheticCrypto):
            def unprotect(self, value):
                raise CredentialStorageError("unavailable")
        state = load_state(tmp_path, storage=storage, crypto=UnavailableCrypto())
        subject.state = state
    subject.cell.no_obs = False
    state.obs_scene_switch_enabled = True
    effective = "synthetic-env-password" if mode == "environment" else None
    subject.obs_connection = lambda: ("localhost", 4455, effective)
    probe = Mock(return_value=ProbeResult(DiagnosticRow("obs", "pass", "ok")))
    monkeypatch.setattr(support_runtime, "obs_probe", probe)
    scope = subject._capture()
    result = support_runtime.SupportService._probe(subject, "obs", scope, None, (), {},
        lambda: True, lambda: False, time.monotonic() + 2)
    if mode == "unavailable":
        probe.assert_not_called()
        assert result.row.status == "unavailable" and result.row.action == "open_settings"
    else:
        probe.assert_called_once()
        assert probe.call_args.args[1] == ("localhost", 4455, effective)
    subject.close()


def test_credential_revision_retires_held_result_without_releasing_actual_worker(tmp_path):
    subject, state, storage, crypto, threads = secure_service(tmp_path)
    entered, release = threading.Event(), threading.Event()
    results = []

    def held():
        entered.set()
        assert release.wait(3)
        return ()

    subject.discover_folders = held
    nonce = subject.run_check(results.append)
    try:
        assert entered.wait(2)
        same_obs_set(tmp_path, state, storage, crypto)
        assert subject.copy_info(results.append) is None
        assert subject.run_check(results.append) is None
        assert subject.busy and not subject.is_current(nonce)
    finally:
        release.set()
        joined(threads)
        subject.close()
    assert results == [] and not subject.busy


def test_late_unlink_epoch_cannot_invalidate_new_owner_support_result(tmp_path):
    subject, state, _storage, _crypto, threads = secure_service(tmp_path)
    results = []
    try:
        first = subject.copy_info(results.append)
        joined(threads)
        assert subject.is_current(first)
        previous_epoch = state._owner_epoch
        with _STATE_SAVE_LOCK:
            state._owner_epoch = object()
        current = subject.copy_info(results.append)
        joined(threads)
        assert len(results) == 2 and subject.is_current(current)
        assert subject.invalidate_for_epoch(previous_epoch) is False
        assert subject.is_current(current)
        assert subject.invalidate_for_epoch(state._owner_epoch) is True
        assert not subject.is_current(current)
    finally:
        subject.close()
