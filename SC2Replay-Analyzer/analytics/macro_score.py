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

# Per-sample (instantaneous) SQ smoothing + leak-window detection (Stage 6.5).
# The smoothed series is a centered rolling mean of width
# 2 * INSTANTANEOUS_SQ_SMOOTH_HALF_WINDOW_SEC. A "leak window" is any
# contiguous stretch of LEAK_WINDOW_SEC where the SAMPLE-MEAN of
# instantaneous SQ falls below LEAK_SQ_THRESHOLD AND the sample-mean of
# unspent resources exceeds LEAK_UNSPENT_THRESHOLD. Adjacent qualifying
# windows are merged into one annotation. Tuned so a clean 4500 MMR game
# emits 0-1 leaks and a poorly-played 3000 MMR game emits 3-6.
INSTANTANEOUS_SQ_SMOOTH_HALF_WINDOW_SEC: int = 15
LEAK_WINDOW_SEC: int = 30
LEAK_SQ_THRESHOLD: float = 50.0
LEAK_UNSPENT_THRESHOLD: float = 600.0

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

# Inject / chrono / MULE pacing — energy-regen cooldowns per caster.
#
# These are the seconds between back-to-back casts that one caster
# (Queen / Nexus / Orbital Command) can physically sustain — NOT the
# buff duration. Multiply alive-time across all casters by 1/period to
# get the expected number of cycles for a game.
#
# Math (LotV+ values, all standard):
#   * Inject Larva: 25 energy / 0.7875 regen ≈ 31.7s (29 = light pad)
#   * Chrono Boost: 50 energy / 0.5625 regen ≈ 88.9s
#   * Calldown MULE: 50 energy / 0.7875 regen ≈ 63.5s
#
# Historical bug: CHRONO_PERIOD_SEC used to be 20 because the
# original author conflated buff-duration (20s) with cast-cooldown
# (~89s). That made every Protoss replay show ~4× too many expected
# chronos and tanked the macro score for any non-pro player. Fixed
# in <chrono-period-fix commit>; see docs/adr/0001-chrono-period-fix.md.
INJECT_PERIOD_SEC: int = 29
CHRONO_PERIOD_SEC: int = 89
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


def _compute_sq_value(income_per_min: float, unspent: float) -> float:
    """Compute the canonical SQ for a single (income, unspent) pair.

    Mirrors the math inside :func:`_compute_sq` but lets per-sample callers
    (instantaneous_sq) share the formula without the warmup/length guard.
    Returns 75.0 (neutral) when inputs are non-positive so the curve never
    sprouts -inf or NaN entries that would break the SVG path-builder.

    Example:
        >>> round(_compute_sq_value(2400.0, 200.0), 1)
        117.5
    """
    if income_per_min <= 0 or unspent <= 0:
        return 75.0
    return 35.0 * (0.00137 * income_per_min - math.log(unspent)) + 240.0


def _sample_income(sample: Dict) -> float:
    """Per-minute income from a PlayerStatsEvent sample (minerals + vespene)."""
    return (
        float(sample.get("minerals_collection_rate", 0))
        + float(sample.get("vespene_collection_rate", 0))
    )


def _sample_unspent(sample: Dict) -> float:
    """Resources currently held (minerals + vespene), floored at 50.

    Floor matches :func:`_compute_sq` so log() can never blow up on a
    sample that happened to land on a 0/0 spend cycle.
    """
    raw_unspent = (
        float(sample.get("minerals_current", 0))
        + float(sample.get("vespene_current", 0))
    )
    return max(50.0, raw_unspent)


def annotate_instantaneous_sq(
    stats: List[Dict],
    smooth_half_window_sec: int = INSTANTANEOUS_SQ_SMOOTH_HALF_WINDOW_SEC,
) -> None:
    """Mutate stats in place: add ``instantaneous_sq`` + ``smoothed_sq``.

    For each sample s_i, ``instantaneous_sq`` uses the canonical SQ formula
    on (income_i, unspent_i). ``smoothed_sq`` is a CENTERED rolling mean
    over samples whose ``time`` falls within
    [s_i.time - smooth_half_window_sec, s_i.time + smooth_half_window_sec].
    Edge samples shrink the window naturally (no zero-padding).

    Empty input is a no-op. Idempotent: re-running on already-annotated
    samples just rewrites the two fields.

    Example:
        >>> samples = [
        ...     {"time": 0, "minerals_collection_rate": 0,
        ...      "vespene_collection_rate": 0,
        ...      "minerals_current": 50, "vespene_current": 0},
        ... ]
        >>> annotate_instantaneous_sq(samples)
        >>> "instantaneous_sq" in samples[0] and "smoothed_sq" in samples[0]
        True
    """
    if not stats:
        return
    # First pass: per-sample inst_sq.
    for sample in stats:
        sample["instantaneous_sq"] = _compute_sq_value(
            _sample_income(sample), _sample_unspent(sample)
        )
    # Second pass: centered rolling mean. Two-pointer over the sorted
    # series so the smoothing pass is O(n) regardless of window size.
    times = [int(s.get("time", 0)) for s in stats]
    half = max(0, int(smooth_half_window_sec))
    left = 0
    right = 0
    running_sum = 0.0
    n = len(stats)
    for i in range(n):
        center = times[i]
        lo = center - half
        hi = center + half
        while left < n and times[left] < lo:
            running_sum -= float(stats[left]["instantaneous_sq"])
            left += 1
        while right < n and times[right] <= hi:
            running_sum += float(stats[right]["instantaneous_sq"])
            right += 1
        count = right - left
        stats[i]["smoothed_sq"] = (
            round(running_sum / count, 3) if count else
            round(float(stats[i]["instantaneous_sq"]), 3)
        )
        stats[i]["instantaneous_sq"] = round(
            float(stats[i]["instantaneous_sq"]), 3
        )


