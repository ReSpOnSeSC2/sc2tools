"""Private, defensive scouting data and plain-text loading-card copy.

The cloud brief is already scoped to the paired account and live game. The
desktop still checks the game key before accepting it. No Qt, HTTP or disk I/O.
"""

from __future__ import annotations

import re
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional


def plain_text(value: Any, limit: int, *, trim: bool = True) -> str:
    """Bound text in UTF-16 units, matching the note API's character limit."""
    if not isinstance(value, str):
        return ""
    encoded = (value.strip() if trim else value).encode("utf-16-le", errors="replace")[:limit * 2]
    return encoded.decode("utf-16-le", errors="ignore")


def _count(value: Any) -> Optional[int]:
    return value if type(value) is int and 0 <= value <= 1_000_000_000 else None


def _record(raw: Any) -> Optional[tuple[int, int]]:
    if not isinstance(raw, dict):
        return None
    wins, losses = _count(raw.get("w")), _count(raw.get("l"))
    return (wins, losses) if wins is not None and losses is not None else None


def toon_identity(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if len(value) <= 80 and re.fullmatch(r"\d+-S2-\d+-\d+", value) else None


def _timestamp(value: Any) -> Optional[float]:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (ValueError, OverflowError, OSError):
        return None


@dataclass(frozen=True)
class ScoutingBrief:
    game_key: str
    opponent_name: str
    record: Optional[tuple[int, int]] = None
    last_met_at: Optional[float] = None
    last_result: str = ""
    last_map: str = ""
    opening: str = ""
    opening_samples: Optional[int] = None
    opening_n: Optional[int] = None
    best_build: str = ""
    best_record: Optional[tuple[int, int]] = None
    note: str = ""
    pulse_id: Optional[str] = None
    dossier_path: str = "/app/opponents"
    forecast_share: Optional[float] = None
    forecast_confidence: str = ""
    forecast_effective_n: Optional[float] = None
    also_plays_as: tuple[str, ...] = ()


@dataclass(frozen=True)
class ScoutingStripModel:
    record_line: str
    opening_line: str
    note: str
    dossier_path: str
    pulse_id: Optional[str] = None


def parse_scouting_brief(raw: Any, game_key: str) -> Optional[ScoutingBrief]:
    if not isinstance(game_key, str) or not isinstance(raw, dict) or raw.get("gameKey") != game_key:
        return None
    opponent = plain_text(raw.get("oppName"), 120)
    if not opponent or not game_key or len(game_key) > 300:
        return None
    last = raw.get("lastMet") if isinstance(raw.get("lastMet"), dict) else {}
    forecast = raw.get("forecast") if isinstance(raw.get("forecast"), dict) else {}
    answer = raw.get("bestAnswer") if isinstance(raw.get("bestAnswer"), dict) else {}
    samples, n = _count(forecast.get("samples")), _count(forecast.get("n"))
    opening_valid = samples is not None and n is not None and 0 < samples <= n
    share, effective_n = forecast.get("share"), forecast.get("effectiveN")
    confidence = forecast.get("confidence")
    posterior = (forecast.get("method") == "posterior" and confidence in ("Low", "Medium", "High")
                 and type(share) in (int, float) and math.isfinite(share) and 0 <= share <= 1
                 and type(effective_n) in (int, float) and math.isfinite(effective_n) and 0 <= effective_n <= 75)
    if forecast.get("method") == "posterior":
        opening_valid = bool(posterior and samples is not None and n is not None and 0 <= samples <= n <= 50)
    pulse_id = toon_identity(raw.get("pulseId"))
    # Build the one permitted dossier path from the validated identity; never
    # open a server-provided arbitrary URL, scheme, host or query string.
    path = f"/app/opponents/{pulse_id}" if pulse_id else "/app/opponents"
    result = last.get("result")
    result = {"Win": "W", "Loss": "L", "Tie": "Tie"}.get(result, "") if isinstance(result, str) else ""
    return ScoutingBrief(
        game_key=game_key, opponent_name=opponent, record=_record(raw.get("h2h")),
        last_met_at=_timestamp(last.get("at")),
        last_result=result,
        last_map=plain_text(last.get("map"), 120),
        opening=plain_text(forecast.get("name"), 160) if opening_valid else "",
        opening_samples=samples if opening_valid else None,
        opening_n=n if opening_valid else None,
        best_build=plain_text(answer.get("build"), 160),
        best_record=_record(answer), note=plain_text(raw.get("note"), 500) if pulse_id else "",
        pulse_id=pulse_id, dossier_path=path,
        forecast_share=float(share) if posterior and opening_valid else None,
        forecast_confidence=confidence if posterior and opening_valid else "",
        forecast_effective_n=float(effective_n) if posterior and opening_valid else None,
        also_plays_as=tuple(dict.fromkeys(plain_text(value, 120) for value in raw.get("alsoPlaysAs", [])[:3] if isinstance(value, str) and value.strip())) if isinstance(raw.get("alsoPlaysAs"), list) else (),
    )


def scouting_model(brief: ScoutingBrief, now: float) -> ScoutingStripModel:
    record = "No confirmed record yet"
    if brief.record is not None:
        wins, losses = brief.record
        record = "First meeting" if wins + losses == 0 else f"You {wins}–{losses}"
    if brief.last_met_at is not None:
        days = max(0, int((now - brief.last_met_at) // 86_400))
        age = "today" if days == 0 else "yesterday" if days == 1 else f"{days} days ago"
        detail = " on ".join(part for part in (brief.last_result, brief.last_map) if part)
        record += f" · last met {age}" + (f" ({detail})" if detail else "")
    opening = "Opening history not available"
    if brief.opening:
        if brief.forecast_confidence and brief.forecast_share is not None and brief.forecast_effective_n is not None:
            opening = f"Forecast: {brief.opening} ({int(brief.forecast_share * 100 + 0.5)}% · {brief.forecast_confidence} confidence · effective n={brief.forecast_effective_n:.1f})"
        else:
            opening = f"Usually: {brief.opening} ({brief.opening_samples} of last {brief.opening_n})"
    if brief.also_plays_as:
        record += " · also: " + ", ".join(brief.also_plays_as)
    if brief.best_build and brief.best_record is not None:
        wins, losses = brief.best_record
        opening += f" · Best: {brief.best_build} {wins}–{losses}"
    return ScoutingStripModel(record, opening, brief.note, brief.dossier_path, brief.pulse_id)
