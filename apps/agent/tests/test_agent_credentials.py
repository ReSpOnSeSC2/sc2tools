"""Direct dormant transaction contracts, using finite synthetic IO and crypto."""
from dataclasses import FrozenInstanceError, replace
import hashlib
import itertools
import json

import pytest

from sc2tools_agent.agent_credentials import (
    CredentialIntent, CredentialSelection, CredentialStorageError, PreparedGeneration,
    PreparedTransaction, SlotReference, commit_transaction, load_credentials, prepare_transaction,
)
from sc2tools_agent.state import _STATE_SAVE_LOCK


class SyntheticCrypto:
    """A finite lookup cipher for tests; no native crypto or filesystem calls."""
    def __init__(self):
        self.plaintexts = {}
        self.ids = itertools.count(1)

    def generation_id(self):
        return f"{next(self.ids):032x}"

    def protect(self, data):
        encrypted = b"synthetic-credential:" + hashlib.sha256(data).digest()
        self.plaintexts[encrypted] = data
        return encrypted

    def unprotect(self, data):
        if data not in self.plaintexts:
            raise RuntimeError("private native failure must not escape")
        return self.plaintexts[data]


class MemoryStorage:
    def __init__(self, pointer=None, *, store_id=b"synthetic-installation-one"):
        self.pointer, self.store_id = pointer, store_id
        self.generations, self.events = {}, []

    def identity(self):
        return self.store_id

    def read_pointer(self):
        return self.pointer

    def read_generation(self, name):
        self.events.append(("read", name))
        if name not in self.generations:
            raise CredentialStorageError("missing")
        return self.generations[name]

    def create_generation(self, name, data):
        if name in self.generations:
            raise CredentialStorageError("write_failed")
        self.events.append(("create", name))
        self.generations[name] = data

    def replace_pointer(self, expected, data):
        if self.pointer != expected:
            raise CredentialStorageError("conflict")
        self.events.append(("replace",))
        self.pointer = data

    def capacity(self):
        return len(self.generations), sum(len(value) for value in self.generations.values())


def projection(**changes):
    value = {"user_id": "owner-a", "paired_at": "2026-11-02T12:00:00+00:00",
        "uploaded": {"kept.SC2Replay": "2026-11-01T12:00:00+00:00"}, "window_page": "help"}
    value.update(changes)
    return json.dumps(value).encode("utf-8")


def prepare(storage, crypto, *, device=CredentialIntent(), obs=CredentialIntent(), document=None):
    return prepare_transaction(load_credentials(storage, crypto), projection() if document is None else document,
        crypto=crypto, device=device, obs=obs, generation_id=crypto.generation_id)


def seed(*, device="synthetic-device-secret", obs="synthetic-obs-secret"):
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    prepared = prepare(storage, crypto, device=CredentialIntent("set", device), obs=CredentialIntent("set", obs))
    commit_transaction(storage, crypto, prepared)
    storage.events.clear()
    return storage, crypto


def assert_code(code, callback):
    with pytest.raises(CredentialStorageError) as caught:
        callback()
    assert str(caught.value) == caught.value.code == code
    return caught.value


def test_full_document_and_both_encrypted_generations_publish_pointer_last_under_reentrant_writer_lock():
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    missing = load_credentials(storage, crypto)
    assert missing.status == missing.device.status == missing.obs.status == "missing"
    assert missing.selection == CredentialSelection()
    prepared = prepare(storage, crypto, device=CredentialIntent("set", "synthetic-device-secret"),
        obs=CredentialIntent("set", "synthetic-obs-secret"))
    assert storage.pointer is None and storage.generations == {}
    with _STATE_SAVE_LOCK:
        committed = commit_transaction(storage, crypto, prepared)
    document = json.loads(storage.pointer)
    assert committed.document == storage.pointer == prepared.document
    assert document["uploaded"] == {"kept.SC2Replay": "2026-11-01T12:00:00+00:00"}
    assert document["window_page"] == "help" and document["user_id"] == "owner-a"
    assert "device_token" not in document and "obs_password" not in document
    assert document["credentials"]["version"] == 1
    assert [document["credentials"][slot]["revision"] for slot in ("device", "obs")] == [1, 1]
    assert storage.events[-1] == ("replace",)
    assert len(storage.generations) == 2
    for data in (storage.pointer, *storage.generations.values()):
        assert b"synthetic-device-secret" not in data and b"synthetic-obs-secret" not in data
    loaded = load_credentials(storage, crypto)
    assert loaded.device.value == "synthetic-device-secret" and loaded.obs.value == "synthetic-obs-secret"
    assert loaded.device.status == loaded.obs.status == "available"
    for value in (prepared, committed, loaded, loaded.device, CredentialIntent("set", "synthetic-device-secret")):
        assert "synthetic-device-secret" not in repr(value) and "synthetic-obs-secret" not in repr(value)


