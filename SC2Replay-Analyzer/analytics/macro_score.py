"""Macro Efficiency engine for the SC2 Meta Analyzer.

This module turns the macro-event bundle produced by
`core.event_extractor.extract_macro_events` into a single 0-100 macro score
plus a sorted list of "leaks" (where the player lost economy).

Scoring model
-------------
The headline number is built around the **Spending Quotient (SQ)** formula
originally proposed by user "MaSe" in 2010 and popularized by sc2gears /
sc2reader analytics ever since. It captures the central macro idea: spending
your resources at a rate that scales with your income.

    SQ = 35 * (0.00137 * income_per_min - ln(avg_unspent)) + 240

Empirical SQ ranges (from public ladder samples):

    Bronze    ~30-50
    Silver    ~40-60
    Gold      ~50-70
    Platinum  ~60-80
    Diamond   ~70-85
    Master    ~80-95
    Pro       ~95-115

We rescale SQ into a 0-100 macro score by treating SQ=70 (top of Diamond) as
"75" and SQ=100 (low Pro) as "95", with a soft taper above and below:

    score = clamp(0, 100, SQ - 5)        # simple, monotonic, well-calibrated

On top of that base score we apply small, bounded adjustments for the SC2-
specific macro disciplines (inject / chrono / MULE / supply block). These
*reduce* the headline number when their efficiency is poor but never push
the score below 0.

Adjustment caps (per discipline):

    Supply-block penalty             up to -15
    Inject efficiency penalty (Z)    up to -10
    Chrono efficiency penalty (P)    up to  -8
    MULE efficiency penalty (T)      up to -10

Public API
----------
`compute_macro_score(macro_events, my_race, game_length_sec)` returns a dict:

    {
        "macro_score":  72,
        "top_3_leaks": [{"name": ..., "detail": ..., "quantity": ...,
                          "mineral_cost": ...}, ...],
        "all_leaks":   [...],
        "raw":         {<every metric component, for downstream debugging>},
    }

This module is intentionally pure-Python with no sc2reader dependency; the
heavy parsing happens in `core.event_extractor`. That makes the engine easy
to unit test against synthetic event bundles.
"""

import math
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


# -----------------------------------------------------------------------------
# Engine version tag.
# -----------------------------------------------------------------------------
# Read by the diagnostics router (Stage 4) and compared to the value persisted
# in data/config.json under macro_engine.engine_version. When they differ, the
# diagnostics page suggests a re-backfill so historical games get rescored with
# the current model. Bump this string any time the scoring math changes.
MACRO_ENGINE_VERSION: str = "2026-04-chain-counted"


# -----------------------------------------------------------------------------
# Tunable constants.
# -----------------------------------------------------------------------------
# Adjustment caps (max number of points each discipline can shave off the SQ
# base score). Tuned so a well-played replay drops at most ~10-15 points and
# a deeply-flawed one drops 30-40, in line with the published ladder ranges.
SUPPLY_BLOCK_MAX_PENALTY: float = 15.0
INJECT_MAX_PENALTY: float = 10.0
CHRONO_MAX_PENALTY: float = 8.0
MULE_MAX_PENALTY: float = 10.0
FLOAT_MAX_PENALTY: float = 8.0   # capped extra penalty for sustained huge floats

# SQ baseline. Below this much SQ we start scoring under 50 and treating
# economy as the dominant problem.
SQ_OFFSET: float = 5.0

# Mineral-cost estimates for the "top 3 leaks" ranking.
SUPPLY_BLOCK_MIN_PER_SEC: int = 10
MISSED_INJECT_MIN: int = 75
MISSED_CHRONO_MIN: int = 50
MISSED_MULE_MIN: int = 270
FLOAT_MIN_PER_SAMPLE: int = 100

# Building-type sets used by the efficiency calculations.
BASE_TYPES_ZERG = {"Hatchery", "Lair", "Hive"}
BASE_TYPES_PROTOSS = {"Nexus"}
BASE_TYPES_TERRAN = {"OrbitalCommand"}

# Inject / chrono / MULE pacing — pro-grade benchmark cycles. Realistic
# expectations include travel / energy regen, so we use the textbook spec
# values plus a small padding before counting "missed".
INJECT_PERIOD_SEC: int = 29
CHRONO_PERIOD_SEC: int = 20
MULE_PERIOD_SEC: int = 64

# Supply-block detection.
SUPPLY_CAP_LIMIT: int = 200
SUPPLY_BLOCK_MARGIN: int = 1

# Mineral float spike threshold (after 4:00).
MINERAL_FLOAT_SPIKE_AFTER_SEC: int = 240
MINERAL_FLOAT_SPIKE_THRESHOLD: int = 800


