"""Pure, closed-schema support facts. Runtime adapters own all reads and tickets.

Guards must include a monotonic owner/connection/run generation, not just an
owner name: A -> B -> A must retire the first A. No callback is stored here.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import ipaddress
import json
import math
import re
from urllib.parse import urlsplit

SCHEMA_VERSION = 1
MAX_DOCUMENT_BYTES = 64 * 1024
COUNT_MAX = 999_999_999
LATENCY_MAX = 3_600_000
MAX_METRICS = 32
ERROR_CODES = frozenset(("signed_out", "rate_limited", "server_busy", "offline",
    "rejected", "file", "unknown", "unsupported_replay", "invalid_game",
    "game_payload_too_large", "parse_failed", "analysis_failed", "file_unstable"))
ROW_IDS = ("storage", "folders", "analyzer", "version", "api", "profile", "client_api", "obs", "sync")
STATUSES = frozenset(("pass", "warn", "fail", "unavailable", "cancelled"))
ACTIONS = frozenset(("retry", "open_settings", "link_again", "none"))
CHECK_CODES = ERROR_CODES | frozenset(("ok", "unavailable", "cancelled", "disabled",
    "not_running", "not_writable", "missing_folders", "invalid_response", "timeout"))
COUNTERS = ("client_api.ui.ok", "client_api.ui.error", "client_api.ui.unreachable",
    "client_api.game.ok", "client_api.game.error", "client_api.game.unreachable",
    "obs.connect.ok", "obs.connect.auth_failed", "obs.connect.refused", "obs.request.error",
    "obs.switch.ok", "obs.switch.error", "transport.overlay.ok", "transport.overlay.error",
    "transport.cloud.ok", "transport.cloud.error", "pulse.resolve.full", "pulse.resolve.partial")
LATENCIES = ("client_api.ui.latency", "client_api.game.latency", "obs.connect.latency",
    "obs.switch.latency", "transport.overlay.latency", "transport.cloud.latency", "pulse.resolve.latency")
_VERSION = re.compile(r"(?:0|[1-9][0-9]{0,3})(?:\.(?:0|[1-9][0-9]{0,3})){2}")
_OS_VERSION = re.compile(r"[0-9]{1,6}(?:\.[0-9]{1,6}){0,3}")
_DEVICE = re.compile(r"[0-9a-f]{24}")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def active(is_current, is_cancelled):
    """Exceptions, missing guards and non-boolean answers fail closed."""
    try:
        return is_current() is True and is_cancelled() is False
    except Exception:
        return False


def count(value):
    return value if type(value) is int and 0 <= value <= COUNT_MAX else None


def latency(value):
    if type(value) not in (int, float) or not 0 <= value <= LATENCY_MAX:
        return None
    return round(value, 2) if math.isfinite(value) else None


def primitive_dict(value):
    """Inspect keys before lookup: colliding custom keys can execute __eq__."""
    if type(value) is not dict or len(value) > 64 or any(type(key) is not str or len(key) > 128 for key in value):
        return {}
    return value


def _choice(value, choices):
    return value if type(value) is str and value in choices else None


def _matching(value, pattern, limit):
    return value if type(value) is str and len(value) <= limit and pattern.fullmatch(value) else None


def _host(value):
    if type(value) is not str or not 1 <= len(value) <= 2048 or not value.isascii():
        return None
    if any(ord(char) <= 32 or ord(char) == 127 for char in value):
        return None
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        pass
    try:
        parsed = urlsplit(value if "://" in value else "//" + value)
        if parsed.scheme and parsed.scheme not in ("http", "https"):
            return None
        host = parsed.hostname
        if not host or len(host) > 253:
            return None
        parsed.port  # Reject malformed/out-of-range ports without retaining them.
        try:
            return str(ipaddress.ip_address(host))
        except ValueError:
            if re.fullmatch(r"[0-9.]+", host):
                return None
            labels = host.lower().split(".")
            if host == "localhost" or len(labels) >= 2 and all(
                re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels
            ):
                return host.lower()
    except ValueError:
        pass
    return None


def _filter(value):
    if _choice(value, ("all", "current_season", "custom")):
        return value
    return _matching(value, re.compile(r"season:[0-9]{1,4}"), 11)


def _date(value):
    value = _matching(value, _DATE, 10)
    if value is None:
        return None
    from datetime import date
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        return None


@dataclass(frozen=True, slots=True)
class SupportInfo:
    version: str | None = None
    os_name: str | None = None
    os_version: str | None = None
    channel: str | None = None
    api_host: str | None = None
    pool_mode: str | None = None
    workers: int | None = None
    folder_count: int | None = None
    regions: tuple[str, ...] | None = None
    sync_filter: str | None = None
    sync_since: str | None = None
    sync_until: str | None = None
    pending: int | None = None
    archive_pending: int | None = None
    paused: bool | None = None
    errors: tuple[str, ...] | None = None
    user_hash8: str | None = None
    device_suffix6: str | None = None
    counters: tuple[tuple[str, int], ...] | None = None
    latencies: tuple[tuple[str, float], ...] | None = None

    def __post_init__(self):
        validators = ((self.version, lambda v: _matching(v, _VERSION, 14)),
            (self.os_name, lambda v: _choice(v, ("Windows", "Linux", "macOS"))),
            (self.os_version, lambda v: _matching(v, _OS_VERSION, 27)),
            (self.channel, lambda v: _choice(v, ("stable", "beta", "dev"))),
            (self.api_host, _host), (self.pool_mode, lambda v: _choice(v, ("thread", "process", "inline"))),
            (self.workers, lambda v: v if type(v) is int and 1 <= v <= 256 else None),
            (self.folder_count, count), (self.sync_filter, _filter), (self.sync_since, _date),
            (self.sync_until, _date), (self.pending, count), (self.archive_pending, count),
            (self.paused, lambda v: v if type(v) is bool else None),
            (self.user_hash8, lambda v: _matching(v, re.compile(r"[0-9a-f]{8}"), 8)),
            (self.device_suffix6, lambda v: _matching(v, re.compile(r"[0-9a-f]{6}"), 6)))
        for value, validator in validators:
            if value is not None:
                validated = validator(value)
                if validated is None or type(validated) is not type(value) or validated != value:
                    raise ValueError("invalid_support_info")
        if self.regions is not None and (type(self.regions) is not tuple or len(self.regions) > 4 or any(
            _choice(v, ("us", "eu", "kr", "cn")) is None for v in self.regions
        ) or tuple(sorted(set(self.regions))) != self.regions):
            raise ValueError("invalid_support_info")
        if self.errors is not None and (type(self.errors) is not tuple or len(self.errors) > 10 or any(
            _choice(v, ERROR_CODES) is None for v in self.errors
        )):
            raise ValueError("invalid_support_info")
        if self.counters is not None:
            _validate_metrics(self.counters, COUNTERS, count)
        if self.latencies is not None:
            _validate_metrics(self.latencies, LATENCIES, latency)


def _validate_metrics(metrics, names, validator):
    if type(metrics) is not tuple or len(metrics) > MAX_METRICS:
        raise ValueError("invalid_metrics")
    seen = set()
    for item in metrics:
        if type(item) is not tuple or len(item) != 2:
            raise ValueError("invalid_metrics")
        name, value = item
        if _choice(name, names) is None or name in seen or validator(value) is None:
            raise ValueError("invalid_metrics")
        seen.add(name)


def _metrics(raw, names, validator, field):
    if type(raw) is not dict:
        return None
    raw = primitive_dict(raw)
    result = []
    for name in names[:MAX_METRICS]:
        entry = primitive_dict(raw.get(name))
        value = validator(entry.get(field))
        if value is not None:
            result.append((name, value))
    return tuple(result)


def project_support(raw):
    """Unbound primitive projection; only the guarded collector adds a suffix."""
    return _project_support(raw)


def _project_support(raw, validated_device_id=None):
    raw = primitive_dict(raw)
    user = raw.get("user_id")
    user_hash = None
    if type(user) is str and 0 < len(user) <= 4096:
        try:
            user_hash = hashlib.sha256(user.encode("utf-8")).hexdigest()[:8]
        except UnicodeError:
            pass
    errors = raw.get("errors")
    error_codes = None
    if type(errors) in (tuple, list):
        error_codes = []
        for item in errors[-10:]:
            code = primitive_dict(item).get("kind") if type(item) is dict else item
            error_codes.append(_choice(code, ERROR_CODES) or "unknown")
    regions = raw.get("regions")
    regions = tuple(regions[:33]) if type(regions) in (tuple, list) else None
    regions = tuple(sorted({v for v in regions if _choice(v, ("us", "eu", "kr", "cn"))})) if (
        regions is not None and len(regions) <= 32) else None
    metrics = raw.get("live_metrics")
    metrics = primitive_dict(metrics)
    return SupportInfo(
        version=_matching(raw.get("version"), _VERSION, 14),
        os_name=_choice(raw.get("os_name"), ("Windows", "Linux", "macOS")),
        os_version=_matching(raw.get("os_version"), _OS_VERSION, 27),
        channel=_choice(raw.get("channel"), ("stable", "beta", "dev")), api_host=_host(raw.get("api_url")),
        pool_mode=_choice(raw.get("pool_mode"), ("thread", "process", "inline")),
        workers=raw.get("workers") if type(raw.get("workers")) is int and 1 <= raw["workers"] <= 256 else None,
        folder_count=count(raw.get("folder_count")), regions=regions, sync_filter=_filter(raw.get("sync_filter")),
        sync_since=_date(raw.get("sync_since")), sync_until=_date(raw.get("sync_until")),
        pending=count(raw.get("pending")), archive_pending=count(raw.get("archive_pending")),
        paused=raw.get("paused") if type(raw.get("paused")) is bool else None,
        errors=tuple(error_codes) if error_codes is not None else None,
        user_hash8=user_hash, device_suffix6=validated_device_id[-6:] if _matching(validated_device_id, _DEVICE, 24) else None,
        counters=_metrics(metrics.get("counters"), COUNTERS, count, "count"),
        latencies=_metrics(metrics.get("latencies"), LATENCIES, latency, "ewma_ms"))


@dataclass(frozen=True, slots=True)
class DiagnosticRow:
    id: str
    status: str = "unavailable"
    code: str = "unavailable"
    action: str = "none"
    count: int | None = None
    latency_ms: float | None = None

    def __post_init__(self):
        if (_choice(self.id, ROW_IDS) is None or _choice(self.status, STATUSES) is None
            or _choice(self.code, CHECK_CODES) is None or _choice(self.action, ACTIONS) is None
            or self.count is not None and count(self.count) is None
            or self.latency_ms is not None and latency(self.latency_ms) is None):
            raise ValueError("invalid_diagnostic_row")
        if self.latency_ms is not None:
            value = latency(self.latency_ms)
            object.__setattr__(self, "latency_ms", 0.0 if type(value) is float and value == 0 else value)


@dataclass(frozen=True, slots=True)
class DiagnosticSnapshot:
    support: SupportInfo
    rows: tuple[DiagnosticRow, ...]
    schema_version: int = SCHEMA_VERSION

    def __post_init__(self):
        if (type(self.support) is not SupportInfo or type(self.rows) is not tuple
            or len(self.rows) != len(ROW_IDS) or type(self.schema_version) is not int
            or self.schema_version != SCHEMA_VERSION or any(type(row) is not DiagnosticRow for row in self.rows)
            or tuple(row.id for row in self.rows) != ROW_IDS):
            raise ValueError("invalid_diagnostic_snapshot")


def collect_diagnostics(read_support, read_checks, *, is_current, is_cancelled, validate_device=None):
    """Return None on cancellation/retirement, including after held callbacks.

    validate_device must check the captured current authenticated API, owner,
    token, epoch and state namespace and return its canonical device ID or None.
    The callback and any credential-bearing closure stay outside the result.
    """
    if not active(is_current, is_cancelled):
        return None
    try:
        raw = read_support()
        if not active(is_current, is_cancelled):
            return None
        device = validate_device() if validate_device is not None else None
        if not active(is_current, is_cancelled):
            return None
        support = _project_support(raw, device)
        checks = read_checks()
        if not active(is_current, is_cancelled):
            return None
        checks = primitive_dict(checks)
        rows = []
        for row_id in ROW_IDS:
            item = primitive_dict(checks.get(row_id))
            rows.append(DiagnosticRow(row_id, _choice(item.get("status"), STATUSES) or "unavailable",
                _choice(item.get("code"), CHECK_CODES) or "unavailable",
                _choice(item.get("action"), ACTIONS) or "none", count(item.get("count")), latency(item.get("latency_ms"))))
        snapshot = DiagnosticSnapshot(support, tuple(rows))
    except Exception:
        return None
    return snapshot if active(is_current, is_cancelled) else None


def support_values(info):
    """A fresh primitive dict; no blanket runtime serialization."""
    if type(info) is not SupportInfo:
        raise ValueError("invalid_support_info")
    info.__post_init__()
    return {name: getattr(info, name) for name in SupportInfo.__dataclass_fields__}


def diagnostic_bytes(snapshot):
    if type(snapshot) is not DiagnosticSnapshot:
        raise ValueError("invalid_diagnostic_snapshot")
    snapshot.__post_init__()
    lines = ["SC2 Tools support diagnostics v1"]
    for name, value in support_values(snapshot.support).items():
        lines.append(name + "=" + ("unavailable" if value is None else json.dumps(value, ensure_ascii=True, allow_nan=False)))
    for row in snapshot.rows:
        row.__post_init__()
        lines.append(f"check.{row.id}={row.status} code={row.code} action={row.action} count={row.count} latency_ms={row.latency_ms}")
    data = ("\n".join(lines) + "\n").encode("utf-8")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise ValueError("diagnostics_too_large")
    return data


def state_summary_bytes(info):
    values = support_values(info)
    keys = ("folder_count", "regions", "sync_filter", "sync_since", "sync_until", "pending",
        "archive_pending", "paused", "errors", "user_hash8", "device_suffix6")
    data = (json.dumps({"schema_version": SCHEMA_VERSION, **{k: values[k] for k in keys}},
        ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
    if len(data) > MAX_DOCUMENT_BYTES:
        raise ValueError("state_summary_too_large")
    return data


def approved_document(alias, data):
    """Validate canonical generated bytes, including reconstructed primitive types.

    This also prevents callers constructing reviewed value objects directly
    from smuggling arbitrary text into the later writer's accepted plan shape.
    """
    if type(alias) is not str or type(data) is not bytes or len(data) > MAX_DOCUMENT_BYTES:
        return False
    try:
        text = data.decode("utf-8", errors="strict")
        if alias == "state-summary.json":
            values = json.loads(text)
            expected = json.loads(state_summary_bytes(SupportInfo()))
            if type(values) is not dict or set(values) != set(expected) or type(values["schema_version"]) is not int or values.pop("schema_version") != SCHEMA_VERSION:
                return False
            info = _support_from_values(values, partial=True)
            return state_summary_bytes(info) == data
        if alias != "diagnostics.txt":
            return False
        lines = text.splitlines()
        fields = tuple(SupportInfo.__dataclass_fields__)
        if len(lines) != 1 + len(fields) + len(ROW_IDS) or lines[0] != "SC2 Tools support diagnostics v1":
            return False
        values = {}
        for name, line in zip(fields, lines[1:]):
            prefix = name + "="
            if not line.startswith(prefix):
                return False
            value = line[len(prefix):]
            values[name] = None if value == "unavailable" else json.loads(value)
        info = _support_from_values(values)
        rows = []
        pattern = re.compile(r"check\.([a-z_]+)=([a-z]+) code=([a-z_]+) action=([a-z_]+) count=(None|[0-9]+) latency_ms=(None|[0-9]+(?:\.[0-9]+)?)")
        for line in lines[1 + len(fields):]:
            match = pattern.fullmatch(line)
            if match is None:
                return False
            row_id, status, code, action, number, ms = match.groups()
            rows.append(DiagnosticRow(row_id, status, code, action, None if number == "None" else int(number),
                None if ms == "None" else float(ms) if "." in ms else int(ms)))
        return diagnostic_bytes(DiagnosticSnapshot(info, tuple(rows))) == data
    except (ValueError, TypeError, UnicodeError, OverflowError, RecursionError):
        return False


def _support_from_values(values, *, partial=False):
    if type(values) is not dict or not set(values) <= set(SupportInfo.__dataclass_fields__):
        raise ValueError("invalid_support_info")
    if not partial and set(values) != set(SupportInfo.__dataclass_fields__):
        raise ValueError("invalid_support_info")
    copied = dict(values)
    for name in ("regions", "errors", "counters", "latencies"):
        if name in copied:
            value = copied[name]
            if value is None:
                continue
            if type(value) is not list or len(value) > MAX_METRICS:
                raise ValueError("invalid_support_info")
            if name in ("counters", "latencies"):
                if any(type(pair) is not list or len(pair) != 2 for pair in value):
                    raise ValueError("invalid_support_info")
                copied[name] = tuple(tuple(pair) for pair in value)
            else:
                copied[name] = tuple(value)
    return SupportInfo(**copied)