def test_load_is_read_only_and_never_falls_back_to_legacy_or_orphan_credentials():
    storage, crypto = seed()
    storage.pointer = b'{"device_token":"legacy-private","obs_password":"legacy-private"}'
    prior_generations = dict(storage.generations)
    loaded = load_credentials(storage, crypto)
    assert loaded.status == "unreadable" and loaded.code == "invalid_pointer"
    assert loaded.device.value is None and loaded.obs.value is None
    assert storage.events == [] and storage.generations == prior_generations
    assert storage.pointer == b'{"device_token":"legacy-private","obs_password":"legacy-private"}'
    assert_code("invalid_pointer", lambda: prepare_transaction(loaded, projection(), crypto=crypto))


def test_selected_clear_ignores_coexisting_legacy_plaintext_and_unselected_files():
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    prepared = prepare(storage, crypto, device=CredentialIntent("clear"), obs=CredentialIntent("clear"))
    commit_transaction(storage, crypto, prepared)
    document = json.loads(storage.pointer)
    document.update(device_token="legacy-private", obs_password="legacy-private")
    storage.pointer = json.dumps(document).encode()
    storage.generations["device-" + "f" * 32 + ".dpapi"] = b"unselected-private"
    storage.events.clear()
    loaded = load_credentials(storage, crypto)
    assert loaded.device.status == loaded.obs.status == "cleared"
    assert loaded.device.value is None and loaded.obs.value is None and storage.events == []


def test_keep_preserves_exact_unreadable_other_reference_and_bytes():
    storage, crypto = seed()
    device_reference = json.loads(storage.pointer)["credentials"]["device"]
    device_bytes = storage.generations[device_reference["generation"]]
    del crypto.plaintexts[device_bytes]
    loaded = load_credentials(storage, crypto)
    assert loaded.device.status == "unreadable" and loaded.device.code == "unavailable"
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "replacement-obs-secret"))
    commit_transaction(storage, crypto, prepared)
    assert json.loads(storage.pointer)["credentials"]["device"] == device_reference
    assert storage.generations[device_reference["generation"]] == device_bytes
    loaded = load_credentials(storage, crypto)
    assert loaded.device.status == "unreadable" and loaded.device.value is None
    assert loaded.obs.value == "replacement-obs-secret"


def test_missing_selected_generation_stays_unreadable_with_exact_reference_and_no_orphan_search():
    storage, crypto = seed()
    reference = json.loads(storage.pointer)["credentials"]["device"]
    del storage.generations[reference["generation"]]
    storage.generations["device-" + "f" * 32 + ".dpapi"] = b"orphan-private"
    loaded = load_credentials(storage, crypto)
    assert loaded.device.status == "unreadable" and loaded.device.code == "missing"
    assert loaded.device.value is None and loaded.device.reference.generation == reference["generation"]
    assert loaded.obs.value == "synthetic-obs-secret"
    assert ("read", "device-" + "f" * 32 + ".dpapi") not in storage.events


def test_clear_requires_no_decryption_or_generation_and_cannot_resurrect_after_reload():
    storage, crypto = seed()
    old_document, old_generations = json.loads(storage.pointer), dict(storage.generations)
    crypto.unprotect = lambda _data: (_ for _ in ()).throw(AssertionError("clear must not decrypt"))
    prepared = prepare(storage, crypto, device=CredentialIntent("clear"))
    commit_transaction(storage, crypto, prepared)
    document = json.loads(storage.pointer)
    assert document["credentials"]["device"] == {"revision": 2, "generation": None}
    assert document["credentials"]["obs"] == old_document["credentials"]["obs"]
    assert storage.generations == old_generations
    loaded = load_credentials(storage, crypto)
    assert loaded.device.status == "cleared" and loaded.device.value is None
    assert loaded.obs.status == "unreadable"


