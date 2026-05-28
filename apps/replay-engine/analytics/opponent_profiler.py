"""Opponent DNA Profiler.

Aggregates per-opponent statistics from the replay database. Designed to be
constructed once with the in-memory `db` dict from
`db.database.ReplayAnalyzer` and reused for many lookups - the heavy work
(grouping, fuzzy clan-tag merge) happens lazily on first call and is cached
until `invalidate()` is called by the database layer.

What this profile actually shows
--------------------------------
* `list_opponents` - rolled-up record per opponent, with `[CLANTAG]Foo` and
  `Foo` merged into one canonical entry (clan tags stripped, then names within
  ratio >= 0.85 collapsed via `difflib.SequenceMatcher`).
* `profile` - one opponent's full record: race distribution, top-5 of their
  observed strategies (with W/L per strategy), per-map W/L, last-5 game
  summary, and **matchup-aware median key-building timings** keyed by
  sc2reader internal_name (``"SpawningPool"``, ``"RoboticsFacility"``).
  Timings are sourced from ``opp_build_log`` for opponent-race tokens and
  ``build_log`` for the user's-race tokens, so each card honestly reflects
  whose buildings it represents (see ``source`` field).
* `predict_likely_strategies` - recency-weighted distribution over their
  observed `opp_strategy` values (last 10 games count 2x).

Matchup awareness
-----------------
``profile(name, my_race=...)`` accepts the user's race so the timings grid
can be filtered to only buildings that are actually relevant to the matchup
that was played (PvZ never shows Barracks; ZvT shows Barracks for the
opponent and Hatchery for the user). The taxonomy lives in
``analytics.timing_catalog`` and is shared verbatim with the SPA web build.
"""

import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from statistics import StatisticsError, median, quantiles
from typing import Dict, List, Optional, Tuple

from analytics.timing_catalog import (
    RACE_BUILDINGS,
    TimingToken,
    matchup_label,
    normalize_race,
    relevant_tokens,
)


# Build-log lines look like "[m:ss] BuildingName" - extract minutes, seconds, name.
_TIMING_RE = re.compile(r"^\[(\d+):(\d{2})\]\s+(\w+)")

# Strip leading "[XYZ]" / "[ABCD]" clan tags before comparing names.
_CLAN_TAG_RE = re.compile(r"^\[[^\]]{1,8}\]\s*")

# Threshold for collapsing two stripped names under SequenceMatcher.ratio().
_FUZZY_THRESHOLD = 0.85

# Trend detection thresholds (see _compute_trend). Either threshold must be
# crossed for the trend to register as "earlier"/"later".
_TREND_ABS_SECONDS = 5.0   # absolute floor: shifts < 5 sec are noise
_TREND_REL_FRACTION = 0.05  # 5% of first-half median


def _strip_clan_tag(name: str) -> str:
    """Return `name` with any leading `[clan]` tag removed."""
    if not name:
        return ""
    return _CLAN_TAG_RE.sub("", name).strip()


def _format_seconds(seconds: float) -> str:
    """Format game-seconds as `M:SS`."""
    total = int(seconds)
    return f"{total // 60}:{total % 60:02d}"


def _compute_trend(timestamps_chrono: List[int]) -> str:
    """Mann-Kendall-lite trend over chronologically ordered timings.

    Splits the sample in half (first half = older games, second half =
    newer games) and compares medians. Returns one of:

    - ``"earlier"`` - second-half median is meaningfully *less* than first
    - ``"later"``   - second-half median is meaningfully *greater* than first
    - ``"stable"``  - difference within both absolute (5s) and relative
                      (5% of first-half median) thresholds
    - ``"unknown"`` - sample_count < 4 (not enough signal)

    The thresholds are deliberately conservative: a 3-second drift across a
    ladder season is noise, but a 12-second shift in opener tempo is a
    real trend worth surfacing in the UI.
    """
    n = len(timestamps_chrono)
    if n < 4:
        return "unknown"
    mid = n // 2
    first = timestamps_chrono[:mid]
    second = timestamps_chrono[mid:]
    m1 = median(first)
    m2 = median(second)
    diff = m2 - m1
    threshold = max(_TREND_ABS_SECONDS, _TREND_REL_FRACTION * m1)
    if abs(diff) < threshold:
        return "stable"
    return "later" if diff > 0 else "earlier"


