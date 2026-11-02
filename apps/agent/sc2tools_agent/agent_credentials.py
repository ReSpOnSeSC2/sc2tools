"""Dormant agent credential transactions; no runtime callers or implicit migration.

The injected storage owns finite, handle-checked IO. Only the complete JSON
document is a commit pointer; generations are immutable and written first.
Ordinary state loading/saving and the OAuth secret-store APIs are unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
import json
import re
from typing import Callable, Protocol
import uuid

from .state import _STATE_SAVE_LOCK

MAX_SECRET_BYTES = 16 * 1024
MAX_GENERATION_BYTES = 64 * 1024
MAX_GENERATIONS = 128
MAX_GENERATION_TOTAL_BYTES = 8 * 1024 * 1024
MAX_ENVELOPE_BYTES = 128 * 1024
MAX_REVISION = (1 << 63) - 1
_NAME = re.compile(r"(device|obs)-[0-9a-f]{32}\.dpapi", re.ASCII)
_CODES = frozenset({"missing", "unavailable", "unsafe_path", "invalid_pointer", "invalid_generation",
    "invalid_intent", "conflict", "store_full", "write_failed", "indeterminate"})


class CredentialStorageError(Exception):
    """A closed code only: never retain an IO/crypto exception or secret."""
    def __init__(self, code):
        if type(code) is not str or code not in _CODES:
            raise ValueError("invalid_credential_error")
        self.code = code
        super().__init__(code)


class CredentialStorage(Protocol):
    def identity(self) -> bytes: ...
    def read_pointer(self) -> bytes | None: ...
    def read_generation(self, name: str) -> bytes: ...
    def create_generation(self, name: str, data: bytes) -> None: ...
    def replace_pointer(self, expected: bytes | None, data: bytes) -> None: ...
    def capacity(self) -> tuple[int, int]: ...


class CredentialCrypto(Protocol):
    def protect(self, data: bytes) -> bytes: ...
    def unprotect(self, data: bytes) -> bytes: ...


@dataclass(frozen=True)
class SlotReference:
    revision: int = 0
    generation: str | None = None

    def __post_init__(self):
        if type(self.revision) is not int or not 0 <= self.revision <= MAX_REVISION:
            raise CredentialStorageError("invalid_pointer")
        if self.generation is not None and (type(self.generation) is not str
            or _NAME.fullmatch(self.generation) is None or self.revision == 0):
            raise CredentialStorageError("invalid_pointer")


@dataclass(frozen=True)
class CredentialSelection:
    device: SlotReference = SlotReference()
    obs: SlotReference = SlotReference()

    def __post_init__(self):
        for slot in ("device", "obs"):
            reference = getattr(self, slot)
            if type(reference) is not SlotReference or (reference.generation is not None
                and not reference.generation.startswith(slot + "-")):
                raise CredentialStorageError("invalid_pointer")


@dataclass(frozen=True)
class CredentialIntent:
    operation: str = "keep"
    value: str | None = field(default=None, repr=False)

    def __post_init__(self):
        if type(self.operation) is not str or self.operation not in ("keep", "set", "clear"):
            raise CredentialStorageError("invalid_intent")
        if self.operation == "set":
            _secret(self.value)
        elif self.value is not None:
            raise CredentialStorageError("invalid_intent")


KEEP = CredentialIntent()


@dataclass(frozen=True)
class LoadedSlot:
    reference: SlotReference | None
    status: str
    value: str | None = field(default=None, repr=False)
    code: str = "ok"

    def __post_init__(self):
        if (self.reference is not None and type(self.reference) is not SlotReference
            or type(self.status) is not str or self.status not in ("missing", "cleared", "available", "unreadable")
            or type(self.code) is not str or self.code not in _CODES | {"ok"}):
            raise CredentialStorageError("invalid_pointer")
        if self.status == "available":
            _secret(self.value)
            if self.reference is None or self.reference.generation is None or self.code != "ok":
                raise CredentialStorageError("invalid_pointer")
        elif self.value is not None:
            raise CredentialStorageError("invalid_pointer")
        if self.status == "cleared" and (self.reference is None or self.reference.generation is not None):
            raise CredentialStorageError("invalid_pointer")
        if self.status == "missing" and (self.reference is not None or self.code != "ok"):
            raise CredentialStorageError("invalid_pointer")
        if self.status == "unreadable":
            if self.code == "ok" or self.reference is not None and self.reference.generation is None:
                raise CredentialStorageError("invalid_pointer")
        elif self.code != "ok":
            raise CredentialStorageError("invalid_pointer")


def _valid_code(value):
    return type(value) is str and value in _CODES | {"ok"}


@dataclass(frozen=True)
class CredentialSnapshot:
    status: str
    selection: CredentialSelection | None
    device: LoadedSlot
    obs: LoadedSlot
    raw: bytes | None = field(default=None, repr=False)
    code: str = "ok"
    store_id: bytes | None = field(default=None, repr=False)

    def __post_init__(self):
        if (type(self.status) is not str or self.status not in ("missing", "selected", "unreadable")
            or self.selection is not None and type(self.selection) is not CredentialSelection
            or type(self.device) is not LoadedSlot or type(self.obs) is not LoadedSlot
            or self.raw is not None and type(self.raw) is not bytes or not _valid_code(self.code)):
            raise CredentialStorageError("invalid_pointer")
        if self.store_id is not None:
            _identity_value(self.store_id)
        if self.status == "selected" and (self.selection is None or self.raw is None
            or self.device.reference != self.selection.device or self.obs.reference != self.selection.obs or self.code != "ok"):
            raise CredentialStorageError("invalid_pointer")
        if self.status == "missing" and (self.raw is not None or self.selection != CredentialSelection()
            or self.device.status != "missing" or self.obs.status != "missing" or self.code != "ok" or self.store_id is None):
            raise CredentialStorageError("invalid_pointer")
        if self.status == "unreadable" and (self.selection is not None or self.code == "ok"
            or self.device.status != "unreadable" or self.obs.status != "unreadable"):
            raise CredentialStorageError("invalid_pointer")


@dataclass(frozen=True)
class PreparedGeneration:
    slot: str
    name: str
    revision: int
    encrypted: bytes = field(repr=False)

    def __post_init__(self):
        if type(self.slot) is not str or self.slot not in ("device", "obs"):
            raise CredentialStorageError("invalid_generation")
        if type(self.name) is not str:
            raise CredentialStorageError("invalid_generation")
        reference = SlotReference(self.revision, self.name)
        if not reference.generation.startswith(self.slot + "-"):
            raise CredentialStorageError("invalid_generation")
        _encrypted(self.encrypted)


@dataclass(frozen=True)
class PreparedTransaction:
    store_id: bytes = field(repr=False)
    expected: bytes | None = field(repr=False)
    document: bytes = field(repr=False)
    generations: tuple[PreparedGeneration, ...] = ()
    legacy: bool = False

    def __post_init__(self):
        _identity_value(self.store_id)
        if (type(self.legacy) is not bool or (self.expected is not None and type(self.expected) is not bytes) or type(self.document) is not bytes
            or type(self.generations) is not tuple or len(self.generations) > 2
            or any(type(item) is not PreparedGeneration for item in self.generations)):
            raise CredentialStorageError("invalid_pointer")
        if len({item.slot for item in self.generations}) != len(self.generations):
            raise CredentialStorageError("invalid_generation")


@dataclass(frozen=True)
class CredentialCommit:
    selection: CredentialSelection
    document: bytes = field(repr=False)

    def __post_init__(self):
        if type(self.selection) is not CredentialSelection or type(self.document) is not bytes:
            raise CredentialStorageError("invalid_pointer")
        if _selection(_document(self.document)) != self.selection:
            raise CredentialStorageError("invalid_pointer")


def _secret(value):
    if type(value) is not str or not value:
        raise CredentialStorageError("invalid_intent")
    try:
        encoded = value.encode("utf-8", errors="strict")
    except UnicodeError:
        encoded = None
    if encoded is None:
        raise CredentialStorageError("invalid_intent")
    if len(encoded) > MAX_SECRET_BYTES:
        raise CredentialStorageError("invalid_intent")
    return value


def _encrypted(value):
    if type(value) is not bytes or not 0 < len(value) <= MAX_GENERATION_BYTES:
        raise CredentialStorageError("invalid_generation")
    return value


def _call(callback, *args, default="unavailable"):
    try:
        return callback(*args)
    except CredentialStorageError as exc:
        value = exc.code if type(exc) is CredentialStorageError else None
        code = value if type(value) is str and value in _CODES else default
    except Exception:
        code = default
    raise CredentialStorageError(code) from None


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_key")
        result[key] = value
    return result


def _constant(_value):
    raise ValueError("nonfinite_number")


def _document(raw):
    if type(raw) is not bytes:
        raise CredentialStorageError("invalid_pointer")
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_pairs, parse_constant=_constant)
    except (ValueError, UnicodeError, RecursionError):
        value = None
    if type(value) is not dict:
        raise CredentialStorageError("invalid_pointer")
    return value


def _encode(value):
    try:
        encoded = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (ValueError, TypeError, UnicodeError, RecursionError):
        encoded = None
    if encoded is None:
        raise CredentialStorageError("invalid_pointer")
    return encoded


def _selection(document):
    value = document.get("credentials")
    if (type(value) is not dict or set(value) != {"version", "device", "obs"}
        or type(value["version"]) is not int or value["version"] != 1):
        raise CredentialStorageError("invalid_pointer")
    references = []
    for slot in ("device", "obs"):
        item = value[slot]
        if type(item) is not dict or set(item) != {"revision", "generation"}:
            raise CredentialStorageError("invalid_pointer")
        references.append(SlotReference(item["revision"], item["generation"]))
    return CredentialSelection(*references)


def _selector(selection):
    return {"version": 1, **{slot: {"revision": getattr(selection, slot).revision,
        "generation": getattr(selection, slot).generation} for slot in ("device", "obs")}}


def _owner(document):
    values = document.get("user_id"), document.get("paired_at")
    for value in values:
        if value is not None and (type(value) is not str or not value or len(value) > 512
            or any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value)):
            raise CredentialStorageError("invalid_generation")
    return {"user_id": values[0], "paired_at": values[1]}


def _same_owner(left, right):
    return _encode([left.get(key) for key in ("user_id", "paired_at")]) == _encode(
        [right.get(key) for key in ("user_id", "paired_at")])


def _unprotect(crypto, encrypted, slot, reference, document):
    plain = _call(crypto.unprotect, _encrypted(encrypted))
    if type(plain) is not bytes or len(plain) > MAX_ENVELOPE_BYTES:
        raise CredentialStorageError("invalid_generation")
    try:
        envelope = _document(plain)
        if (set(envelope) != {"version", "slot", "generation", "revision", "secret", "owner"}
            or type(envelope["version"]) is not int or envelope["version"] != 1
            or envelope["slot"] != slot or envelope["generation"] != reference.generation
            or type(envelope["revision"]) is not int or envelope["revision"] != reference.revision
            or envelope["owner"] != (_owner(document) if slot == "device" else None)):
            raise CredentialStorageError("invalid_generation")
        value = _secret(envelope["secret"])
    except CredentialStorageError:
        value = None
    if value is None:
        raise CredentialStorageError("invalid_generation")
    return value


def _identity_value(value):
    if type(value) is not bytes or not 1 <= len(value) <= 256:
        raise CredentialStorageError("unavailable")
    return value


def _check_store(storage, store_id):
    if _identity_value(_call(storage.identity)) != store_id:
        raise CredentialStorageError("conflict")


def _bound_call(storage, store_id, callback, *args, default="unavailable"):
    _check_store(storage, store_id)
    try:
        result = _call(callback, *args, default=default)
    except CredentialStorageError:
        _check_store(storage, store_id)
        raise
    _check_store(storage, store_id)
    return result


def _pointer(storage, store_id):
    raw = _bound_call(storage, store_id, storage.read_pointer)
    if raw is not None and type(raw) is not bytes:
        raise CredentialStorageError("invalid_pointer")
    return raw


def _unavailable(code, raw=None, store_id=None):
    slot = LoadedSlot(None, "unreadable", code=code)
    return CredentialSnapshot("unreadable", None, slot, slot, raw, code, store_id)


def load_credentials(storage: CredentialStorage, crypto: CredentialCrypto) -> CredentialSnapshot:
    """Read exactly the selected generations; never migrate, scan or write."""
    with _STATE_SAVE_LOCK:
        try:
            store_id = _identity_value(_call(storage.identity))
        except CredentialStorageError as exc:
            return _unavailable(exc.code)
        try:
            raw = _pointer(storage, store_id)
        except CredentialStorageError as exc:
            return _unavailable(exc.code, store_id=store_id)
        if raw is None:
            slot = LoadedSlot(None, "missing")
            return CredentialSnapshot("missing", CredentialSelection(), slot, slot, store_id=store_id)
        try:
            document = _document(raw)
            selection = _selection(document)
        except CredentialStorageError as exc:
            return _unavailable(exc.code, raw, store_id)
        slots = []
        for name in ("device", "obs"):
            reference = getattr(selection, name)
            if reference.generation is None:
                slots.append(LoadedSlot(reference, "cleared"))
                continue
            try:
                encrypted = _bound_call(storage, store_id, storage.read_generation, reference.generation)
                value = _bound_call(storage, store_id, _unprotect, crypto, encrypted, name, reference, document)
                slots.append(LoadedSlot(reference, "available", value))
            except CredentialStorageError as exc:
                slots.append(LoadedSlot(reference, "unreadable", code=exc.code))
        try:
            if _pointer(storage, store_id) != raw:
                return _unavailable("conflict", store_id=store_id)
        except CredentialStorageError as exc:
            return _unavailable(exc.code, store_id=store_id)
        return CredentialSnapshot("selected", selection, *slots, raw, store_id=store_id)


def _previous(snapshot):
    if type(snapshot) is not CredentialSnapshot or snapshot.status not in ("missing", "selected"):
        raise CredentialStorageError("invalid_pointer")
    _identity_value(snapshot.store_id)
    if snapshot.status == "missing":
        if snapshot.raw is not None or snapshot.selection != CredentialSelection():
            raise CredentialStorageError("invalid_pointer")
        return {}, CredentialSelection()
    document = _document(snapshot.raw)
    selection = _selection(document)
    if selection != snapshot.selection:
        raise CredentialStorageError("invalid_pointer")
    return document, selection


def prepare_transaction(snapshot: CredentialSnapshot, document: bytes, *, crypto: CredentialCrypto,
                        device: CredentialIntent = KEEP, obs: CredentialIntent = KEEP,
                        generation_id: Callable[[], str] = lambda: uuid.uuid4().hex) -> PreparedTransaction:
    """Prepare immutable encrypted bytes; no storage or runtime publication."""
    previous, selected = _previous(snapshot)
    projected = _document(document)
    if any(key in projected for key in ("credentials", "device_token", "obs_password")):
        raise CredentialStorageError("invalid_pointer")
    references, generations = [], []
    for slot, intent in (("device", device), ("obs", obs)):
        if type(intent) is not CredentialIntent:
            raise CredentialStorageError("invalid_intent")
        old = getattr(selected, slot)
        if intent.operation == "keep":
            if slot == "device" and old.generation is not None and not _same_owner(previous, projected):
                raise CredentialStorageError("invalid_intent")
            references.append(old)
            continue
        if old.revision == MAX_REVISION:
            raise CredentialStorageError("conflict")
        revision = old.revision + 1
        if intent.operation == "clear":
            references.append(SlotReference(revision))
            continue
        identity = _call(generation_id, default="invalid_generation")
        if type(identity) is not str or re.fullmatch(r"[0-9a-f]{32}", identity, re.ASCII) is None:
            raise CredentialStorageError("invalid_generation")
        name = slot + "-" + identity + ".dpapi"
        reference = SlotReference(revision, name)
        envelope = {"version": 1, "slot": slot, "generation": name, "revision": revision,
            "secret": intent.value, "owner": _owner(projected) if slot == "device" else None}
        encrypted = _encrypted(_call(crypto.protect, _encode(envelope)))
        if _unprotect(crypto, encrypted, slot, reference, projected) != intent.value:
            raise CredentialStorageError("invalid_generation")
        references.append(reference)
        generations.append(PreparedGeneration(slot, name, revision, encrypted))
    projected["credentials"] = _selector(CredentialSelection(*references))
    return PreparedTransaction(snapshot.store_id, snapshot.raw, _encode(projected), tuple(generations))


def prepare_legacy_transaction(snapshot: CredentialSnapshot, *, crypto: CredentialCrypto,
                               generation_id: Callable[[], str] = lambda: uuid.uuid4().hex) -> PreparedTransaction:
    """Explicit owned-migration admission, never an ordinary read fallback.

    The state-layer caller verifies its acquired instance guard before calling.
    Both stored legacy slots are staged before one full-document publication.
    """
    if (type(snapshot) is not CredentialSnapshot or snapshot.status != "unreadable"
        or snapshot.code != "invalid_pointer" or snapshot.raw is None):
        raise CredentialStorageError("invalid_pointer")
    _identity_value(snapshot.store_id)
    document = _document(snapshot.raw)
    if "credentials" in document:
        raise CredentialStorageError("invalid_pointer")
    intents = []
    for name in ("device_token", "obs_password"):
        value = document.pop(name, None)
        if value is None or type(value) is str and value == "":
            intents.append(CredentialIntent("clear"))
        else:
            intents.append(CredentialIntent("set", value))
    missing = LoadedSlot(None, "missing")
    initial = CredentialSnapshot("missing", CredentialSelection(), missing, missing, store_id=snapshot.store_id)
    prepared = prepare_transaction(initial, _encode(document), crypto=crypto, device=intents[0], obs=intents[1],
        generation_id=generation_id)
    return replace(prepared, expected=snapshot.raw, legacy=True)


def _validate_prepared(prepared):
    if type(prepared) is not PreparedTransaction:
        raise CredentialStorageError("invalid_pointer")
    previous = _document(prepared.expected) if prepared.expected is not None else {}
    if prepared.legacy:
        if prepared.expected is None or "credentials" in previous:
            raise CredentialStorageError("invalid_pointer")
        selected = CredentialSelection()
    else:
        selected = _selection(previous) if prepared.expected is not None else CredentialSelection()
    document = _document(prepared.document)
    if "device_token" in document or "obs_password" in document:
        raise CredentialStorageError("invalid_pointer")
    candidate = _selection(document)
    if prepared.legacy:
        original = {key: value for key, value in previous.items() if key not in ("device_token", "obs_password")}
        current = {key: value for key, value in document.items() if key != "credentials"}
        if _encode(original) != _encode(current) or candidate.device.revision != 1 or candidate.obs.revision != 1:
            raise CredentialStorageError("invalid_pointer")
    staged = {item.slot: item for item in prepared.generations}
    for slot in ("device", "obs"):
        old, new = getattr(selected, slot), getattr(candidate, slot)
        item = staged.get(slot)
        if new == old:
            if item is not None or slot == "device" and old.generation is not None and not _same_owner(previous, document):
                raise CredentialStorageError("invalid_intent")
        elif new.revision != old.revision + 1 or (new.generation is None) != (item is None):
            raise CredentialStorageError("invalid_generation")
        elif item is not None and (item.name != new.generation or item.revision != new.revision):
            raise CredentialStorageError("invalid_generation")
    return document, candidate


def _capacity(storage, store_id, *, additions=0, size=0):
    value = _bound_call(storage, store_id, storage.capacity)
    if (type(value) is not tuple or len(value) != 2
        or any(type(item) is not int or item < 0 for item in value)):
        raise CredentialStorageError("unavailable")
    if value[0] + additions > MAX_GENERATIONS or value[1] + size > MAX_GENERATION_TOTAL_BYTES:
        raise CredentialStorageError("store_full")


def _stage(storage, crypto, item, document, store_id):
    missing = False
    try:
        actual = _bound_call(storage, store_id, storage.read_generation, item.name)
    except CredentialStorageError as exc:
        if exc.code != "missing":
            raise
        missing = True
    if missing:
        _capacity(storage, store_id, additions=1, size=len(item.encrypted))
        _bound_call(storage, store_id, storage.create_generation, item.name, item.encrypted, default="write_failed")
        actual = _bound_call(storage, store_id, storage.read_generation, item.name)
    if type(actual) is not bytes or actual != item.encrypted:
        raise CredentialStorageError("invalid_generation")
    _bound_call(storage, store_id, _unprotect, crypto, actual, item.slot, SlotReference(item.revision, item.name), document)
    _capacity(storage, store_id)


def commit_transaction(storage: CredentialStorage, crypto: CredentialCrypto,
                       prepared: PreparedTransaction) -> CredentialCommit:
    """Publish the full pointer last. A retry reuses the same staged bytes.

    The adapter must compare the exact expected raw document at replacement.
    A caller owns any runtime epoch check under this same reentrant state lock;
    this dormant core never activates an API, OBS client or shared AgentState.
    """
    document, selection = _validate_prepared(prepared)
    with _STATE_SAVE_LOCK:
        store_id = prepared.store_id
        actual = _pointer(storage, store_id)
        if actual == prepared.document:
            return CredentialCommit(selection, prepared.document)
        if actual != prepared.expected:
            raise CredentialStorageError("conflict")
        for item in prepared.generations:
            _stage(storage, crypto, item, document, store_id)
            if _pointer(storage, store_id) != prepared.expected:
                raise CredentialStorageError("conflict")
        if _pointer(storage, store_id) != prepared.expected:
            raise CredentialStorageError("conflict")
        failure = "write_failed"
        try:
            _bound_call(storage, store_id, storage.replace_pointer, prepared.expected, prepared.document, default="write_failed")
        except CredentialStorageError as exc:
            failure = exc.code
        try:
            actual = _pointer(storage, store_id)
        except CredentialStorageError:
            actual = object()
        if actual == prepared.document:
            return CredentialCommit(selection, prepared.document)
        if actual == prepared.expected:
            raise CredentialStorageError(failure)
        raise CredentialStorageError("indeterminate")
