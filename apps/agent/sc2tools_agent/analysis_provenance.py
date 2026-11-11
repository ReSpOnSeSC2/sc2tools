"""Reported native parse versions, captured before parsing and retained with its result.

This is metadata, not attestation. Missing metadata stays unknown; serialization
must never substitute the versions of an agent that happens to upload later.
"""
from __future__ import annotations

from dataclasses import dataclass
import importlib
from pathlib import Path
import re
from typing import Any, Optional

_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?")


def reported_version(value: Any) -> Optional[str]:
    if (not isinstance(value, str) or not 0 < len(value) <= 40
            or value == "0.0.0+unknown" or _VERSION.fullmatch(value) is None):
        return None
    return value


@dataclass(frozen=True)
class AnalysisProvenance:
    engine_version: Optional[str] = None
    agent_version: Optional[str] = None

    def __post_init__(self):
        object.__setattr__(self, "engine_version", reported_version(self.engine_version))
        object.__setattr__(self, "agent_version", reported_version(self.agent_version))

    def payload_fields(self) -> dict[str, str]:
        return {name: value for name, raw in (
            ("engineVersion", self.engine_version), ("agentVersion", self.agent_version),
        ) if (value := reported_version(raw)) is not None}


UNKNOWN_PROVENANCE = AnalysisProvenance()


@dataclass(frozen=True)
class ParsedGame:
    game: Any
    provenance: AnalysisProvenance = UNKNOWN_PROVENANCE

    def __post_init__(self):
        if (not isinstance(self.provenance, AnalysisProvenance)
                or getattr(self.game, "is_resumed_from_replay", False) is True):
            object.__setattr__(self, "provenance", UNKNOWN_PROVENANCE)


def as_parsed_game(value: Any) -> ParsedGame:
    # Old workers/callers have no parse snapshot. Do not relabel them as current.
    return value if isinstance(value, ParsedGame) else ParsedGame(value)


def _engine_version(parser_module: Any) -> Optional[str]:
    origin = getattr(parser_module, "__file__", None)
    if not isinstance(origin, str):
        return None
    try:
        parser_path = Path(origin).resolve()
        if parser_path.parent.name != "core" or parser_path.stem != "sc2_replay_parser":
            return None
        with (parser_path.parent.parent / "VERSION").open("rb") as stream:
            raw = stream.read(43)  # At most40 ASCII version bytes plus one CRLF.
        if raw.endswith(b"\r\n"):
            raw = raw[:-2]
        elif raw.endswith(b"\n"):
            raw = raw[:-1]
        return reported_version(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None


def capture_provenance(*, parser_module: Any = None) -> AnalysisProvenance:
    from . import __version__
    if parser_module is None:
        try:
            parser_module = importlib.import_module("core.sc2_replay_parser")
        except Exception:
            # The actual parser retains responsibility for its import failure.
            parser_module = None
    return AnalysisProvenance(_engine_version(parser_module), __version__)