def test_exact_raw_document_cas_rejects_metadata_or_whitespace_changes_before_any_generation_write():
    storage, crypto = seed()
    storage.pointer = json.dumps(json.loads(storage.pointer), indent=2).encode()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "not-admitted-secret"))
    assert prepared.expected == storage.pointer
    changed = storage.pointer + b"\n"
    storage.pointer = changed
    prior = dict(storage.generations)
    assert_code("conflict", lambda: commit_transaction(storage, crypto, prepared))
    assert storage.pointer == changed and storage.generations == prior
    assert not any(event[0] == "create" for event in storage.events)


def test_nonsecret_state_larger_than_a_generation_is_preserved_without_a_credential_sized_document_cap():
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    uploaded = {f"root/{index:04d}/" + "x" * 60 + ".SC2Replay": "2026-11-01T12:00:00+00:00" for index in range(1200)}
    prepared = prepare(storage, crypto, document=projection(uploaded=uploaded), obs=CredentialIntent("set", "small-private"))
    commit_transaction(storage, crypto, prepared)
    assert len(storage.pointer) > 65536 and json.loads(storage.pointer)["uploaded"] == uploaded
    assert load_credentials(storage, crypto).obs.value == "small-private"


def test_prepared_operations_are_bound_to_the_physical_store_even_with_identical_raw_pointer():
    storage, crypto = seed()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "not-for-second-installation"))
    other = MemoryStorage(storage.pointer, store_id=b"different-installation")
    other.generations = dict(storage.generations)
    prior = dict(other.generations)
    assert_code("conflict", lambda: commit_transaction(other, crypto, prepared))
    assert other.pointer == prepared.expected and other.generations == prior and other.events == []


def test_store_retirement_after_create_or_decrypt_suppresses_actual_pointer_output():
    for during in ("create", "decrypt"):
        storage, crypto = MemoryStorage(), SyntheticCrypto()
        prepared = prepare(storage, crypto, obs=CredentialIntent("set", "retired-private"))
        original = storage.create_generation if during == "create" else crypto.unprotect
        def retire(*args):
            result = original(*args)
            storage.store_id = b"retired-installation"
            return result
        if during == "create":
            storage.create_generation = retire
        else:
            crypto.unprotect = retire
        assert_code("conflict", lambda: commit_transaction(storage, crypto, prepared))
        assert storage.pointer is None
        assert b"retired-private" not in b"".join(storage.generations.values())


def test_pointer_retirement_during_decryption_suppresses_the_entire_loaded_secret_snapshot():
    storage, crypto = seed()
    changed = json.loads(storage.pointer)
    changed["window_page"] = "settings"
    changed = json.dumps(changed).encode()
    unprotect = crypto.unprotect
    def replace_during_decrypt(data):
        plain = unprotect(data)
        storage.pointer = changed
        return plain
    crypto.unprotect = replace_during_decrypt
    loaded = load_credentials(storage, crypto)
    assert loaded.status == "unreadable" and loaded.code == "conflict"
    assert loaded.device.value is None and loaded.obs.value is None and storage.pointer == changed


@pytest.mark.parametrize("binding", ["slot", "generation", "revision", "owner"], ids=["slot", "generation", "revision", "owner"])
def test_decrypted_envelope_must_match_selected_slot_generation_revision_and_same_document_owner(binding):
    storage, crypto = seed()
    reference = json.loads(storage.pointer)["credentials"]["device"]
    encrypted = storage.generations[reference["generation"]]
    envelope = json.loads(crypto.plaintexts[encrypted])
    envelope[binding] = {"slot": "obs", "generation": "device-" + "f" * 32 + ".dpapi", "revision": 2,
        "owner": {"user_id": "owner-b", "paired_at": "2026-11-02T12:00:00+00:00"}}[binding]
    crypto.plaintexts[encrypted] = json.dumps(envelope).encode()
    loaded = load_credentials(storage, crypto)
    assert loaded.device.status == "unreadable" and loaded.device.code == "invalid_generation"
    assert loaded.device.value is None and loaded.obs.value == "synthetic-obs-secret"
    assert loaded.device.reference.generation == reference["generation"]