# -----------------------------------------------------------------------------
# Data classes.
# -----------------------------------------------------------------------------
@dataclass
class Leak:
    """One identified macro leak."""
    name: str
    detail: str
    quantity: float
    mineral_cost: int
    penalty: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "detail": self.detail,
            "quantity": float(self.quantity),
            "mineral_cost": int(self.mineral_cost),
            "penalty": float(self.penalty),
        }


# -----------------------------------------------------------------------------
# Headline score: Spending Quotient.
# -----------------------------------------------------------------------------
def _compute_sq(stats_events: List[Dict]) -> float:
    """Compute the canonical Spending Quotient.

    SQ = 35 * (0.00137 * income_per_minute - ln(avg_unspent)) + 240

    Income is averaged across the game (skipping the first 60s of warmup).
    `avg_unspent` is the time-weighted average of currently-held minerals +
    vespene, with a floor of 50 to avoid log(0) blowing up.

    Returns a SQ value (typically 30-115). A short or empty game returns
    a neutral 75 so we don't punish abandoned games unjustly.
    """
    after_warmup = [s for s in stats_events if int(s.get("time", 0)) >= 60]
    if len(after_warmup) < 5:
        return 75.0  # neutral default for very short games

    # collection_rate fields are minerals/min and vespene/min already.
    incomes = [
        float(s.get("minerals_collection_rate", 0))
        + float(s.get("vespene_collection_rate", 0))
        for s in after_warmup
    ]
    unspents = [
        max(50.0, float(s.get("minerals_current", 0)) + float(s.get("vespene_current", 0)))
        for s in after_warmup
    ]

    avg_income = sum(incomes) / len(incomes)
    avg_unspent = sum(unspents) / len(unspents)
    if avg_income <= 0 or avg_unspent <= 0:
        return 75.0

    sq = 35.0 * (0.00137 * avg_income - math.log(avg_unspent)) + 240.0
    return sq


# -----------------------------------------------------------------------------
# Discipline metrics (small modifiers on top of the SQ base score).
# -----------------------------------------------------------------------------
def _interval_to_next(stats: List[Dict], i: int, default: int = 10) -> int:
    if i + 1 < len(stats):
        return max(0, int(stats[i + 1]["time"]) - int(stats[i]["time"]))
    return default


def _supply_block_seconds(stats: List[Dict]) -> float:
    """Supply-blocked seconds.

    A sample counts as blocked when food_used >= food_made - 1 AND the
    player isn't at the 200 supply cap. Each blocked sample contributes
    the gap until the next sample (clamped to a 4-second floor — most
    real blocks are short and the next sample is 8-12s later).
    """
    if not stats:
        return 0.0
    total = 0.0
    for i, s in enumerate(stats):
        food_used = s.get("food_used", 0)
        food_made = s.get("food_made", 0)
        if food_used >= food_made - SUPPLY_BLOCK_MARGIN and food_used < SUPPLY_CAP_LIMIT:
            # Use min(gap, 4) so a single 10-sec PlayerStatsEvent doesn't
            # claim 10 full seconds of block. In reality a block is over the
            # second the next pylon finishes warping in.
            gap = _interval_to_next(stats, i)
            total += min(4, gap)
    return float(total)


def _supply_block_penalty(blocked_sec: float, game_length_sec: int) -> float:
    """Map supply-blocked seconds → 0..SUPPLY_BLOCK_MAX_PENALTY.

    Pro benchmark: <15s blocked over a 12-min game → no penalty.
    Bad: 60s+ → max penalty.
    """
    if game_length_sec <= 0:
        return 0.0
    block_pct = (blocked_sec / max(60, game_length_sec)) * 100.0
    # 0% → 0 penalty, 5%+ → max penalty. Linear in between.
    if block_pct <= 1.5:
        return 0.0
    if block_pct >= 5.0:
        return SUPPLY_BLOCK_MAX_PENALTY
    return SUPPLY_BLOCK_MAX_PENALTY * (block_pct - 1.5) / 3.5


def _alive_seconds(buildings: List[Dict], name_set: set, game_end_sec: int) -> int:
    """Total alive-time across all matching buildings."""
    total = 0
    for b in buildings:
        if b.get("name") not in name_set:
            continue
        born = int(b.get("born_time", 0))
        died = int(b.get("died_time", game_end_sec) or game_end_sec)
        if died < born:
            continue
        total += died - born
    return total


