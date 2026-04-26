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
  summary, and median key-building timings extracted from the user's
  `build_log` per game (Pool/Gateway/Barracks/Hatchery/Nexus/CommandCenter/
  Robo/Stargate/Spire/Twilight/Forge).
* `predict_likely_strategies` - recency-weighted distribution over their
  observed `opp_strategy` values (last 10 games count 2x).

Caveat: today's `build_log` records the user's own buildings, not the
opponent's. The Pool/Hatchery/Barracks/etc. timings will only populate when
those buildings appear in the user's log. The profiler degrades gracefully
when a building never appears (`sample_count == 0`).
"""

import re
from collections import Counter, defaultdict
from difflib import SequenceMatcher
from statistics import median
from typing import Dict, List, Optional, Tuple


# Build-log lines look like "[m:ss] BuildingName" - extract minutes, seconds, name.
_TIMING_RE = re.compile(r"^\[(\d+):(\d{2})\]\s+(\w+)")

# Tokens we look for substring-matched against the building name in each
# build_log line. Substring lets "Pool" match "SpawningPool", "Robo" match
# "RoboticsFacility"/"RoboticsBay", "Twilight" match "TwilightCouncil".
KEY_TIMING_BUILDINGS: Tuple[str, ...] = (
    "Pool", "Gateway", "Barracks", "Hatchery", "Nexus", "CommandCenter",
    "Robo", "Stargate", "Spire", "Twilight", "Forge",
)

# Strip leading "[XYZ]" / "[ABCD]" clan tags before comparing names.
_CLAN_TAG_RE = re.compile(r"^\[[^\]]{1,8}\]\s*")

# Threshold for collapsing two stripped names under SequenceMatcher.ratio().
_FUZZY_THRESHOLD = 0.85


def _strip_clan_tag(name: str) -> str:
    """Return `name` with any leading `[clan]` tag removed."""
    if not name:
        return ""
    return _CLAN_TAG_RE.sub("", name).strip()


def _format_seconds(seconds: float) -> str:
    """Format game-seconds as `M:SS`."""
    total = int(seconds)
    return f"{total // 60}:{total % 60:02d}"


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
        self._profile_cache: Dict[str, Dict] = {}

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

    def _games_for(self, name: str) -> List[Dict]:
        """Lookup by canonical name, raw alias, or stripped-name fallback."""
        self._build_opponent_groups()
        groups = self._opponent_groups or {}
        aliases = self._aliases or {}
        if name in groups:
            return groups[name]
        canonical = aliases.get(name)
        if canonical and canonical in groups:
            return groups[canonical]
        stripped = _strip_clan_tag(name).lower()
        for canonical_name, glist in groups.items():
            if _strip_clan_tag(canonical_name).lower() == stripped:
                return glist
        return []

    # -------------------------------------------------------------- public API

    def list_opponents(self, min_games: int = 1) -> List[Dict]:
        """Return aggregated rows per opponent, sorted by total games desc."""
        self._build_opponent_groups()
        groups = self._opponent_groups or {}
        rows: List[Dict] = []
        for canonical, glist in groups.items():
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

    def profile(self, name: str) -> Dict:
        """Build (and cache) the full DNA profile for a single opponent."""
        if name in self._profile_cache:
            return self._profile_cache[name]

        games = self._games_for(name)
        if not games:
            empty = {
                "name": name, "total": 0, "wins": 0, "losses": 0, "win_rate": 0.0,
                "last_seen": "", "race_distribution": {}, "top_strategies": [],
                "map_performance": [], "median_timings": self._empty_timings(),
                "last_5_games": [],
            }
            self._profile_cache[name] = empty
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

        timings = self._compute_median_timings(games)

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
            "last_5_games": last5,
        }
        self._profile_cache[name] = prof
        return prof

    def predict_likely_strategies(
        self, name: str, my_race: str = ""
    ) -> List[Tuple[str, float]]:
        """Return `(strategy, probability)` pairs sorted by descending weight.

        Last 10 games (most recent by `date`) count 2x, every other game 1x.
        `my_race` is accepted for forward-compatibility (e.g. future filtering
        when matchup-aware tagging exists in the DB) and currently does not
        change the math.
        """
        games = self._games_for(name)
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
    def _empty_timings() -> Dict[str, Dict]:
        return {
            tok: {"median_seconds": None, "median_display": "-", "sample_count": 0}
            for tok in KEY_TIMING_BUILDINGS
        }

    @staticmethod
    def _compute_median_timings(games: List[Dict]) -> Dict[str, Dict]:
        """Median first-occurrence timing per token across `games`."""
        per_building: Dict[str, List[int]] = defaultdict(list)
        for g in games:
            seen_in_game: Dict[str, int] = {}
            for line in (g.get("build_log") or []):
                m = _TIMING_RE.match(line)
                if not m:
                    continue
                mins, secs, raw_name = int(m.group(1)), int(m.group(2)), m.group(3)
                t = mins * 60 + secs
                lower = raw_name.lower()
                for token in KEY_TIMING_BUILDINGS:
                    if token.lower() in lower:
                        if token not in seen_in_game or t < seen_in_game[token]:
                            seen_in_game[token] = t
            for token, t in seen_in_game.items():
                per_building[token].append(t)

        out: Dict[str, Dict] = {}
        for token in KEY_TIMING_BUILDINGS:
            samples = per_building.get(token, [])
            if samples:
                med = median(samples)
                out[token] = {
                    "median_seconds": float(med),
                    "median_display": _format_seconds(med),
                    "sample_count": len(samples),
                }
            else:
                out[token] = {"median_seconds": None, "median_display": "-", "sample_count": 0}
        return out