def test_keep_cannot_rebind_a_device_secret_to_changed_owner_metadata():
    storage, crypto = seed()
    assert_code("invalid_intent", lambda: prepare(storage, crypto,
        document=projection(user_id="owner-b"), obs=CredentialIntent("set", "obs-private")))
    assert load_credentials(storage, crypto).device.value == "synthetic-device-secret"


@pytest.mark.parametrize("failure", ["create", "readback", "decrypt"], ids=["create", "readback", "decrypt"])
def test_precommit_failures_preserve_actual_pointer_and_never_activate_candidate(failure):
    storage, crypto = seed()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "candidate-private"))
    old_pointer = storage.pointer
    if failure == "create":
        storage.create_generation = lambda *_args: (_ for _ in ()).throw(RuntimeError("candidate-private raw OS cause"))
        code = "write_failed"
    elif failure == "readback":
        create = storage.create_generation
        def corrupt(name, data):
            create(name, data)
            storage.generations[name] = b"partial-ciphertext"
        storage.create_generation = corrupt
        code = "invalid_generation"
    else:
        crypto.unprotect = lambda _data: (_ for _ in ()).throw(RuntimeError("candidate-private native cause"))
        code = "unavailable"
    error = assert_code(code, lambda: commit_transaction(storage, crypto, prepared))
    assert error.__context__ is None and error.__cause__ is None
    assert storage.pointer == old_pointer and ("replace",) not in storage.events
    assert "candidate-private" not in repr(error) and "candidate-private" not in repr(prepared)


def test_same_prepared_retry_reuses_exact_generation_after_definite_pointer_failure():
    storage, crypto = seed()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "retried-private"))
    old_pointer = storage.pointer
    replace_pointer = storage.replace_pointer
    storage.replace_pointer = lambda *_args: (_ for _ in ()).throw(OSError("private OS cause"))
    assert_code("write_failed", lambda: commit_transaction(storage, crypto, prepared))
    staged = dict(storage.generations)
    assert storage.pointer == old_pointer
    storage.replace_pointer = replace_pointer
    commit_transaction(storage, crypto, prepared)
    assert storage.generations == staged and len(staged) == 3
    assert load_credentials(storage, crypto).obs.value == "retried-private"
    assert commit_transaction(storage, crypto, prepared).document == storage.pointer
    assert storage.generations == staged


def test_replace_that_committed_then_raised_is_resolved_by_exact_actual_document():
    storage, crypto = seed()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "committed-private"))
    replace_pointer = storage.replace_pointer
    def committed_then_error(expected, data):
        replace_pointer(expected, data)
        raise OSError("unreliable return after commit")
    storage.replace_pointer = committed_then_error
    assert commit_transaction(storage, crypto, prepared).document == prepared.document == storage.pointer
    assert load_credentials(storage, crypto).obs.value == "committed-private"


def test_indeterminate_replace_does_not_restore_old_pointer_or_guess_success():
    storage, crypto = seed()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "uncertain-private"))
    third = json.loads(prepared.document)
    third["window_page"] = "settings"
    third_bytes = json.dumps(third).encode()
    def uncertain(_expected, _data):
        storage.pointer = third_bytes
        raise OSError("unknown commit result")
    storage.replace_pointer = uncertain
    assert_code("indeterminate", lambda: commit_transaction(storage, crypto, prepared))
    assert storage.pointer == third_bytes and storage.pointer != prepared.expected
    assert_code("conflict", lambda: commit_transaction(storage, crypto, prepared))
    assert storage.pointer == third_bytes


