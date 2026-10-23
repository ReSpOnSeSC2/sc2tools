"""Incremental, Qt-free log parsing and bounded tail reads."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re
from typing import Optional

_HEADER = re.compile(r"^\d{4}-\d\d-\d\dT\S+ (DEBUG|INFO|WARNING|ERROR|CRITICAL)\b")
TAIL_SEED_BYTES = 256 * 1024
MAX_TICK_BYTES = 1024 * 1024


@dataclass
class LogRecord:
    # None marks leading continuation text; the consumer attaches it to the
    # preceding record across ticks. Before the first header it reads as INFO.
    level: Optional[str]
    lines: list[str]


def parse_chunk(carry: str, text: str) -> tuple[list[LogRecord], str]:
    pending = carry + text
    last_newline = pending.rfind("\n")
    if last_newline < 0:
        return [], pending
    complete, new_carry = pending[:last_newline + 1], pending[last_newline + 1:]
    records: list[LogRecord] = []
    for line in complete.splitlines():
        header = _HEADER.match(line)
        if header:
            records.append(LogRecord(header.group(1), [line]))
        elif records:
            records[-1].lines.append(line)
        else:
            records.append(LogRecord(None, [line]))
    return records, new_carry


def matches(record: LogRecord, filter_name: str) -> bool:
    if record.level == "notice":
        return True
    floor = {"info": 1, "warnings": 2, "errors": 3,
             "Info and above": 1, "Warnings and errors": 2, "Errors only": 3}.get(filter_name, 0)
    rank = {"DEBUG": 0, "INFO": 1, "WARNING": 2, "ERROR": 3, "CRITICAL": 4}
    return rank.get(record.level or "INFO", 1) >= floor


def read_tail(path: Path, offset: int, seeded: bool) -> tuple[bytes, int, bool, bool]:
    """Return data, new byte offset, skipped-old-data and rotation flags.

    Initial/big-gap reads visit at most 256 KiB, even for a single enormous
    line. Ordinary reads are capped at 1 MiB. An incomplete UTF-8 character
    is retained by the caller's incremental decoder.
    """
    size = path.stat().st_size
    rotated = size < offset
    if rotated:
        offset = 0
    if size == offset:
        return b"", offset, False, rotated
    skip = (not seeded and size > TAIL_SEED_BYTES) or size - offset > MAX_TICK_BYTES
    with path.open("rb") as source:
        if skip:
            offset = max(0, size - TAIL_SEED_BYTES)
            source.seek(offset)
            if offset:
                source.readline(TAIL_SEED_BYTES)
        else:
            source.seek(offset)
        data = source.read(min(MAX_TICK_BYTES, max(0, size - source.tell())))
        return data, source.tell(), skip, rotated
