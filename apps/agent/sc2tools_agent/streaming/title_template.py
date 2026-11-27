"""Deterministic stream-title rendering; no network or Qt dependency."""
from __future__ import annotations

import math
import re

MATCHUP_SEGMENT = "{match_mmr} v {opp} {aka}"
SESSION_SEGMENT = "Session: {record_with_wr}"
HEAD_TO_HEAD_SEGMENT = "H2H: {h2h_with_wr}"
MATCH_TEMPLATES = {
    "session": f"{SESSION_SEGMENT} | {MATCHUP_SEGMENT} | {{map}}",
    "h2h": f"{MATCHUP_SEGMENT} | {HEAD_TO_HEAD_SEGMENT} | {{map}}",
    "both": f"{MATCHUP_SEGMENT} | {HEAD_TO_HEAD_SEGMENT} | {SESSION_SEGMENT}",
}
CURRENT_MATCH_TEMPLATE = MATCH_TEMPLATES["session"]
TOKEN_REFERENCE = "{opp} {aka} {map} {race} {h2h} {h2h_wr} {h2h_with_wr} {match_mmr} {mmr} {league} {record} {record_with_wr} {wins} {losses} {streak} {peak} {wr:PvZ}"
TOKENS = {"mmr", "league", "record", "record_with_wr", "wins", "losses", "streak", "peak",
          "opp", "aka", "map", "race", "h2h", "h2h_wr", "h2h_with_wr", "match_mmr"}
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


def _plain_text(value, maximum=120):
    if (not isinstance(value, str) or not value.strip() or len(value) > maximum
            or any(ord(char) < 32 or ord(char) == 127 or char in "<>" for char in value)):
        return None
    return value.strip()


def _win_percentage(wins, losses):
    total = wins + losses
    # Round halves up, independent of Python's banker rounding.
    return f"{math.floor(wins * 100 / total + 0.5)}%" if total else ""


def _record_with_percentage(record, percentage):
    return f"{record} ({percentage})" if percentage else record


def _match_values(stats):
    match = stats.get("currentMatch")
    if not isinstance(match, dict) or not _plain_text(match.get("gameKey"), 300):
        return {}
    opponent = _plain_text(match.get("opponent"))
    if not opponent:
        return {}
    values = {"opp": opponent}
    alias = match.get("alias", "")
    if alias == "" or alias is None:
        values["aka"] = ""
    else:
        alias = _plain_text(alias)
        if alias:
            values["aka"] = f"(aka {alias})" if alias.casefold() != opponent.casefold() else ""
    name = _plain_text(match.get("map"))
    if name:
        values["map"] = name
    if match.get("race") in ("Protoss", "Terran", "Zerg", "Random"):
        values["race"] = match["race"]
    h2h = match.get("h2h")
    if isinstance(h2h, dict) and all(_number(h2h.get(key), 10**7) for key in ("wins", "losses")):
        wins, losses = int(h2h["wins"]), int(h2h["losses"])
        values["h2h"] = f"{wins}W–{losses}L"
        percentage = _win_percentage(wins, losses)
        values["h2h_with_wr"] = _record_with_percentage(values["h2h"], percentage)
        if percentage:
            values["h2h_wr"] = percentage
    return values


def title_values(stats):
    """Only known, validated fields can enter a title. Missing is never zero."""
    stats = stats if isinstance(stats, dict) else {}
    values = _match_values(stats)
    for field in ("mmr", "peak"):
        if _number(stats.get(field)):
            values[field] = str(int(stats[field]))
    if "opp" in values:
        values["match_mmr"] = f"{values['mmr']} MMR" if "mmr" in values else ""
    if isinstance(stats.get("league"), str) and stats["league"] in LEAGUES:
        values["league"] = stats["league"]
    session = stats.get("session")
    if isinstance(session, dict) and all(_number(session.get(key), 10**7) for key in ("wins", "losses")):
        wins, losses = int(session["wins"]), int(session["losses"])
        record = f"{wins}W–{losses}L"
        percentage = _win_percentage(wins, losses)
        values.update(wins=str(wins), losses=str(losses), record=record,
                      record_with_wr=_record_with_percentage(record, percentage))
    streak = stats.get("streak")
    if isinstance(streak, dict) and streak.get("kind") in {"win", "loss"} and _number(streak.get("count"), 1000) and streak["count"] > 0:
        values["streak"] = ("W" if streak["kind"] == "win" else "L") + str(int(streak["count"]))
    rates = stats.get("winRates")
    if isinstance(rates, dict):
        for matchup, row in rates.items():
            if (isinstance(matchup, str) and MATCHUP.fullmatch("wr:" + matchup)
                    and isinstance(row, dict) and all(_number(row.get(key), 10**7) for key in ("wins", "losses"))):
                percentage = _win_percentage(row["wins"], row["losses"])
                if percentage:
                    values["wr:" + matchup] = percentage
    return values


def render_title(template, stats):
    """Keep the first available segment and drop optional trailing | segments.

    The Both preset prioritizes fitting the opponent and both labeled records.
    A segment with unavailable stats is omitted in full. A required text-only
    segment that cannot fit must be edited; no word or Unicode character is cut.
    Final validation stays owned by the existing cross-platform shared_title.
    """
    return render_values(template, title_values(stats))


def _fit_both_records(prefix, values, render_segment):
    # Keep the opponent and both records in order, even if the full matchup
    # needs to lose its MMR, alias or separators to fit the platform limit.
    details = [render_segment(HEAD_TO_HEAD_SEGMENT), render_segment(SESSION_SEGMENT)]
    for matchup in (MATCHUP_SEGMENT, "v {opp} {aka}", "v {opp}"):
        if any(match[1] not in values for match in PLACEHOLDER.finditer(matchup)):
            continue
        segments = [prefix, render_segment(matchup), *details]
        title = " | ".join(segments)
        if len(title) <= 70:
            return title
    compact = " ".join(segments)
    if len(compact) <= 70:
        return compact
    title = " | ".join(segments[1:])
    if len(title) <= 70:
        return title
    return None


def render_values(template, values):
    """Preview only validated token values, also used by the Qt field."""
    from .service import shared_title

    def render_segment(segment):
        return " ".join(PLACEHOLDER.sub(lambda match: values[match[1]], segment).split())

    template = validate_template(template)
    both_suffix = " | " + MATCH_TEMPLATES["both"]
    prefix = template.removesuffix(both_suffix)
    if (prefix != template and prefix.strip() and not any(char in prefix for char in "|{}")
            and {"opp", "h2h_with_wr", "record_with_wr"} <= values.keys()):
        title = _fit_both_records(" ".join(prefix.split()), values, render_segment)
        if title:
            return shared_title(title)
    segments = []
    for segment in template.split("|"):
        segment = segment.strip()
        if not segment or any(match[1] not in values for match in PLACEHOLDER.finditer(segment)):
            continue
        rendered = render_segment(segment)
        # Keep the opponent if adding the rating would put the matchup over the limit.
        if "{match_mmr}" in segment and len(" | ".join([*segments, rendered])) > 70:
            rendered = render_segment(segment.replace("{match_mmr}", ""))
        if rendered:
            segments.append(rendered)
    while segments and len(" | ".join(segments)) > 70 and len(segments) > 1:
        segments.pop()
    if not segments:
        raise ValueError("Title stats are unavailable. Add a plain-text segment separated with |, or wait for synced games.")
    return shared_title(" | ".join(segments))