def test_unreadable_post_replace_is_indeterminate_then_exact_retry_can_resolve():
    storage, crypto = seed()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "committed-private"))
    replace_pointer, read_pointer = storage.replace_pointer, storage.read_pointer
    def replace_and_lose_reader(expected, data):
        replace_pointer(expected, data)
        storage.read_pointer = lambda: (_ for _ in ()).throw(OSError("reader unavailable"))
    storage.replace_pointer = replace_and_lose_reader
    assert_code("indeterminate", lambda: commit_transaction(storage, crypto, prepared))
    assert storage.pointer == prepared.document
    storage.read_pointer = read_pointer
    assert commit_transaction(storage, crypto, prepared).document == storage.pointer
    assert load_credentials(storage, crypto).obs.value == "committed-private"


def test_failed_clear_keeps_old_durable_value_and_successful_clear_increments_revision():
    storage, crypto = seed()
    prepared = prepare(storage, crypto, obs=CredentialIntent("clear"))
    old = storage.pointer
    replacement = storage.replace_pointer
    storage.replace_pointer = lambda *_args: None
    assert_code("write_failed", lambda: commit_transaction(storage, crypto, prepared))
    assert storage.pointer == old and load_credentials(storage, crypto).obs.value == "synthetic-obs-secret"
    storage.replace_pointer = replacement
    commit_transaction(storage, crypto, prepared)
    assert json.loads(storage.pointer)["credentials"]["obs"] == {"revision": 2, "generation": None}
    assert load_credentials(storage, crypto).obs.status == "cleared"


def test_stale_same_value_set_cannot_cross_a_later_slot_revision():
    storage, crypto = seed()
    first = prepare(storage, crypto, obs=CredentialIntent("set", "same-private"))
    second = prepare(storage, crypto, obs=CredentialIntent("set", "same-private"))
    commit_transaction(storage, crypto, second)
    actual = storage.pointer
    assert_code("conflict", lambda: commit_transaction(storage, crypto, first))
    assert storage.pointer == actual and json.loads(actual)["credentials"]["obs"]["revision"] == 2
    assert load_credentials(storage, crypto).obs.value == "same-private"


def test_literal_secret_and_ciphertext_caps_reject_before_any_storage_output():
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    accepted = prepare(storage, crypto, obs=CredentialIntent("set", "x" * 16384))
    commit_transaction(storage, crypto, accepted)
    assert load_credentials(storage, crypto).obs.value == "x" * 16384
    assert_code("invalid_intent", lambda: CredentialIntent("set", "x" * 16385))
    crypto.protect = lambda _plain: b"x" * 65537
    before = storage.pointer
    assert_code("invalid_generation", lambda: prepare(storage, crypto, obs=CredentialIntent("set", "small")))
    assert storage.pointer == before and len(storage.generations) == 1


def test_literal_generation_count_cap_prevents_actual_new_file_or_pointer_output():
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "capacity-private"))
    storage.capacity = lambda: (128, 0)
    assert_code("store_full", lambda: commit_transaction(storage, crypto, prepared))
    assert storage.pointer is None and storage.generations == {}
    storage.capacity = lambda: (127, 0)
    commit_transaction(storage, crypto, prepared)
    assert storage.pointer == prepared.document and len(storage.generations) == 1


@pytest.mark.parametrize("capacity", [(True, 1), (0, -1), [0, 0], (0, 8388608)], ids=["bool", "negative", "mutable", "byte-defense"])
def test_invalid_or_exhausted_capacity_never_outputs_a_pointer(capacity):
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "capacity-private"))
    storage.capacity = lambda: capacity
    assert_code("store_full" if capacity == (0, 8388608) else "unavailable",
        lambda: commit_transaction(storage, crypto, prepared))
    assert storage.pointer is None and storage.generations == {}


@pytest.mark.parametrize("mutation", ["version-bool", "revision-bool", "revision-float", "escape", "foreign-slot", "unknown"],
    ids=["version-bool", "revision-bool", "revision-float", "escape", "foreign-slot", "unknown"])
def test_strict_selector_rejects_invalid_primitive_values_before_generation_reads(mutation):
    storage, crypto = seed()
    document = json.loads(storage.pointer)
    credentials = document["credentials"]
    if mutation == "version-bool": credentials["version"] = True
    elif mutation == "revision-bool": credentials["device"]["revision"] = True
    elif mutation == "revision-float": credentials["device"]["revision"] = 1.0
    elif mutation == "escape": credentials["device"]["generation"] = "../private.dpapi"
    elif mutation == "foreign-slot": credentials["device"]["generation"] = credentials["obs"]["generation"]
    else: credentials["extra"] = "private"
    storage.pointer = json.dumps(document).encode()
    storage.events.clear()
    loaded = load_credentials(storage, crypto)
    assert loaded.status == "unreadable" and loaded.code == "invalid_pointer"
    assert loaded.device.value is None and loaded.obs.value is None and storage.events == []


