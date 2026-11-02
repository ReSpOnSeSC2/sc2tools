"""Bounded support-log projection. Regex scrubbing never proves free text safe.

Only a tiny closed event/key/value grammar survives. Everything else becomes a
fixed marker, including credentials, identities, paths, URLs and tracebacks.
Inputs are complete bounded snapshots, not a streaming carry of private text.
"""
from __future__ import annotations

from dataclasses import dataclass
import re

from .support_diagnostics import ERROR_CODES, count, latency, primitive_dict

MAX_RAW_BYTES = 512 * 1024
MAX_LOG_BYTES = 512 * 1024
MAX_LINE_BYTES = 32 * 1024
MAX_CHUNKS = 1024
MAX_BINDINGS = 64
MAX_BINDING_CHARS = 4096
MAX_BINDING_BYTES = 64 * 1024
OMITTED = "[omitted]"
REDACTED = "[redacted]"
EVENTS = frozenset(("sync", "health", "live", "diagnostic", "worker", "upload"))
RESULT_CODES = frozenset(("ok", "omitted", "invalid_input", "invalid_utf8", "invalid_bindings", "input_too_large"))
_FIELDS = ("event", "count", "pending", "archive_pending", "latency_ms", "error")
_HEADER = re.compile(r"^\d{4}-\d\d-\d\dT[0-9:.+Z-]{1,40} (?:DEBUG|INFO|WARNING|ERROR|CRITICAL)\s+")
_UNSAFE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ud800-\udfff]")


def _bindings(values):
    if type(values) not in (tuple, list):
        return None
    values = tuple(values[:MAX_BINDINGS + 1])
    if len(values) > MAX_BINDINGS:
        return None
    result, total = [], 0
    for value in values:
        if type(value) is not str or not 1 <= len(value) <= MAX_BINDING_CHARS:
            return None
        if "\n" in value or "\r" in value or "\t" in value or _UNSAFE.search(value):
            return None
        try:
            size = len(value.encode("utf-8"))
        except UnicodeError:
            return None
        total += size
        if total > MAX_BINDING_BYTES:
            return None
        result.append(value)
    return tuple(sorted(set(result), key=lambda value: (-len(value), value)))


def _field(key, value):
    if key == "event":
        return value if type(value) is str and value in EVENTS else None
    if key == "error":
        return value if type(value) is str and value in ERROR_CODES else None
    if key == "latency_ms":
        number = latency(value)
    else:
        number = count(value)
    return str(number) if number is not None else None


def _safe_line(line):
    """Return the canonical safe line or None. No arbitrary string values."""
    if line in (OMITTED, REDACTED):
        return line
    parts = line.split(" ")
    if not 1 <= len(parts) <= len(_FIELDS):
        return None
    fields = {}
    for part in parts:
        key, separator, value = part.partition("=")
        if not separator or key not in _FIELDS or key in fields:
            return None
        if key in ("event", "error"):
            safe = _field(key, value)
        elif key == "latency_ms" and re.fullmatch(r"[0-9]{1,7}(?:\.[0-9]{1,2})?", value):
            safe = _field(key, float(value))
        elif key != "latency_ms" and re.fullmatch(r"[0-9]{1,9}", value):
            safe = _field(key, int(value))
        else:
            return None
        if safe is None:
            return None
        fields[key] = safe
    return " ".join(key + "=" + fields[key] for key in _FIELDS if key in fields)


@dataclass(frozen=True, slots=True)
class RedactedLog:
    data: bytes
    omitted_lines: int = 0
    truncated: bool = False
    code: str = "ok"

    def __post_init__(self):
        # Defensively copy buffers before validation; no mutable/lazy source.
        if type(self.data) not in (bytes, bytearray):
            raise ValueError("invalid_redacted_log")
        frozen = bytes(self.data[:MAX_LOG_BYTES + 1]) if type(self.data) is bytearray else self.data
        if len(frozen) > MAX_LOG_BYTES:
            raise ValueError("redacted_log_too_large")
        object.__setattr__(self, "data", frozen)
        if (type(self.omitted_lines) is not int or not 0 <= self.omitted_lines <= MAX_RAW_BYTES + 1
            or type(self.truncated) is not bool or type(self.code) is not str or self.code not in RESULT_CODES):
            raise ValueError("invalid_redacted_log")
        try:
            text = self.data.decode("utf-8", errors="strict")
        except UnicodeError:
            raise ValueError("invalid_redacted_log") from None
        if text and (not text.endswith("\n") or any(_safe_line(line) != line for line in text.split("\n")[:-1])):
            raise ValueError("invalid_redacted_log")
        markers = text.split("\n")[:-1].count(OMITTED)
        if markers > self.omitted_lines:
            raise ValueError("invalid_redacted_log")
        if self.code == "ok":
            valid = self.omitted_lines == 0 and not self.truncated
        elif self.code == "omitted":
            valid = self.omitted_lines > 0 and (self.omitted_lines == markers or self.truncated)
        else:
            valid = (text == OMITTED + "\n" and self.omitted_lines == 1
                and self.truncated == (self.code == "input_too_large"))
        if not valid:
            raise ValueError("invalid_redacted_log")


