"""Deterministic stream-title rendering; no network or Qt dependency."""
from __future__ import annotations

import math
import re

TOKEN_REFERENCE = "{mmr} {league} {record} {wins} {losses} {streak} {peak} {wr:PvZ}"
TOKENS = {"mmr", "league", "record", "wins", "losses", "streak", "peak"}
MATCHUP = re.compile(r"wr:[PTZ]v[PTZ]\Z")
PLACEHOLDER = re.compile(r"\{([^{}]+)\}")
MAX_TEMPLATE_LENGTH = 500
LEAGUES = {"Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"}


def validate_template(template):
    if (not isinstance(template, str) or not template.strip()
            or len(template) > MAX_TEMPLATE_LENGTH
            or any(ord(char) < 32 or char in "<>" for char in template)):
        raise ValueError("Use a title template of 1–500 characters without line breaks or angle brackets.")
    for match in PLACEHOLDER.finditer(template):
        if match[1] not in TOKENS and not MATCHUP.fullmatch(match[1]):
            raise ValueError("Unknown title token: {" + match[1] + "}.")
    if "{" in PLACEHOLDER.sub("", template) or "}" in PLACEHOLDER.sub("", template):
        raise ValueError("Close each title token with a matching brace.")
    return template.strip()


def _number(value, maximum=9999):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and 0 <= value <= maximum and value == int(value))


def title_values(stats):
    """Only known, validated fields can enter a title. Missing is never zero."""
    stats = stats if isinstance(stats, dict) else {}
    values = {}
    for field in ("mmr", "peak"):
        if _number(stats.get(field)):
            values[field] = str(int(stats[field]))
    if isinstance(stats.get("league"), str) and stats["league"] in LEAGUES:
        values["league"] = stats["league"]
    session = stats.get("session")
    if isinstance(session, dict) and all(_number(session.get(key), 10**7) for key in ("wins", "losses")):
        wins, losses = int(session["wins"]), int(session["losses"])
        values.update(wins=str(wins), losses=str(losses), record=f"{wins}W–{losses}L")
    streak = stats.get("streak")
    if isinstance(streak, dict) and streak.get("kind") in {"win", "loss"} and _number(streak.get("count"), 1000) and streak["count"] > 0:
        values["streak"] = ("W" if streak["kind"] == "win" else "L") + str(int(streak["count"]))
    rates = stats.get("winRates")
    if isinstance(rates, dict):
        for matchup, row in rates.items():
            if (isinstance(matchup, str) and MATCHUP.fullmatch("wr:" + matchup)
                    and isinstance(row, dict) and all(_number(row.get(key), 10**7) for key in ("wins", "losses"))):
                total = row["wins"] + row["losses"]
                if total:
                    # Round halves up, independent of Python's banker rounding.
                    values["wr:" + matchup] = str(math.floor(row["wins"] * 100 / total + 0.5)) + "%"
    return values


def render_title(template, stats):
    """Keep the first available segment and drop optional trailing | segments.

    A segment with unavailable stats is omitted in full. A required text-only
    segment that cannot fit must be edited; no word or Unicode character is cut.
    Final validation stays owned by the existing cross-platform shared_title.
    """
    return render_values(template, title_values(stats))


def render_values(template, values):
    """Preview only validated token values, also used by the Qt field."""
    from .service import shared_title
    template = validate_template(template)
    segments = []
    for segment in template.split("|"):
        segment = segment.strip()
        if not segment or any(match[1] not in values for match in PLACEHOLDER.finditer(segment)):
            continue
        segments.append(PLACEHOLDER.sub(lambda match: values[match[1]], segment))
    while segments and len(" | ".join(segments)) > 70 and len(segments) > 1:
        segments.pop()
    if not segments:
        raise ValueError("Title stats are unavailable. Add a plain-text segment separated with |, or wait for synced games.")
    return shared_title(" | ".join(segments))