def _empty_token_row(token: TimingToken, source: str) -> Dict:
    """Build the canonical no-data row for one ``TimingToken``.

    All numeric fields are ``None`` and all display fields are ``"-"``.
    ``trend`` is ``"unknown"`` (no samples => no signal). ``source`` is
    ``"opp_build_log"`` for opponent-race tokens and ``"build_log"`` for
    the user's-race tokens, so the UI can label provenance even on
    empty cards.
    """
    return {
        "sample_count": 0,
        "median_seconds": None,
        "median_display": "-",
        "p25_seconds": None,
        "p25_display": "-",
        "p75_seconds": None,
        "p75_display": "-",
        "min_seconds": None,
        "min_display": "-",
        "max_seconds": None,
        "max_display": "-",
        "last_seen_seconds": None,
        "last_seen_display": "-",
        "win_rate_when_built": None,
        "trend": "unknown",
        "source": source,
    }


class OpponentProfiler:
    """Per-opponent analytics with lazy caching.

    Holds a reference to the database dict from `ReplayAnalyzer.db`. The dict
    is shared so in-place mutations (adding games, deleting games) are visible
    to the profiler - but the cache must be invalidated to recompute groups
    and profiles. `db.database.ReplayAnalyzer.save_database` calls
    `invalidate()` after every persisted mutation.
    """

    def __init__(self, db: Dict):
        self._db = db
        self._all_games: Optional[List[Dict]] = None
        # canonical display name -> list of game dicts
        self._opponent_groups: Optional[Dict[str, List[Dict]]] = None
        # raw observed name -> canonical display name (for lookup by alias)
        self._aliases: Optional[Dict[str, str]] = None
        # Cache key is (opponent_name, my_race) so swapping races invalidates.
        self._profile_cache: Dict[Tuple[str, str], Dict] = {}

    # ------------------------------------------------------------------ cache

    def invalidate(self) -> None:
        """Drop all cached aggregates. Called by the DB layer on save."""
        self._all_games = None
        self._opponent_groups = None
        self._aliases = None
        self._profile_cache = {}

    # ------------------------------------------------------------ flatten/group

    def _flatten_games(self) -> List[Dict]:
        """Return every game across every build, tagged with its `my_build`."""
        if self._all_games is None:
            games: List[Dict] = []
            for build_name, bd in self._db.items():
                if not isinstance(bd, dict):
                    # Skip metadata keys like _schema_version that may slip in.
                    continue
                for g in bd.get("games", []) or []:
                    if not isinstance(g, dict):
                        continue
                    g2 = dict(g)
                    g2["my_build"] = build_name
                    games.append(g2)
            self._all_games = games
        return self._all_games

    def _build_opponent_groups(self) -> None:
        """Group all games by canonical opponent name.

        Step 1: bucket by clan-tag-stripped name.
        Step 2: collapse buckets whose stripped names match each other at
                ratio >= 0.85 under `SequenceMatcher` (case-insensitive).
        Step 3: pick a display name per group (most-observed raw name).
        """
        if self._opponent_groups is not None and self._aliases is not None:
            return

        games = self._flatten_games()

        # Step 1: bucket by stripped name
        bucketed: Dict[str, List[Tuple[str, Dict]]] = defaultdict(list)
        for g in games:
            raw = g.get("opponent", "") or ""
            if not raw:
                continue
            stripped = _strip_clan_tag(raw)
            if not stripped:
                continue
            bucketed[stripped].append((raw, g))

        # Step 2: fuzzy-merge similar stripped names
        canonical_keys: List[str] = []
        canonical_groups: Dict[str, List[Tuple[str, Dict]]] = {}
        # Process longest names first so e.g. "GoodPlayer" anchors before
        # "GoodPlay" rather than the other way around.
        for stripped in sorted(bucketed.keys(), key=lambda s: (-len(s), s.lower())):
            items = bucketed[stripped]
            matched_canonical = None
            for ck in canonical_keys:
                if SequenceMatcher(None, stripped.lower(), ck.lower()).ratio() >= _FUZZY_THRESHOLD:
                    matched_canonical = ck
                    break
            if matched_canonical is None:
                matched_canonical = stripped
                canonical_keys.append(stripped)
                canonical_groups[stripped] = []
            canonical_groups[matched_canonical].extend(items)

        # Step 3: choose display name per group; build alias index
        aliases: Dict[str, str] = {}
        final_groups: Dict[str, List[Dict]] = {}
        for canonical, items in canonical_groups.items():
            raw_names = [r for r, _ in items]
            counts = Counter(raw_names)
            # tie-break: pick the longest raw spelling (often the tagged one)
            display = max(counts.items(), key=lambda kv: (kv[1], len(kv[0])))[0]
            final_groups[display] = [g for _, g in items]
            for r in set(raw_names):
                aliases[r] = display

        self._opponent_groups = final_groups
        self._aliases = aliases

    def _games_for(
        self, name: str, since: Optional[str] = None,
    ) -> List[Dict]:
        """Lookup by canonical name, raw alias, or stripped-name fallback.

        When ``since`` is non-empty the result is filtered to games whose
        ``date`` field lexically sorts at or after the cutoff. Games with
        an empty / missing ``date`` are dropped under any non-None cutoff
        (we cannot place them on the timeline so they cannot pass a
        season filter).
        """
        self._build_opponent_groups()
        groups = self._opponent_groups or {}
        aliases = self._aliases or {}
        glist: List[Dict] = []
        if name in groups:
            glist = groups[name]
        else:
            canonical = aliases.get(name)
            if canonical and canonical in groups:
                glist = groups[canonical]
            else:
                stripped = _strip_clan_tag(name).lower()
                for canonical_name, candidate in groups.items():
                    if _strip_clan_tag(canonical_name).lower() == stripped:
                        glist = candidate
                        break
        if since:
            glist = [g for g in glist if (g.get("date") or "") >= since]
        return glist

    # -------------------------------------------------------------- public API

    def list_opponents(
        self,
        min_games: int = 1,
        since: Optional[str] = None,
    ) -> List[Dict]:
        """Return aggregated rows per opponent, sorted by total games desc.

        When ``since`` is non-empty, games older than the cutoff are
        dropped *before* the per-opponent W/L / total counts are computed,
        and opponents whose surviving game count falls below ``min_games``
        are omitted from the output. This is what makes the Opponents tab
        respect the same season filter that drives the rest of the app
        (instead of just hiding opponents whose last_seen falls outside
        the window while still summing all-time W/L totals).
        """
        self._build_opponent_groups()
        groups = self._opponent_groups or {}
        rows: List[Dict] = []
        for canonical, glist in groups.items():
            if since:
                glist = [g for g in glist if (g.get("date") or "") >= since]
            wins = sum(1 for g in glist if g.get("result") == "Win")
            losses = sum(1 for g in glist if g.get("result") == "Loss")
            total = len(glist)
            if total < min_games:
                continue
            last_seen = max((g.get("date", "") or "" for g in glist), default="")
            rows.append({
                "name": canonical,
                "total": total,
                "wins": wins,
                "losses": losses,
                "last_seen": last_seen,
            })
        rows.sort(key=lambda r: (-r["total"], r["name"].lower()))
        return rows

    def profile(
        self,
        name: str,
        my_race: str = "",
        since: Optional[str] = None,
    ) -> Dict:
        """Build (and cache) the full DNA profile for a single opponent.

        ``my_race`` is the user's race for the matchup. It controls which
        timings are eligible per game (PvZ filters out Barracks, etc.) and
        is used to pick the modal opponent race for canonical token order.
        Pass ``""`` if unknown - timings will be empty in that case but the
        rest of the profile (race distribution, top strategies, map W/L,
        last-5) still renders normally.

        ``since`` is an ISO-8601 timestamp string ("2026-04-01T00:00:00")
        used as a lexical lower bound on each game's ``date`` field. When
        provided, games strictly older than the cutoff are dropped before
        every aggregation. ``None`` (the default) keeps the all-time
        behavior. The cutoff participates in the cache key so swapping
        seasons re-derives instead of returning a stale view.
        """
        cache_key = (name, normalize_race(my_race), since or "")
        if cache_key in self._profile_cache:
            return self._profile_cache[cache_key]

        games = self._games_for(name, since=since)

        # Modal opponent race = most common opp_race across the games we
        # have. Used for canonical timings ordering and for the matchup
        # label in the profile payload.
        opp_races_norm = [normalize_race(g.get("opp_race")) for g in games]
        opp_races_norm = [r for r in opp_races_norm if r]
        modal_opp = (
            Counter(opp_races_norm).most_common(1)[0][0]
            if opp_races_norm else ""
        )
        my_norm = normalize_race(my_race)

        if not games:
            timings = self._empty_timings(my_race, modal_opp)
            empty = {
                "name": name,
                "total": 0,
                "wins": 0,
                "losses": 0,
                "win_rate": 0.0,
                "last_seen": "",
                "race_distribution": {},
                "top_strategies": [],
                "map_performance": [],
                "median_timings": timings,
                "median_timings_order": list(timings.keys()),
                "matchup_label": matchup_label(my_race, modal_opp),
                "matchup_counts": {},
                "my_race": my_norm,
                "opp_race_modal": modal_opp,
                "last_5_games": [],
            }
            self._profile_cache[cache_key] = empty
            return empty

        wins = sum(1 for g in games if g.get("result") == "Win")
        losses = sum(1 for g in games if g.get("result") == "Loss")

        race_counts = Counter(g.get("opp_race", "Unknown") or "Unknown" for g in games)

        # Top 5 of opponent's observed strategies + per-strategy W/L
        strat_counts: Counter = Counter()
        strat_wl: Dict[str, Dict[str, int]] = defaultdict(lambda: {"wins": 0, "losses": 0})
        for g in games:
            strat = g.get("opp_strategy", "Unknown") or "Unknown"
            strat_counts[strat] += 1
            r = g.get("result")
            if r == "Win":
                strat_wl[strat]["wins"] += 1
            elif r == "Loss":
                strat_wl[strat]["losses"] += 1
        top_strats: List[Dict] = []
        for strat, c in strat_counts.most_common(5):
            wl = strat_wl[strat]
            tot = wl["wins"] + wl["losses"]
            wr = (wl["wins"] / tot) if tot > 0 else 0.0
            top_strats.append({
                "strategy": strat, "count": c,
                "wins": wl["wins"], "losses": wl["losses"],
                "win_rate": wr,
            })

        # Per-map W/L
        map_wl: Dict[str, Dict[str, int]] = defaultdict(lambda: {"wins": 0, "losses": 0})
        for g in games:
            m = g.get("map", "Unknown") or "Unknown"
            r = g.get("result")
            if r == "Win":
                map_wl[m]["wins"] += 1
            elif r == "Loss":
                map_wl[m]["losses"] += 1
        map_rows = sorted(
            [
                {"map": k, "wins": v["wins"], "losses": v["losses"],
                 "total": v["wins"] + v["losses"]}
                for k, v in map_wl.items()
            ],
            key=lambda r: -r["total"],
        )

        timings = self._compute_median_timings(games, my_race)

        # Per-matchup counts for the timings card's "All / PvZ (8) / PvT (3)"
        # selector chips. Keyed by canonical matchup label ("PvZ", "ZvT").
        # Only populated when my_race is known; the UI hides the chip row
        # when this dict is empty.
        matchup_counts: Dict[str, int] = {}
        if my_norm:
            for g in games:
                opp_r = normalize_race(g.get("opp_race"))
                if not opp_r:
                    continue
                ml = matchup_label(my_norm, opp_r)
                if not ml:
                    continue
                matchup_counts[ml] = matchup_counts.get(ml, 0) + 1

        sorted_games = sorted(games, key=lambda g: g.get("date", "") or "", reverse=True)
        last5 = [{
            "date": (g.get("date", "") or "")[:10],
            "map": g.get("map", "") or "",
            "opp_strategy": g.get("opp_strategy", "") or "",
            "my_build": g.get("my_build", "") or "",
            "result": g.get("result", "") or "",
            "game_length": g.get("game_length", 0) or 0,
        } for g in sorted_games[:5]]

        prof = {
            "name": name,
            "total": len(games),
            "wins": wins,
            "losses": losses,
            "win_rate": (wins / (wins + losses)) if (wins + losses) > 0 else 0.0,
            "last_seen": max((g.get("date", "") or "" for g in games), default=""),
            "race_distribution": dict(race_counts),
            "top_strategies": top_strats,
            "map_performance": map_rows,
            "median_timings": timings,
            "median_timings_order": list(timings.keys()),
            "matchup_label": matchup_label(my_race, modal_opp),
            "matchup_counts": matchup_counts,
            "my_race": my_norm,
            "opp_race_modal": modal_opp,
            "last_5_games": last5,
        }
        self._profile_cache[cache_key] = prof
        return prof

    def predict_likely_strategies(
        self,
        name: str,
        my_race: str = "",
        since: Optional[str] = None,
    ) -> List[Tuple[str, float]]:
        """Return `(strategy, probability)` pairs sorted by descending weight.

        Last 10 games (most recent by `date`) count 2x, every other game 1x.
        `my_race` is accepted for forward-compatibility (e.g. future filtering
        when matchup-aware tagging exists in the DB) and currently does not
        change the math.
        ``since`` filters the underlying game list lexically (same contract
        as ``profile``) so the prediction respects the active season filter.
        """
        games = self._games_for(name, since=since)
        if not games:
            return []
        sorted_games = sorted(games, key=lambda g: g.get("date", "") or "", reverse=True)
        weighted: Counter = Counter()
        total_weight = 0.0
        for i, g in enumerate(sorted_games):
            w = 2.0 if i < 10 else 1.0
            strat = g.get("opp_strategy", "Unknown") or "Unknown"
            weighted[strat] += w
            total_weight += w
        if total_weight == 0:
            return []
        return sorted(
            [(s, w / total_weight) for s, w in weighted.items()],
            key=lambda kv: -kv[1],
        )

    # ------------------------------------------------------------ timing helpers

    @staticmethod
    def _empty_timings(my_race: str = "", opp_race: str = "") -> Dict[str, Dict]:
        """Return the canonical empty-timings shape for a matchup.

        Same dict shape as ``_compute_median_timings``, but every numeric
        field is ``None``, every display field is ``"-"``, and every
        ``sample_count`` is ``0``. Tokens are sourced from the same
        ``relevant_tokens(my_race, opp_race)`` call the populated path uses,
        so the UI gets stable, matchup-relevant slots even when no data
        has been collected yet.

        Returns ``{}`` when ``my_race`` is unknown.
        When ``opp_race`` is unknown but ``my_race`` is known, falls back to
        the user's-race tokens in canonical order so the UI still has
        something honest to render.
        """
        my = normalize_race(my_race)
        if not my:
            return {}
        opp = normalize_race(opp_race)
        if opp:
            ordering = relevant_tokens(my, opp)
        else:
            ordering = list(RACE_BUILDINGS[my])
        own_internal_set = {tok.internal_name for tok in RACE_BUILDINGS[my]}
        return {
            tok.internal_name: _empty_token_row(
                tok,
                "build_log" if tok.internal_name in own_internal_set else "opp_build_log",
            )
            for tok in ordering
        }

    @staticmethod
    def _compute_median_timings(games: List[Dict], my_race: str) -> Dict[str, Dict]:
        """Matchup-aware median first-occurrence timings keyed by ``internal_name``.

        For each game in ``games``:

        1. Derive the per-game matchup from ``g["opp_race"]`` and ``my_race``.
        2. ``relevant_tokens(my_race, opp_race)`` decides which tokens are
           eligible *for that game* (PvZ never collects Barracks samples).
        3. For each eligible token, source the timing from
           ``opp_build_log`` (opponent-race tokens) or ``build_log``
           (user's-race tokens). Tokens that don't match the player's race
           on either side are silently skipped.

        Results are keyed by token in the order returned by
        ``relevant_tokens(my_race, modal_opp_race)`` where ``modal_opp_race``
        is the most common opponent race across ``games``. Tokens with no
        samples still appear (with ``sample_count == 0``) so the UI can
        render stable, matchup-relevant "no data" cards.

        Per-token output (matches the ``_empty_token_row`` shape):
        ``sample_count`` / ``median_seconds`` / ``median_display`` /
        ``p25_seconds`` / ``p25_display`` / ``p75_seconds`` /
        ``p75_display`` / ``min_seconds`` / ``min_display`` /
        ``max_seconds`` / ``max_display`` / ``last_seen_seconds`` /
        ``last_seen_display`` / ``win_rate_when_built`` / ``trend`` /
        ``source``.

        Returns ``{}`` when ``my_race`` is unknown. Returns the empty-shape
        dict (own-race tokens, all empty) when no game has a usable
        ``opp_race``.
        """
        my = normalize_race(my_race)
        if not my:
            return {}

        games = games or []

        # Modal opponent race for canonical ordering. If none of the games
        # carry an opp_race we still return a stable shape (own-race tokens
        # in canonical order) so the UI can render empty cards.
        opp_races_norm = [normalize_race(g.get("opp_race")) for g in games]
        opp_races_norm = [r for r in opp_races_norm if r]
        if not opp_races_norm:
            return OpponentProfiler._empty_timings(my_race, "")
        modal_opp = Counter(opp_races_norm).most_common(1)[0][0]

        ordering = relevant_tokens(my, modal_opp)
        if not ordering:
            return {}

        own_internal_set = {tok.internal_name for tok in RACE_BUILDINGS[my]}

        # Per-token sample collection.
        #   internal_name -> [(seconds, date_str, won_bool), ...]
        samples: Dict[str, List[Tuple[int, str, bool]]] = defaultdict(list)

        for g in games:
            opp_race = normalize_race(g.get("opp_race"))
            if not opp_race:
                continue
            eligible = relevant_tokens(my, opp_race)
            if not eligible:
                continue
            date_str = g.get("date", "") or ""
            won = g.get("result") == "Win"

            for tok in eligible:
                if tok.internal_name in own_internal_set:
                    log = g.get("build_log") or []
                else:
                    log = g.get("opp_build_log") or []

                # First-occurrence wins: scan the log, keep the smallest
                # timestamp whose building name contains this token.
                tok_lower = tok.token.lower()
                best_t: Optional[int] = None
                for line in log:
                    m = _TIMING_RE.match(line)
                    if not m:
                        continue
                    mins, secs, raw_name = int(m.group(1)), int(m.group(2)), m.group(3)
                    if tok_lower in raw_name.lower():
                        t = mins * 60 + secs
                        if best_t is None or t < best_t:
                            best_t = t
                if best_t is not None:
                    samples[tok.internal_name].append((best_t, date_str, won))

        # Build the output, in canonical order.
        out: Dict[str, Dict] = {}
        for tok in ordering:
            source = (
                "build_log"
                if tok.internal_name in own_internal_set
                else "opp_build_log"
            )
            sample_list = samples.get(tok.internal_name, [])
            if not sample_list:
                out[tok.internal_name] = _empty_token_row(tok, source)
                continue

            # Chronological sort for trend calculation. Empty date strings
            # sort to the front, which is fine - they just count as the
            # "older" half.
            sample_list_sorted = sorted(sample_list, key=lambda x: x[1])
            seconds_list = [s[0] for s in sample_list_sorted]
            wins_in_token = sum(1 for s in sample_list_sorted if s[2])
            n = len(seconds_list)

            med = median(seconds_list)
            if n >= 2:
                try:
                    q = quantiles(seconds_list, n=4, method="inclusive")
                    p25 = int(round(q[0]))
                    p75 = int(round(q[2]))
                except StatisticsError:
                    p25 = p75 = int(round(med))
            else:
                p25 = p75 = int(round(med))

            mn = int(min(seconds_list))
            mx = int(max(seconds_list))
            last_seen_t = int(sample_list_sorted[-1][0])
            win_rate = wins_in_token / n
            trend = _compute_trend(seconds_list)

            out[tok.internal_name] = {
                "sample_count": n,
                "median_seconds": float(med),
                "median_display": _format_seconds(med),
                "p25_seconds": p25,
                "p25_display": _format_seconds(p25),
                "p75_seconds": p75,
                "p75_display": _format_seconds(p75),
                "min_seconds": mn,
                "min_display": _format_seconds(mn),
                "max_seconds": mx,
                "max_display": _format_seconds(mx),
                "last_seen_seconds": last_seen_t,
                "last_seen_display": _format_seconds(last_seen_t),
                "win_rate_when_built": win_rate,
                "trend": trend,
                "source": source,
            }

        return out

    @staticmethod
    def _compute_median_timings_for_matchup(
        games: List[Dict], my_race: str, opp_race: str,
    ) -> Dict[str, Dict]:
        """Per-matchup variant of :meth:`_compute_median_timings`.

        Filters ``games`` to those with ``opp_race == opp_race`` *before*
        delegating to ``_compute_median_timings``. The returned dict has
        the same shape and ordering rules as the all-matchup view, except
        the modal opponent race is forced to ``opp_race`` so token
        ordering stays stable for that matchup even when only one game
        survives the filter.

        Behavior contract:

        * ``opp_race`` blank / unknown -> falls back to the unfiltered
          all-matchup view (so callers can pass the user's "All"
          selection straight through without branching).
        * ``my_race`` blank / unknown -> returns ``{}`` exactly like
          ``_compute_median_timings``.
        * No games left after filtering -> returns the empty-shape dict
          for ``(my_race, opp_race)`` so the UI still gets matchup-
          relevant slots to render as "no samples in this matchup".
        """
        my = normalize_race(my_race)
        opp = normalize_race(opp_race)
        if not my:
            return {}
        if not opp:
            # No matchup constraint -> behave exactly like the all view.
            return OpponentProfiler._compute_median_timings(games, my_race)

        filtered = [
            g for g in (games or [])
            if normalize_race(g.get("opp_race")) == opp
        ]
        if not filtered:
            return OpponentProfiler._empty_timings(my_race, opp_race)
        return OpponentProfiler._compute_median_timings(filtered, my_race)