def _window_mean(
    stats: List[Dict], lo_sec: int, hi_sec: int, key: str
) -> Optional[float]:
    """Mean of ``key`` across samples whose time is in [lo_sec, hi_sec].

    Returns None when no samples fall inside the window so callers can
    distinguish "no data" from "genuine zero".
    """
    total = 0.0
    count = 0
    for sample in stats:
        t = int(sample.get("time", 0))
        if t < lo_sec:
            continue
        if t > hi_sec:
            break
        if key == "unspent":
            total += _sample_unspent(sample)
        elif key == "income":
            total += _sample_income(sample)
        else:
            total += float(sample.get(key, 0))
        count += 1
    return (total / count) if count else None


def detect_leak_windows(
    stats: List[Dict],
    window_sec: int = LEAK_WINDOW_SEC,
    sq_threshold: float = LEAK_SQ_THRESHOLD,
    unspent_threshold: float = LEAK_UNSPENT_THRESHOLD,
) -> List[Dict[str, Any]]:
    """Return merged leak-window annotations.

    A candidate window starts at every sample s_i and spans
    [s_i.time, s_i.time + window_sec]. The window qualifies when the
    sample-mean of instantaneous_sq across that range is < sq_threshold
    AND the sample-mean of unspent (minerals+vespene currently held) is
    > unspent_threshold. Adjacent or overlapping qualifying windows are
    merged into one maximal region.

    Each annotation: {start, end, avg_unspent, avg_income} with end - start
    >= window_sec. Empty input or under-warmup-only stats returns [].
    Requires :func:`annotate_instantaneous_sq` has already run.
    """
    if not stats:
        return []
    # Skip the same 60s warmup that _compute_sq does so an early-game
    # mineral-on-spawn float doesn't auto-classify as a leak.
    eligible = [s for s in stats if int(s.get("time", 0)) >= 60]
    if len(eligible) < 2:
        return []

    intervals: List[List[int]] = []
    for s in eligible:
        start = int(s.get("time", 0))
        end = start + int(window_sec)
        avg_sq = _window_mean(eligible, start, end, "instantaneous_sq")
        avg_unspent = _window_mean(eligible, start, end, "unspent")
        if avg_sq is None or avg_unspent is None:
            continue
        if avg_sq < sq_threshold and avg_unspent > unspent_threshold:
            if intervals and start <= intervals[-1][1]:
                intervals[-1][1] = max(intervals[-1][1], end)
            else:
                intervals.append([start, end])

    annotations: List[Dict[str, Any]] = []
    for start, end in intervals:
        avg_unspent = _window_mean(eligible, start, end, "unspent") or 0.0
        avg_income = _window_mean(eligible, start, end, "income") or 0.0
        annotations.append({
            "start": int(start),
            "end": int(end),
            "avg_unspent": round(avg_unspent, 1),
            "avg_income": round(avg_income, 1),
        })
    return annotations


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
    opp_stats = macro_events.get("opp_stats_events", []) or []
    abilities = macro_events.get("ability_events", []) or []
    bases = macro_events.get("bases", []) or []
    game_end = int(game_length_sec or macro_events.get("game_length_sec", 0) or 0)

    # Per-sample SQ + leak windows (Stage 6.5). Mutates stats / opp_stats
    # in place so the lists forwarded into the return bundle below already
    # carry instantaneous_sq + smoothed_sq fields. Safe on empty lists.
    annotate_instantaneous_sq(stats)
    annotate_instantaneous_sq(opp_stats)

    # 1. Headline: Spending Quotient.
    sq = _compute_sq(stats)
    base = max(0.0, min(100.0, sq - SQ_OFFSET))

    leaks: List[Leak] = []
    raw: Dict[str, Any] = {
        "sq": round(sq, 2),
        "base_score": round(base, 2),
        "leak_windows": detect_leak_windows(stats),
        "opp_leak_windows": detect_leak_windows(opp_stats),
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
        # grace_cycles=2 matches MULE's calibration: with the corrected
        # 89s period, expected chronos run ~10-20 for a typical 10-15min
        # game, so 2 cycles is ~10-20% slack. Was 5 (paired with the
        # buggy 20s period that made expected ~50; 5/50 = 10% slack).
        race_penalty = _efficiency_penalty(actual, expected, CHRONO_MAX_PENALTY, grace_cycles=2)
        raw["chronos_actual"] = actual
        raw["chronos_expected"] = expected
        # Chrono target distribution. extract_macro_events emits
        # ``chrono_targets`` as [{building_name, count}] sorted by
        # count desc; we forward it untouched into raw so the SPA
        # can render the donut + table. Empty list when no chronos
        # were cast or all targets are unresolved.
        chrono_targets = macro_events.get("chrono_targets", [])
        if isinstance(chrono_targets, list):
            raw["chrono_targets"] = chrono_targets
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
        # Opponent's stats samples — same shape as stats_events but for
        # the opp_pid passed to extract_macro_events. Empty when opp_pid
        # was not provided (older breakdowns parsed before dual-player
        # support landed).
        "opp_stats_events": macro_events.get("opp_stats_events", []) or [],
        # Per-sample alive-unit counts for both players. List of
        # { time, my: {Name: int}, opp: {Name: int} } sampled at the same
        # times as stats_events. Drives the Unit roster panel under the
        # Active Army & Workers chart.
        "unit_timeline": macro_events.get("unit_timeline", []) or [],
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
