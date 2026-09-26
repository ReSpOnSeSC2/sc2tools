"""Record external rating evidence without inventing MMR from training wins.

Verification attribution is an external attestation, not authentication by this
module. Opponent ratings never estimate the bot's rating. An assessment is a
documented external report; this module does not validate its statistical method.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
import json
import math
import numbers
import os
from pathlib import Path
import re
import tempfile
from typing import Sequence
from urllib.parse import urlsplit


def _text(value: str, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{name} must be nonempty text")
    return value.strip()


def _sha(value: str) -> str:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("policy_sha256 must identify the exact checkpoint")
    return value


def _number(value: float, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, numbers.Real) or not math.isfinite(value) or value < 0:
        raise ValueError(f"{name} must be a finite nonnegative number")
    return float(value)


def _time(value: str | datetime) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")) if isinstance(value, str) else value
        if not isinstance(parsed, datetime) or parsed.tzinfo is None or parsed.utcoffset() is None:
            raise ValueError("timestamp must include a timezone")
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError) as error:
        raise ValueError("timestamp must be timezone-aware ISO 8601") from error


def _url(value: str) -> str:
    value = _text(value, "source_url")
    parsed = urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("source_url must be an HTTPS provenance URL without credentials")
    return value


def _region(value: str | None) -> str | None:
    return _text(value, "region").upper() if value is not None else None


@dataclass(frozen=True)
class MatchEvidence:
    match_id: str
    policy_sha256: str
    played_at: str
    opponent_kind: str  # human, built_in_ai, self_play
    result: str  # win, loss, draw
    region: str | None = None
    source_url: str | None = None
    verified_by: str | None = None
    opponent_mmr: float | None = None
    rating_system: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "match_id", _text(self.match_id, "match_id"))
        _sha(self.policy_sha256)
        object.__setattr__(self, "played_at", _time(self.played_at).isoformat())
        if self.opponent_kind not in {"human", "built_in_ai", "self_play"}:
            raise ValueError("opponent_kind must distinguish human, built_in_ai and self_play")
        if self.result not in {"win", "loss", "draw"}:
            raise ValueError("result must be win, loss or draw")
        object.__setattr__(self, "region", _region(self.region))
        for name in ("verified_by", "rating_system"):
            if getattr(self, name) is not None:
                object.__setattr__(self, name, _text(getattr(self, name), name))
        if self.source_url is not None:
            object.__setattr__(self, "source_url", _url(self.source_url))
        if self.opponent_mmr is not None:
            object.__setattr__(self, "opponent_mmr", _number(self.opponent_mmr, "opponent_mmr"))
            if self.opponent_kind != "human":
                raise ValueError("built-in AI and self-play opponents have no ladder MMR")


@dataclass(frozen=True)
class RatingAssessment:
    assessment_id: str
    policy_sha256: str
    as_of: str
    kind: str  # official_ladder or external_estimate
    mmr: float
    region: str
    method: str
    source_url: str
    verified_by: str
    match_ids: tuple[str, ...]
    lower_bound: float | None = None
    upper_bound: float | None = None

    def __post_init__(self) -> None:
        for name in ("assessment_id", "method", "verified_by"):
            object.__setattr__(self, name, _text(getattr(self, name), name))
        _sha(self.policy_sha256)
        object.__setattr__(self, "as_of", _time(self.as_of).isoformat())
        if self.kind not in {"official_ladder", "external_estimate"}:
            raise ValueError("assessment kind must be official_ladder or external_estimate")
        object.__setattr__(self, "mmr", _number(self.mmr, "mmr"))
        if self.region is None:
            raise ValueError("assessment region is required")
        object.__setattr__(self, "region", _region(self.region))
        object.__setattr__(self, "source_url", _url(self.source_url))
        if self.kind == "official_ladder":
            host = urlsplit(self.source_url).hostname
            if not any(host == domain or host.endswith("." + domain) for domain in ("blizzard.com", "battle.net")):
                raise ValueError("official ladder reports require Blizzard/Battle.net source provenance")
        if not isinstance(self.match_ids, (list, tuple)) or not self.match_ids:
            raise ValueError("assessment must reference rated human match evidence")
        ids = tuple(_text(value, "match_id") for value in self.match_ids)
        if len(ids) != len(set(ids)):
            raise ValueError("assessment match IDs must be unique")
        object.__setattr__(self, "match_ids", ids)
        if (self.lower_bound is None) != (self.upper_bound is None):
            raise ValueError("rating interval requires both lower and upper bounds")
        if self.lower_bound is not None:
            lower, upper = _number(self.lower_bound, "lower_bound"), _number(self.upper_bound, "upper_bound")
            if not lower <= self.mmr <= upper:
                raise ValueError("rating interval must contain the reported MMR")
            object.__setattr__(self, "lower_bound", lower)
            object.__setattr__(self, "upper_bound", upper)


def _unique(items: Sequence, kind: type, key: str) -> None:
    if any(not isinstance(item, kind) for item in items):
        raise ValueError(f"evidence must contain {kind.__name__} records")
    ids = [getattr(item, key) for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError(f"duplicate {key} in evidence")


def benchmark_status(
    *, policy_sha256: str, matches: Sequence[MatchEvidence] = (),
    assessment: RatingAssessment | None = None, target_mmr: float = 6000,
    region: str | None = None, now: datetime | None = None, max_age_days: float = 30,
) -> dict:
    """Report evidence, never infer MMR or statistical sufficiency from wins.

    Freshness is a configurable evidence policy, not a confidence guarantee.
    External estimates remain separate from reported official ladder ratings.
    """
    _sha(policy_sha256)
    target_mmr = _number(target_mmr, "target_mmr")
    max_age_days = _number(max_age_days, "max_age_days")
    if max_age_days == 0:
        raise ValueError("max_age_days must be positive")
    now = _time(now if now is not None else datetime.now(timezone.utc))
    oldest = now - timedelta(days=max_age_days)
    region = _region(region)
    _unique(matches, MatchEvidence, "match_id")
    eligible = {match.match_id: match for match in matches if (
        match.opponent_kind == "human" and match.policy_sha256 == policy_sha256
        and region is not None and match.region == region
        and oldest <= _time(match.played_at) <= now
        and match.source_url and match.verified_by and match.rating_system
        and match.opponent_mmr is not None
    )}
    report = {
        "schema_version": 1, "status": "unrated", "target_mmr": target_mmr,
        "target_progress": "unrated", "policy_sha256": policy_sha256, "region": region,
        "measured_mmr": None, "external_estimated_mmr": None, "reported_interval": None,
        "current_attested_rated_human_matches": len(eligible),
        "recorded_matches_by_opponent_kind": dict(Counter(match.opponent_kind for match in matches)),
        "assessment": None, "reasons": [],
        "statistical_sufficiency": "not_assessed",
    }
    if assessment is None:
        report["reasons"].append("No documented external rating assessment supplied; training wins do not establish MMR.")
        return report
    if not isinstance(assessment, RatingAssessment):
        raise ValueError("assessment must be RatingAssessment")
    if assessment.policy_sha256 != policy_sha256:
        report["reasons"].append("Assessment identifies a different checkpoint.")
    if region is None or assessment.region != region:
        report["reasons"].append("Assessment region does not match the requested benchmark region.")
    if not oldest <= _time(assessment.as_of) <= now:
        report["reasons"].append("Assessment is stale or dated in the future.")
    if any(match_id not in eligible for match_id in assessment.match_ids):
        report["reasons"].append("Assessment references missing, stale, unverified, mismatched or nonhuman rated-match evidence.")
    elif any(_time(eligible[match_id].played_at) > _time(assessment.as_of) for match_id in assessment.match_ids):
        report["reasons"].append("Assessment predates its supporting matches.")
    if report["reasons"]:
        return report
    report["assessment"] = asdict(assessment)
    if assessment.kind == "official_ladder":
        report.update(status="official_rating_reported", measured_mmr=assessment.mmr)
    else:
        report.update(status="external_estimate_reported", external_estimated_mmr=assessment.mmr)
    if assessment.lower_bound is not None:
        report["reported_interval"] = [assessment.lower_bound, assessment.upper_bound]
        progress = ("reported_at_or_above_target" if assessment.lower_bound >= target_mmr else
                    "reported_below_target" if assessment.upper_bound < target_mmr else "reported_interval_crosses_target")
    else:
        progress = "reported_at_or_above_target" if assessment.mmr >= target_mmr else "reported_below_target"
    report["target_progress"] = progress
    return report


def save_evidence(path: str | Path, matches: Sequence[MatchEvidence], assessments: Sequence[RatingAssessment] = ()) -> None:
    """Atomically save explicit records; never derive ratings during serialization."""
    _unique(matches, MatchEvidence, "match_id")
    _unique(assessments, RatingAssessment, "assessment_id")
    payload = {"schema_version": 1, "matches": [asdict(item) for item in matches],
               "assessments": [asdict(item) for item in assessments]}
    serialized = json.dumps(payload, indent=2, allow_nan=False)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(serialized)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def load_evidence(path: str | Path) -> dict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if (not isinstance(payload, dict) or set(payload) != {"schema_version", "matches", "assessments"}
            or type(payload["schema_version"]) is not int or payload["schema_version"] != 1
            or not isinstance(payload["matches"], list) or not isinstance(payload["assessments"], list)):
        raise ValueError("invalid rating-evidence schema")
    try:
        matches = [MatchEvidence(**item) for item in payload["matches"]]
        assessments = [RatingAssessment(**item) for item in payload["assessments"]]
    except TypeError as error:
        raise ValueError("invalid rating-evidence record") from error
    _unique(matches, MatchEvidence, "match_id")
    _unique(assessments, RatingAssessment, "assessment_id")
    return {"matches": matches, "assessments": assessments}