@pytest.mark.parametrize("raw", [b'{"credentials":{},"credentials":{}}', b'{"x":NaN}', b'\xff', b'[]'],
    ids=["duplicates", "nonfinite", "invalid-utf8", "wrong-shape"])
def test_unreadable_pointer_is_preserved_and_cannot_be_blindly_committed(raw):
    storage, crypto = MemoryStorage(raw), SyntheticCrypto()
    loaded = load_credentials(storage, crypto)
    assert loaded.status == "unreadable" and loaded.raw == raw and loaded.code == "invalid_pointer"
    assert_code("invalid_pointer", lambda: prepare_transaction(loaded, projection(), crypto=crypto))
    assert storage.pointer == raw and storage.generations == {}


def test_excessively_nested_document_fails_closed_without_exposing_its_raw_parse_exception():
    storage, crypto = MemoryStorage(b'{"nested":' + b'[' * 10000 + b'0' + b']' * 10000 + b'}'), SyntheticCrypto()
    loaded = load_credentials(storage, crypto)
    assert loaded.status == "unreadable" and loaded.code == "invalid_pointer"
    assert storage.pointer == loaded.raw and storage.generations == {}


def test_direct_values_are_immutable_and_cannot_smuggle_coercions_or_plaintext_into_commit():
    touched = []
    class Private:
        def __str__(self): touched.append("str"); return "private"
        def __bool__(self): touched.append("bool"); return True
        def __eq__(self, _other): touched.append("eq"); return True
    private = Private()
    assert_code("invalid_intent", lambda: CredentialIntent(private))
    assert_code("invalid_intent", lambda: CredentialIntent("set", private))
    assert_code("invalid_pointer", lambda: SlotReference(private))
    assert_code("invalid_pointer", lambda: SlotReference(1, private))
    assert touched == []
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    prepared = prepare(storage, crypto, obs=CredentialIntent("set", "private"))
    with pytest.raises(FrozenInstanceError): prepared.document = b"changed"
    assert_code("invalid_pointer", lambda: PreparedTransaction(prepared.store_id, None, bytearray(prepared.document)))
    assert_code("invalid_generation", lambda: PreparedGeneration("obs", "obs-" + "1" * 32 + ".dpapi", 1, bytearray(b"mutable")))
    forged = json.loads(prepared.document)
    forged["device_token"] = "raw-private"
    unsafe = replace(prepared, document=json.dumps(forged).encode())
    assert_code("invalid_pointer", lambda: commit_transaction(storage, crypto, unsafe))
    forged.pop("device_token")
    forged["credentials"]["obs"]["revision"] = 3
    unsafe = replace(prepared, document=json.dumps(forged).encode())
    assert_code("invalid_generation", lambda: commit_transaction(storage, crypto, unsafe))
    assert storage.pointer is None and storage.generations == {}


def test_prepared_generation_rejects_missing_name_with_closed_error():
    error = assert_code("invalid_generation", lambda: PreparedGeneration("obs", None, 1, b"x"))
    assert error.__context__ is None and error.__cause__ is None


def test_protect_and_invalid_unicode_errors_do_not_retain_raw_exception_context():
    storage, crypto = MemoryStorage(), SyntheticCrypto()
    crypto.protect = lambda _data: (_ for _ in ()).throw(RuntimeError("raw-private-native-error"))
    error = assert_code("unavailable", lambda: prepare(storage, crypto, obs=CredentialIntent("set", "raw-private")))
    assert error.__context__ is None and error.__cause__ is None and str(error) == "unavailable"
    error = assert_code("invalid_intent", lambda: CredentialIntent("set", "raw-private\ud800"))
    assert error.__context__ is None and error.__cause__ is None
    assert storage.pointer is None and storage.generations == {}