def _failure(code, *, truncated=False):
    return RedactedLog((OMITTED + "\n").encode("utf-8"), 1, truncated, code)


def redact_log(chunks, *, sensitive_values=(), starts_mid_line=False):
    """Join bounded bytes before scrubbing, so a split token cannot escape.

    A caller reading a tail must mark starts_mid_line unless it established a
    physical line boundary. An unfinished final physical line is always omitted.
    Oversized input/bindings are rejected whole, never cut into safe fragments.
    """
    if type(starts_mid_line) is not bool:
        return _failure("invalid_input")
    bindings = _bindings(sensitive_values)
    if bindings is None:
        return _failure("invalid_bindings")
    if type(chunks) not in (tuple, list):
        return _failure("invalid_input")
    chunks = tuple(chunks[:MAX_CHUNKS + 1])
    if len(chunks) > MAX_CHUNKS:
        return _failure("invalid_input")
    total, frozen = 0, []
    for chunk in chunks:
        if type(chunk) not in (bytes, bytearray):
            return _failure("invalid_input")
        copied = bytes(chunk[:MAX_RAW_BYTES + 1]) if type(chunk) is bytearray else chunk
        total += len(copied)
        if total > MAX_RAW_BYTES:
            return _failure("input_too_large", truncated=True)
        frozen.append(copied)
    try:
        text = b"".join(frozen).decode("utf-8", errors="strict")
    except UnicodeError:
        return _failure("invalid_utf8")
    output, size, omitted, truncated = [], 0, 0, False
    # split on LF only: controls and bare CR never create a new trusted line.
    lines = text.split("\n")
    for index, raw in enumerate(lines):
        if index == len(lines) - 1 and not raw:
            continue
        incomplete = index == len(lines) - 1 or index == 0 and starts_mid_line
        too_long = len(raw.encode("utf-8")) > MAX_LINE_BYTES
        safe = None
        line = raw[:-1] if raw.endswith("\r") else raw
        if not incomplete and not too_long and not _UNSAFE.search(line):
            for value in bindings:
                line = line.replace(value, REDACTED)
            # Unknown text is omitted by the cheap closed grammar. Do not run
            # unanchored credential/path/email regexes over arbitrary log text.
            safe = _safe_line(_HEADER.sub("", line))
        if safe is None:
            safe = OMITTED
        truncated = truncated or incomplete or too_long
        encoded = (safe + "\n").encode("utf-8")
        if size + len(encoded) > MAX_LOG_BYTES:
            # Retain only complete projected lines, with explicit omission metadata.
            omitted += len(lines) - index - (1 if lines[-1] == "" else 0)
            truncated = True
            break
        output.append(encoded)
        size += len(encoded)
        if safe == OMITTED:
            omitted += 1
    return RedactedLog(b"".join(output), omitted, truncated, "omitted" if omitted else "ok")


def redact_record(record, *, sensitive_values=()):
    """Project one structured record, dropping unknown/identity/secret keys.

    There is no recursion through raw state, exceptions or nested containers.
    Known sensitive bindings are still applied to the generated closed fields.
    """
    if type(record) is not dict:
        return _failure("invalid_input")
    bindings = _bindings(sensitive_values)
    if bindings is None:
        return _failure("invalid_bindings")
    record = primitive_dict(record)
    fields = []
    for key in _FIELDS:
        value = _field(key, record.get(key))
        if value is not None:
            fields.append(key + "=" + value)
    if not fields:
        return _failure("omitted")
    text = " ".join(fields)
    return redact_log(((text + "\n").encode("utf-8"),), sensitive_values=bindings)