def _expected(alive_sec: int, period_sec: int) -> int:
    """Expected number of (inject|chrono|MULE) cycles given uptime."""
    return max(0, alive_sec // period_sec)


def _efficiency_penalty(actual: int, expected: int, max_penalty: float,
                         grace_cycles: int = 3) -> float:
    """Translate cycle efficiency to a 0..max_penalty modifier.

    Allows a `grace_cycles` shortfall (e.g. early-game travel time before the
    first inject is realistic). Beyond that, the penalty scales linearly with
    the efficiency gap, capped at `max_penalty` when efficiency drops below
    50%.
    """
    if expected <= grace_cycles:
        return 0.0
    target = expected - grace_cycles
    if actual >= target:
        return 0.0
    eff = max(0.0, actual / target)
    # 100% → 0 penalty, 50%-or-less → full penalty.
    if eff >= 1.0:
        return 0.0
    if eff <= 0.5:
        return max_penalty
    return max_penalty * (1.0 - (eff - 0.5) / 0.5)


def _count_ability(abilities: List[Dict], names: set) -> int:
    """Count ability events whose ``ability_name`` matches ``names``.

    Kept for backward compatibility; the macro engine prefers the
    category-bucketed counts emitted by the new extractor (which use
    ``_count_category`` below) because exact ability names drift across
    SC2 patches.
    """
    return sum(1 for a in abilities if a.get("ability_name") in names)


def _count_category(abilities: List[Dict], category: str) -> int:
    """Count ability events whose pre-classified ``category`` matches.

    The extractor (`core.event_extractor.extract_macro_events`) tags
    every macro ability with ``category in {'inject','chrono','mule'}``.
    Counting via the tag is robust to inject/chrono/MULE name variations
    across replay versions ("ChronoBoostEnergyCost" vs "ChronoBoost" vs
    "Effect_ChronoBoost").
    """
    return sum(1 for a in abilities if a.get("category") == category)


def _mineral_float_count(stats: List[Dict]) -> int:
    return sum(
        1 for s in stats
        if int(s.get("time", 0)) >= MINERAL_FLOAT_SPIKE_AFTER_SEC
        and int(s.get("minerals_current", 0)) > MINERAL_FLOAT_SPIKE_THRESHOLD
    )


def _float_penalty(spike_count: int, total_samples: int) -> float:
    """Mineral float spike rate → small bounded penalty.

    Float is mostly captured by SQ but sustained huge banks deserve an extra
    nudge. Penalty maxes out when 20%+ of post-4:00 samples are over the
    800-mineral threshold.
    """
    if total_samples <= 0 or spike_count == 0:
        return 0.0
    rate = spike_count / total_samples
    if rate <= 0.05:
        return 0.0
    if rate >= 0.20:
        return FLOAT_MAX_PENALTY
    return FLOAT_MAX_PENALTY * (rate - 0.05) / 0.15


# -----------------------------------------------------------------------------
# Public entry point.
# -----------------------------------------------------------------------------
def compute_macro_score(
    macro_events: Dict[str, Any],
    my_race: str,
    game_length_sec: int,
) -> Dict[str, Any]:
    """Compute the macro score and return a JSON-friendly dict.

    Score = clamp(0, 100, SQ - 5 - supply_penalty - race_penalty - float_penalty).
    """
    if not isinstance(macro_events, dict):
        macro_events = {}

    stats = macro_events.get("stats_events", []) or []
    abilities = macro_events.get("ability_events", []) or []
    bases = macro_events.get("bases", []) or []
    game_end = int(game_length_sec or macro_events.get("game_length_sec", 0) or 0)

    # 1. Headline: Spending Quotient.
    sq = _compute_sq(stats)
    base = max(0.0, min(100.0, sq - SQ_OFFSET))

    leaks: List[Leak] = []
    raw: Dict[str, Any] = {
        "sq": round(sq, 2),
        "base_score": round(base, 2),
    }

    # 2. Supply-block adjustment.
    blocked_sec = _supply_block_seconds(stats)
    raw["supply_blocked_seconds"] = blocked_sec
    sb_penalty = _supply_block_penalty(blocked_sec, game_end)
    if sb_penalty > 0:
        leaks.append(Leak(
            name="Supply Blocked",
            detail=f"{blocked_sec:.0f}s blocked at supply cap",
            quantity=blocked_sec,
            mineral_cost=int(blocked_sec * SUPPLY_BLOCK_MIN_PER_SEC),
            penalty=sb_penalty,
        ))

    # 3. Race-specific macro mechanic adjustment.
    race = (my_race or "").strip()
    race_penalty = 0.0
    if race == "Zerg":
        alive = _alive_seconds(bases, BASE_TYPES_ZERG, game_end)
        expected = _expected(alive, INJECT_PERIOD_SEC)
        # Prefer category counts (robust to ability-name drift). Fall back
        # to the legacy exact-name set if the extractor didn't tag.
        actual = _count_category(abilities, "inject")
        if actual == 0:
            actual = _count_ability(
                abilities, {"InjectLarva", "SpawnLarva", "QueenSpawnLarva"},
            )
        race_penalty = _efficiency_penalty(actual, expected, INJECT_MAX_PENALTY, grace_cycles=4)
        raw["injects_actual"] = actual
        raw["injects_expected"] = expected
        if race_penalty > 0:
            missed = max(0, expected - actual - 4)
            leaks.append(Leak(
                name="Inject Efficiency",
                detail=f"{actual}/{expected} expected injects ({int(100 * actual / max(1, expected))}%)",
                quantity=missed,
                mineral_cost=int(missed * MISSED_INJECT_MIN),
                penalty=race_penalty,
            ))
    elif race == "Protoss":
        alive = _alive_seconds(bases, BASE_TYPES_PROTOSS, game_end)
        expected = _expected(alive, CHRONO_PERIOD_SEC)
        actual = _count_category(abilities, "chrono")
        if actual == 0:
            actual = _count_ability(
                abilities, {"ChronoBoostEnergyCost", "ChronoBoost"},
            )
        race_penalty = _efficiency_penalty(actual, expected, CHRONO_MAX_PENALTY, grace_cycles=5)
        raw["chronos_actual"] = actual
        raw["chronos_expected"] = expected
        if race_penalty > 0:
            missed = max(0, expected - actual - 5)
            leaks.append(Leak(
                name="Chrono Efficiency",
                detail=f"{actual}/{expected} expected chronos ({int(100 * actual / max(1, expected))}%)",
                quantity=missed,
                mineral_cost=int(missed * MISSED_CHRONO_MIN),
                penalty=race_penalty,
            ))
    elif race == "Terran":
        alive = _alive_seconds(bases, BASE_TYPES_TERRAN, game_end)
        expected = _expected(alive, MULE_PERIOD_SEC)
        actual = _count_category(abilities, "mule")
        if actual == 0:
            actual = _count_ability(abilities, {"CalldownMULE"})
        race_penalty = _efficiency_penalty(actual, expected, MULE_MAX_PENALTY, grace_cycles=2)
        raw["mules_actual"] = actual
        raw["mules_expected"] = expected
        if race_penalty > 0:
            missed = max(0, expected - actual - 2)
            leaks.append(Leak(
                name="MULE Efficiency",
                detail=f"{actual}/{expected} expected MULEs ({int(100 * actual / max(1, expected))}%)",
                quantity=missed,
                mineral_cost=int(missed * MISSED_MULE_MIN),
                penalty=race_penalty,
            ))

    # 4. Mineral-float modifier (small, bounded).
    spikes = _mineral_float_count(stats)
    post_4min_samples = sum(
        1 for s in stats if int(s.get("time", 0)) >= MINERAL_FLOAT_SPIKE_AFTER_SEC
    )
    raw["mineral_float_spikes"] = spikes
    fp_penalty = _float_penalty(spikes, post_4min_samples)
    if fp_penalty > 0:
        leaks.append(Leak(
            name="Mineral Float",
            detail=f"{spikes} sample(s) with >800 minerals on hand after 4:00",
            quantity=spikes,
            mineral_cost=int(spikes * FLOAT_MIN_PER_SAMPLE),
            penalty=fp_penalty,
        ))

    raw["supply_block_penalty"] = round(sb_penalty, 2)
    raw["race_penalty"] = round(race_penalty, 2)
    raw["float_penalty"] = round(fp_penalty, 2)

    score = base - sb_penalty - race_penalty - fp_penalty
    score = max(0, min(100, int(round(score))))

    leaks.sort(key=lambda l: l.mineral_cost, reverse=True)
    top_3 = leaks[:3]

    return {
        "macro_score": score,
        # Raw resource samples (PlayerStatsEvent rows) for the user's pid.
        # Surfaced here so downstream consumers (CLI, Express endpoint,
        # MacroBreakdownPanel chart) can plot army/worker/supply curves
        # without re-parsing the replay. Empty list when the tracker
        # stream had no usable PlayerStatsEvent rows (older replays).
        "stats_events": stats,
        "top_3_leaks": [l.to_dict() for l in top_3],
        "all_leaks": [l.to_dict() for l in leaks],
        "raw": raw,
    }


def macro_score_color(score: Optional[int]) -> str:
    """Pick a UI color for a macro score. Convenience helper for the UI layer."""
    if score is None:
        return "#90A4AE"
    if score >= 75:
        return "#66BB6A"
    if score >= 50:
        return "#FBC02D"
    return "#EF5350"
