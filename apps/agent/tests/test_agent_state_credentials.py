"""Central credential persistence with owned synthetic storage/crypto only."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading

import pytest

from sc2tools_agent import state as state_module
from sc2tools_agent.agent_credentials import CredentialIntent, CredentialStorageError
from sc2tools_agent.instance_lock import AgentInstanceLock
from sc2tools_agent.state import (
    AgentState, commit_state_credentials, credential_revision, credential_scope, credential_status,
    load_state, mark_device_retired, migrate_legacy_state, save_state,
)
from tests.test_agent_credentials import MemoryStorage, SyntheticCrypto, assert_code


class FiniteFileStorage:
    """Owned-temp test IO, not a substitute for the Windows handle adapter."""
    def __init__(self, directory):
        self.directory = Path(directory)
        self.pointer = self.directory / "agent.json"
        self.root = self.directory / "credentials-v1"

    def ensure_state_directory(self):
        self.directory.mkdir(parents=True, exist_ok=True)

    def identity(self):
        if not self.directory.is_dir():
            raise CredentialStorageError("missing")
        return hashlib.sha256(os.fsencode(self.directory.resolve())).digest()

    def read_pointer(self):
        try:
            return self.pointer.read_bytes()
        except FileNotFoundError:
            return None

    def read_generation(self, name):
        try:
            return (self.root / name).read_bytes()
        except FileNotFoundError:
            raise CredentialStorageError("missing") from None

    def create_generation(self, name, data):
        self.root.mkdir(exist_ok=True)
        with (self.root / name).open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    def capacity(self):
        entries = list(self.root.iterdir()) if self.root.exists() else []
        return len(entries), sum(path.stat().st_size for path in entries)

    def replace_pointer(self, expected, data):
        if self.read_pointer() != expected:
            raise CredentialStorageError("conflict")
        descriptor, name = tempfile.mkstemp(prefix="agent.", suffix=".tmp", dir=self.directory)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            state_module._replace_state_file(name, self.pointer)
        finally:
            Path(name).unlink(missing_ok=True)


@pytest.fixture
def synthetic_state_io(monkeypatch):
    """Portable real temp-file roundtrips with an explicit lookup-crypto seam."""
    stores, test_crypto = {}, SyntheticCrypto()
    def backends(directory, storage=None, crypto=None, *, create=False):
        if storage is None:
            directory = Path(directory)
            storage = stores.setdefault(directory, FiniteFileStorage(directory))
            if create:
                storage.ensure_state_directory()
        return storage, test_crypto if crypto is None else crypto
    monkeypatch.setattr(state_module, "_credential_backends", backends)
    return stores, test_crypto


@pytest.fixture
def acquired_guard(tmp_path):
    guard = AgentInstanceLock(tmp_path)
    assert guard.acquire()
    try:
        yield guard
    finally:
        guard.release()


def initialized(tmp_path, *, device="old-device-private", obs="old-obs-private", user_id="owner-a", paired_at="paired-a"):
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    state = AgentState(device_token=device, obs_password=obs, user_id=user_id, paired_at=paired_at,
        uploaded={"kept.SC2Replay": "2026-11-01"})
    save_state(tmp_path, state, storage=storage, crypto=crypto)
    return state, storage, crypto


def set_device(tmp_path, state, value, **extra):
    epoch = getattr(state, "_owner_epoch", None)
    if epoch is None:
        epoch = state._owner_epoch = object()
    return commit_state_credentials(tmp_path, state, device=CredentialIntent("set", value),
        expected_device_revision=credential_revision(state, "device"), expected_owner_epoch=epoch,
        device_owner=(state.user_id, state.paired_at), **extra)


def test_snapshot_omits_runtime_secrets_and_fresh_save_encrypts_exact_initial_fields(tmp_path):
    state, storage, crypto = initialized(tmp_path, user_id=None, paired_at=None)
    assert "device_token" not in state_module._snapshot(state) and "obs_password" not in state_module._snapshot(state)
    assert "old-device-private" not in repr(state) and "old-obs-private" not in repr(state)
    document = json.loads(storage.pointer)
    assert "device_token" not in document and "obs_password" not in document
    assert document["user_id"] is None and document["paired_at"] is None
    assert document["uploaded"] == {"kept.SC2Replay": "2026-11-01"}
    for data in (storage.pointer, *storage.generations.values()):
        assert b"old-device-private" not in data and b"old-obs-private" not in data
    loaded = load_state(tmp_path, storage=storage, crypto=crypto)
    assert loaded.device_token == "old-device-private" and loaded.obs_password == "old-obs-private"
    assert credential_status(loaded, "device") == credential_status(loaded, "obs") == "available"


def test_ordinary_selected_save_is_keep_and_never_drops_a_new_implicit_set(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    original_refs = json.loads(storage.pointer)["credentials"]
    original_files = dict(storage.generations)
    state.window_page = "help"
    save_state(tmp_path, state)
    assert json.loads(storage.pointer)["credentials"] == original_refs and storage.generations == original_files
    before = storage.pointer
    state.device_token = "uncommitted-private"
    assert_code("invalid_intent", lambda: save_state(tmp_path, state))
    assert storage.pointer == before and load_state(tmp_path, storage=storage, crypto=crypto).device_token == "old-device-private"


def test_ordinary_keep_preserves_both_unreadable_slots_without_crypto_or_generation_rewrites(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    crypto.plaintexts.clear()
    state = load_state(tmp_path, storage=storage, crypto=crypto)
    assert credential_status(state, "device") == credential_status(state, "obs") == "unreadable"
    before = json.loads(storage.pointer)["credentials"], dict(storage.generations)
    crypto.protect = crypto.unprotect = lambda *_args: pytest.fail("opaque KEEP reached crypto")
    state.window_page = "help"
    save_state(tmp_path, state)
    assert (json.loads(storage.pointer)["credentials"], storage.generations) == before
    assert state.device_token is None and state.obs_password is None


def test_unsupported_secure_backend_never_falls_back_to_plaintext(tmp_path, monkeypatch):
    def unavailable(*_args, **_kwargs):
        raise CredentialStorageError("unavailable")
    monkeypatch.setattr(state_module, "_credential_backends", unavailable)
    assert_code("unavailable", lambda: save_state(tmp_path, AgentState(device_token="private-no-fallback")))
    assert list(tmp_path.iterdir()) == []


def test_ordinary_existing_legacy_or_invalid_save_never_migrates_or_overwrites(tmp_path):
    for raw in (b'{"device_token":"legacy-private","window_page":"settings"}', b'{broken',
                b'{"credentials":{"version":2}}'):
        storage, crypto = MemoryStorage(raw), SyntheticCrypto()
        state = load_state(tmp_path, storage=storage, crypto=crypto)
        state.window_page = "help"
        assert_code("invalid_pointer", lambda: save_state(tmp_path, state))
        assert storage.pointer == raw and storage.generations == {}
        assert_code("invalid_pointer", lambda: save_state(tmp_path, AgentState(device_token="candidate-private"),
            storage=storage, crypto=crypto))
        assert storage.pointer == raw and storage.generations == {}


def test_prelock_legacy_and_corrupt_disk_loads_are_read_only_and_do_not_construct_native_store(tmp_path, monkeypatch):
    monkeypatch.setattr(state_module, "_credential_backends", lambda *_args, **_kwargs: pytest.fail("read attempted native storage"))
    target = tmp_path / "agent.json"
    assert credential_status(load_state(tmp_path), "device") == "missing"
    assert list(tmp_path.iterdir()) == []
    for raw in (b'{"device_token":"legacy-private","obs_password":"legacy-obs-private","api_base_override":"https://example.test"}', b'{broken'):
        target.write_bytes(raw)
        state = load_state(tmp_path)
        assert target.read_bytes() == raw
        assert credential_status(state, "device") in ("legacy", "unreadable")
        assert state.device_token is None and state.obs_password is None
        if credential_status(state, "device") == "legacy":
            assert state.api_base_override == "https://example.test"
    assert sorted(path.name for path in tmp_path.iterdir()) == ["agent.json"]


def test_migration_requires_actual_acquired_matching_instance_before_any_storage_callback(tmp_path):
    storage, crypto = MemoryStorage(b'{"device_token":"legacy-private"}'), SyntheticCrypto()
    storage.identity = lambda: pytest.fail("unowned migration reached storage")
    fake = type("Fake", (), {"acquired": True, "state_directory": tmp_path})()
    assert_code("conflict", lambda: migrate_legacy_state(tmp_path, fake, storage=storage, crypto=crypto))
    guard = AgentInstanceLock(tmp_path)
    assert_code("conflict", lambda: migrate_legacy_state(tmp_path, guard, storage=storage, crypto=crypto))
    other = AgentInstanceLock(tmp_path / "other")
    assert other.acquire()
    try:
        assert_code("conflict", lambda: migrate_legacy_state(tmp_path, other, storage=storage, crypto=crypto))
    finally:
        other.release()


def test_missing_snapshot_can_retire_and_save_empty_without_reviving_a_token(tmp_path):
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    state = load_state(tmp_path, storage=storage, crypto=crypto)
    mark_device_retired(state)
    assert state.device_token is None and credential_status(state, "device") == "retired"
    save_state(tmp_path, state, storage=storage, crypto=crypto)
    document = json.loads(storage.pointer)
    assert document["credentials"]["device"]["generation"] is None
    assert state.device_token is None and storage.generations == {}
    assert "device_token" not in document and "obs_password" not in document


def test_explicit_migration_stages_both_slots_then_one_pointer_and_preserves_full_nonsecret_document(tmp_path, acquired_guard):
    original = {"device_token": "legacy-device-private", "obs_password": "legacy-obs-private",
        "user_id": None, "paired_at": None, "uploaded": {"kept.SC2Replay": "2026-11-01"},
        "future_preferences": {"enabled": True, "nested": [1, 2, 3]}, "window_page": "settings"}
    raw = json.dumps(original, indent=2).encode()
    storage, crypto = MemoryStorage(raw), SyntheticCrypto()
    state = migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto)
    document = json.loads(storage.pointer)
    expected = {key: value for key, value in original.items() if key not in ("device_token", "obs_password")}
    assert {key: value for key, value in document.items() if key != "credentials"} == expected
    assert document["credentials"]["device"]["revision"] == document["credentials"]["obs"]["revision"] == 1
    assert state.device_token == "legacy-device-private" and state.obs_password == "legacy-obs-private"
    assert len(storage.generations) == 2 and [event[0] for event in storage.events].count("replace") == 1
    for data in (storage.pointer, *storage.generations.values()):
        assert b"legacy-device-private" not in data and b"legacy-obs-private" not in data
    previous = storage.pointer, dict(storage.generations)
    migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto)
    assert (storage.pointer, storage.generations) == previous


def test_missing_migration_commits_explicit_cleared_slots_without_generations(tmp_path, acquired_guard):
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    assert credential_status(load_state(tmp_path, storage=storage, crypto=crypto), "device") == "missing"
    state = migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto)
    assert credential_status(state, "device") == credential_status(state, "obs") == "cleared"
    assert storage.generations == {}
    assert json.loads(storage.pointer)["credentials"]["device"] == {"revision": 1, "generation": None}


@pytest.mark.parametrize("failure", ["protect-second", "create-second", "pointer"], ids=["protect-second", "create-second", "pointer"])
def test_failed_legacy_migration_keeps_original_bytes_and_does_not_return_activated_state(tmp_path, acquired_guard, failure):
    raw = b'{"device_token":"legacy-device-private","obs_password":"legacy-obs-private","user_id":null,"paired_at":null}'
    storage, crypto = MemoryStorage(raw), SyntheticCrypto()
    if failure == "protect-second":
        protect = crypto.protect
        def fail_obs(data):
            if json.loads(data)["slot"] == "obs": raise RuntimeError("legacy-obs-private")
            return protect(data)
        crypto.protect = fail_obs
        code = "unavailable"
    elif failure == "create-second":
        create = storage.create_generation
        def fail_obs(name, data):
            if name.startswith("obs-"): raise OSError("legacy-obs-private")
            create(name, data)
        storage.create_generation = fail_obs
        code = "write_failed"
    else:
        storage.replace_pointer = lambda *_args: (_ for _ in ()).throw(OSError("private path"))
        code = "write_failed"
    error = assert_code(code, lambda: migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto))
    assert storage.pointer == raw and "legacy-obs-private" not in str(error)
    assert ("replace",) not in storage.events


def test_migration_losing_actual_instance_during_generation_io_cannot_publish(tmp_path, acquired_guard):
    raw = b'{"device_token":"legacy-private","user_id":null,"paired_at":null}'
    storage, crypto = MemoryStorage(raw), SyntheticCrypto()
    create = storage.create_generation
    def retire(name, data):
        create(name, data)
        acquired_guard.release()
    storage.create_generation = retire
    assert_code("conflict", lambda: migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto))
    assert storage.pointer == raw and ("replace",) not in storage.events


def test_migration_rechecks_actual_lease_after_waiting_for_state_before_setup(tmp_path, acquired_guard, monkeypatch):
    entered = threading.Event()
    outcomes, setup = [], []
    require = state_module._require_instance

    def admitted(*args, **kwargs):
        result = require(*args, **kwargs)
        if threading.current_thread().name == "owned-waiting-migration" and len(args) == 2:
            entered.set()
        return result

    def backend(*args, **kwargs):
        setup.append(True)
        pytest.fail("unowned migration reached setup")

    def migrate():
        try:
            migrate_legacy_state(tmp_path, acquired_guard)
        except CredentialStorageError as error:
            outcomes.append(error.code)

    monkeypatch.setattr(state_module, "_require_instance", admitted)
    monkeypatch.setattr(state_module, "_credential_backends", backend)
    worker = threading.Thread(name="owned-waiting-migration", target=migrate)
    try:
        with state_module._STATE_SAVE_LOCK:
            worker.start()
            assert entered.wait(2)
            acquired_guard.release()
    finally:
        worker.join(3)
    assert not worker.is_alive() and outcomes == ["conflict"] and setup == []


def test_old_migration_cannot_publish_after_same_guard_release_and_reacquire(tmp_path, acquired_guard):
    raw = b'{"device_token":"legacy-private","user_id":null,"paired_at":null}'
    storage, crypto = MemoryStorage(raw), SyntheticCrypto()
    create = storage.create_generation
    original_lease = acquired_guard.acquisition_token

    def reacquire(name, data):
        create(name, data)
        acquired_guard.release()
        assert acquired_guard.acquire()
        assert acquired_guard.acquisition_token is not original_lease

    storage.create_generation = reacquire
    assert_code("conflict", lambda: migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto))
    assert storage.pointer == raw and ("replace",) not in storage.events
    staged = dict(storage.generations)
    storage.create_generation = create
    crypto.protect = lambda *_args: pytest.fail("newly admitted migration did not reuse matching staged data")
    state = migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto)
    assert state.device_token == "legacy-private" and storage.generations == staged


def test_legacy_retry_on_same_owned_guard_reuses_exact_staged_generations(tmp_path, acquired_guard):
    raw = b'{"device_token":"legacy-private","obs_password":"obs-private","user_id":null,"paired_at":null}'
    storage, crypto = MemoryStorage(raw), SyntheticCrypto()
    replacement = storage.replace_pointer
    storage.replace_pointer = lambda *_args: (_ for _ in ()).throw(OSError("retryable pointer failure"))
    assert_code("write_failed", lambda: migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto))
    staged = dict(storage.generations)
    assert len(staged) == 2 and storage.pointer == raw
    crypto.protect = lambda *_args: pytest.fail("retry encrypted a new generation")
    storage.replace_pointer = replacement
    state = migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto)
    assert storage.generations == staged and state.device_token == "legacy-private" and state.obs_password == "obs-private"


def test_explicit_set_keeps_shared_owner_and_credentials_old_until_known_commit(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    state._owner_epoch = epoch = object()
    original = state.device_token, state.user_id, state.paired_at, credential_scope(state)
    replace_pointer = storage.replace_pointer
    def inspect_before_commit(expected, data):
        assert (state.device_token, state.user_id, state.paired_at, credential_scope(state)) == original
        candidate = json.loads(data)
        assert (candidate["user_id"], candidate["paired_at"]) == ("owner-b", "paired-b")
        replace_pointer(expected, data)
    storage.replace_pointer = inspect_before_commit
    commit_state_credentials(tmp_path, state, device=CredentialIntent("set", "new-device-private"),
        expected_device_revision=1, expected_owner_epoch=epoch, device_owner=("owner-b", "paired-b"))
    assert (state.device_token, state.user_id, state.paired_at) == ("new-device-private", "owner-b", "paired-b")
    assert state._owner_epoch is epoch and credential_revision(state, "device") == 2
    loaded = load_state(tmp_path, storage=storage, crypto=crypto)
    assert (loaded.device_token, loaded.user_id, loaded.paired_at) == ("new-device-private", "owner-b", "paired-b")


def test_failed_set_preserves_same_shared_object_old_values_and_retired_epoch(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    state._owner_epoch = retired_epoch = object()
    before = storage.pointer, state.device_token, state.user_id, state.paired_at, credential_scope(state)
    storage.replace_pointer = lambda *_args: (_ for _ in ()).throw(OSError("new-private exception"))
    assert_code("write_failed", lambda: commit_state_credentials(tmp_path, state, device=CredentialIntent("set", "new-private"),
        expected_device_revision=1, expected_owner_epoch=retired_epoch, device_owner=("owner-b", "paired-b")))
    assert (storage.pointer, state.device_token, state.user_id, state.paired_at, credential_scope(state)) == before
    assert state._owner_epoch is retired_epoch


def test_same_intent_state_retry_reuses_generation_and_commits_latest_nonsecret_projection(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    replacement = storage.replace_pointer
    storage.replace_pointer = lambda *_args: (_ for _ in ()).throw(OSError("retryable failure"))
    assert_code("write_failed", lambda: commit_state_credentials(tmp_path, state,
        obs=CredentialIntent("set", "retry-private"), expected_obs_revision=1))
    staged = dict(storage.generations)
    state.window_page = "settings"
    crypto.protect = lambda *_args: pytest.fail("retry encrypted another generation")
    storage.replace_pointer = replacement
    commit_state_credentials(tmp_path, state, obs=CredentialIntent("set", "retry-private"), expected_obs_revision=1)
    assert storage.generations == staged and state.obs_password == "retry-private"
    assert json.loads(storage.pointer)["window_page"] == "settings"


def test_changed_slot_revision_and_device_epoch_are_checked_before_any_candidate_output(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    state._owner_epoch = epoch = object()
    before = storage.pointer, dict(storage.generations)
    for arguments in (
        {"expected_device_revision": True, "expected_owner_epoch": epoch},
        {"expected_device_revision": 0, "expected_owner_epoch": epoch},
        {"expected_device_revision": 1, "expected_owner_epoch": object()},
        {"expected_device_revision": 1},
    ):
        assert_code("conflict", lambda: commit_state_credentials(tmp_path, state, device=CredentialIntent("set", "rejected-private"),
            device_owner=("owner-b", "paired-b"), **arguments))
        assert (storage.pointer, storage.generations) == before


def test_obs_local_set_survives_cloud_epoch_change_and_unreadable_device_keep(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    reference = json.loads(storage.pointer)["credentials"]["device"]
    encrypted = storage.generations[reference["generation"]]
    del crypto.plaintexts[encrypted]
    state = load_state(tmp_path, storage=storage, crypto=crypto)
    assert state.device_token is None and credential_status(state, "device") == "unreadable"
    state._owner_epoch = object()
    commit_state_credentials(tmp_path, state, obs=CredentialIntent("set", "local-new-private"), expected_obs_revision=1)
    assert state.obs_password == "local-new-private" and state.device_token is None
    assert json.loads(storage.pointer)["credentials"]["device"] == reference
    assert storage.generations[reference["generation"]] == encrypted


def test_failed_revoked_clear_retains_opaque_reference_but_never_revives_runtime_token_on_keep(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    state._owner_epoch = epoch = object()
    before = storage.pointer
    replacement = storage.replace_pointer
    storage.replace_pointer = lambda *_args: (_ for _ in ()).throw(OSError("clear failed"))
    assert_code("write_failed", lambda: commit_state_credentials(tmp_path, state, device=CredentialIntent("clear"),
        expected_device_revision=1, expected_owner_epoch=epoch))
    mark_device_retired(state, durable=False)
    assert state.device_token is None and credential_status(state, "device") == "retired"
    assert storage.pointer == before
    assert_code("conflict", lambda: mark_device_retired(state, durable=True))
    storage.replace_pointer = replacement
    state.window_page = "help"
    save_state(tmp_path, state)
    assert state.device_token is None and credential_status(state, "device") == "retired"
    assert json.loads(storage.pointer)["credentials"]["device"] == json.loads(before)["credentials"]["device"]
    assert load_state(tmp_path, storage=storage, crypto=crypto).device_token == "old-device-private"  # restart was not promised cleared
    commit_state_credentials(tmp_path, state, device=CredentialIntent("clear"),
        expected_device_revision=1, expected_owner_epoch=epoch)
    assert state.device_token is None and credential_status(state, "device") == "cleared"
    assert load_state(tmp_path, storage=storage, crypto=crypto).device_token is None


def test_indeterminate_commit_does_not_publish_candidate_and_blocks_ordinary_keep(tmp_path):
    state, storage, crypto = initialized(tmp_path)
    old_value = state.obs_password
    def uncertain(_expected, data):
        document = json.loads(data)
        document["window_page"] = "settings"
        storage.pointer = json.dumps(document).encode()
        raise OSError("unknown outcome")
    storage.replace_pointer = uncertain
    assert_code("indeterminate", lambda: commit_state_credentials(tmp_path, state,
        obs=CredentialIntent("set", "uncertain-private"), expected_obs_revision=1))
    assert state.obs_password == old_value and credential_status(state, "obs") == "unreadable"
    actual = storage.pointer
    assert_code("invalid_pointer", lambda: save_state(tmp_path, state))
    assert storage.pointer == actual


@pytest.mark.parametrize("initial,changed", [(None, "owner-a"), ("owner-a", None)], ids=["unknown-to-known", "known-to-unknown"])
def test_nullable_device_owner_binding_cannot_be_reassigned_by_plain_metadata_change(tmp_path, initial, changed):
    state, storage, crypto = initialized(tmp_path, user_id=initial, paired_at=None)
    original = storage.pointer
    state.user_id = changed
    assert_code("invalid_intent", lambda: save_state(tmp_path, state))
    assert storage.pointer == original
    document = json.loads(original)
    document["user_id"] = changed
    storage.pointer = json.dumps(document).encode()
    loaded = load_state(tmp_path, storage=storage, crypto=crypto)
    assert loaded.device_token is None and credential_status(loaded, "device") == "unreadable"
    assert loaded.obs_password == "old-obs-private"


def test_unmanaged_selected_target_is_keep_only_when_fields_and_revision_match(tmp_path):
    state, storage, crypto = initialized(tmp_path, user_id=None, paired_at=None)
    other = AgentState(device_token=state.device_token, obs_password=state.obs_password,
        uploaded=dict(state.uploaded), window_page="help")
    save_state(tmp_path, other, storage=storage, crypto=crypto)
    assert json.loads(storage.pointer)["window_page"] == "help" and credential_revision(other, "device") == 1
    before = storage.pointer
    assert_code("invalid_intent", lambda: save_state(tmp_path, AgentState(device_token="different-private"),
        storage=storage, crypto=crypto))
    assert storage.pointer == before


def test_unknown_nonsecret_fields_survive_later_ordinary_save_and_large_uploaded_state(tmp_path, acquired_guard):
    uploaded = {"root/" + str(index) + "/" + "x" * 70 + ".SC2Replay": "2026-11-01" for index in range(1200)}
    document = {"device_token": "legacy-private", "user_id": None, "paired_at": None,
        "uploaded": uploaded, "future_preferences": {"keep": [1, 2, 3]}}
    storage, crypto = MemoryStorage(json.dumps(document).encode()), SyntheticCrypto()
    state = migrate_legacy_state(tmp_path, acquired_guard, storage=storage, crypto=crypto)
    state.window_page = "help"
    save_state(tmp_path, state)
    actual = json.loads(storage.pointer)
    assert len(storage.pointer) > 65536 and actual["uploaded"] == uploaded
    assert actual["future_preferences"] == {"keep": [1, 2, 3]} and actual["window_page"] == "help"
