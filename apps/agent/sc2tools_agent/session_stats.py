"""Validated, owner-scoped data from the existing OBS session channel."""

from __future__ import annotations

import hashlib
from datetime import datetime


def session_account_key(base, token):
    return hashlib.sha256((base + "\0" + token).encode("utf-8")).hexdigest()


def normalize_session(value):
    if not isinstance(value, dict) or value.get("isTest") or "testNonce" in value:
        return None
    counts = {key: value.get(key) for key in ("wins", "losses", "games")}
    if any(type(count) is not int or not 0 <= count <= 1_000_000 for count in counts.values()):
        return None
    if counts["wins"] + counts["losses"] > counts["games"]:
        return None
    result = dict(counts)
    for key in ("mmrStart", "mmrCurrent"):
        mmr = value.get(key)
        if type(mmr) is int and 0 <= mmr <= 20_000:
            result[key] = mmr
    region = value.get("region")
    if isinstance(region, str) and region in {"NA", "EU", "KR", "CN", "SEA"}:
        result["region"] = region
    started = value.get("sessionStartedAt")
    if isinstance(started, str) and len(started) <= 64:
        try:
            parsed = datetime.fromisoformat(started.replace("Z", "+00:00"))
            if parsed.tzinfo is not None and parsed.utcoffset() is not None:
                result["sessionStartedAt"] = started
        except ValueError:
            pass
    streak = value.get("streak")
    if (isinstance(streak, dict) and isinstance(streak.get("kind"), str)
            and streak["kind"] in {"win", "loss"}
            and type(streak.get("count")) is int and 2 <= streak["count"] <= counts["games"]):
        result["streak"] = {"kind": streak["kind"], "count": streak["count"]}
    return result
