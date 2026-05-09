"""Regression tests for unit-tracking accuracy in extract_macro_events.

Two production bugs were producing wrong roster contents on the SPA's
Macro Breakdown panel for the reference replay
``warpgate_adept_tracking.SC2Replay`` (PvZ on Tourmaline LE,
2026-05-08, ReSpOnSe vs Squirtuoz, build 96883):

  1. **Warp-in units silently dropped from ``unit_timeline``.**
     ``extract_macro_events`` populated ``unit_lifetimes`` only on
     ``UnitBornEvent``. WarpGate-warped units (Adept, Stalker,
     Sentry, Zealot, Templar) emit ``UnitInitEvent`` (warp-in start)
     + ``UnitDoneEvent`` (warp-in complete) and NEVER fire
     ``UnitBornEvent``. In this replay every one of the 49 Adepts
     warped in via WarpGate was lost from the alive-tracking, even
     though the build_log (which uses the parallel ``extract_events``
     path that DOES handle ``UnitDoneEvent``) recorded all 41
     completed warp-ins. Symptom on the SPA: hover at any time after
     the first warp-in shows zero Adept chips in the roster despite
     a clear army-value spike on the chart.

  2. **``_clean_building_name`` corrupted ``"Zergling"`` → ``"ling"``.**
     The function used ``raw_name.replace("Zerg", "")``, a global
     substring replace. ``"Zergling"`` literally starts with the
     substring ``"Zerg"`` so the helper ate the prefix and yielded
     ``"ling"``, which falls out of every downstream lookup
     (``KNOWN_BUILDINGS``, ``SKIP_UNITS``, the SPA's cost catalog,
     the icon registry). Symptom on the SPA: opp's roster shows
     ``"li"``-fallback chips with zero army-value contribution for
     every Zergling — exactly the "opponent unit count is way off"
     half of the bug report. The pre-fix behaviour also corrupted
     ``"SprayZerg"`` → ``"Spray"`` and ``"SupplyDepotLowered"`` →
     ``"SupplyDepoted"`` (which then missed the SKIP_BUILDINGS
     check, polluting build logs with a phantom "SupplyDepoted"
     unit chip every time a Terran lowered a depot).

Both regressions are pinned here against the real replay so the SPA's
chart and roster cannot silently drift back into the broken state.

Module: tests
"""
from __future__ import annotations

import os
import sys
from typing import Any, Dict, List

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

_FIXTURE = os.path.join(_HERE, "fixtures", "replays", "warpgate_adept_tracking.SC2Replay")

# sc2reader is required for these tests — they exercise the real
# tracker walk against a real replay. Skip cleanly when the wheel
# isn't installed (some CI containers run without it). The pure-
# function tests in test_extract_macro_events_army_value.py cover
# the happy-path contract via mocked tracker events.
try:
    import sc2reader  # type: ignore  # noqa: F401
except Exception:  # noqa: BLE001
    sc2reader = None  # type: ignore


pytestmark = pytest.mark.skipif(
    sc2reader is None or not os.path.exists(_FIXTURE),
    reason="sc2reader not installed or fixture replay missing",
)


def _load_extractor():
    """Run the assertions in a clean subprocess to escape pollution.

    Other test modules (notably ``test_chrono_targets.py``) install
    ``MagicMock`` shims for ``sc2reader`` at module import so they
    can run on hosts without the wheel. When pytest collects those
    BEFORE us, in-process re-imports can't fully recover sc2reader's
    plugin registry: load_replay's tracker plugin caches event
    subclass references against whatever class object was current
    at first import, so isinstance gates inside the extractor
    silently miss every event tagged with a stale class identity.
    Running the actual extraction in a subprocess sidesteps the
    pollution entirely — the child gets a fresh sys.modules, fresh
    plugin registry, and a single consistent class identity for
    every PlayerStatsEvent / UnitBornEvent / UnitDoneEvent the
    extractor's isinstance gates compare against.
    """
    import subprocess  # noqa: WPS433
    import json  # noqa: WPS433
    script = (
        "import sys, json, os; "
        "sys.path.insert(0, %r); "
        "import sc2reader; "
        "from core.event_extractor import extract_macro_events; "
        "r = sc2reader.load_replay(%r, load_level=4); "
        "out = extract_macro_events(r, my_pid=1, opp_pid=2); "
        "json.dump({'unit_timeline': out['unit_timeline'], "
        "'player_stats': out['player_stats']}, sys.stdout)"
    ) % (_ROOT, _FIXTURE)
    res = subprocess.run(
        [sys.executable, "-c", script],
        check=True, capture_output=True, text=True, timeout=60,
    )
    return json.loads(res.stdout)


def _alive_at(timeline: List[Dict[str, Any]], t: int, side: str) -> Dict[str, int]:
    """Return the alive-unit map for ``side`` at the entry whose time
    is closest to ``t`` from BELOW (matches the SPA's
    ``nearestPriorPoint`` rule so the assertions read the same data
    the chart's tooltip would render at hover ``t``).
    """
    candidate = None
    for entry in timeline:
        et = entry.get("time", 0)
        if et > t:
            break
        candidate = entry
    if candidate is None:
        return {}
    return dict(candidate.get(side) or {})


def test_warpgate_adepts_are_tracked_in_unit_timeline():
    """At t=480s (the screenshot's locked hover time) the user's
    timeline must report the Adepts alive on the field — pre-fix
    the count read 0 because every WarpGate-warped Adept fired
    ``UnitInitEvent`` + ``UnitDoneEvent`` and never ``UnitBornEvent``.
    """
    out = _load_extractor()
    my_at_480 = _alive_at(out["unit_timeline"], 480, "my")
    assert my_at_480.get("Adept", 0) >= 8, (
        f"Expected at least 8 Adepts alive at 8:00 (the user had 11 "
        f"after WarpGate warp-ins around 7:30); got {my_at_480!r}. "
        f"If this regressed, ``unit_lifetimes`` is again only listening "
        f"to UnitBornEvent and silently dropping every warp-in unit."
    )


def test_warpgate_units_appear_at_done_event_time():
    """``units_produced`` for pid=1 must reflect the warp-ins.

    Pre-fix this counter (also gated on UnitBornEvent only) read ~5
    for this replay (just the 3 Stalkers/Sentries/Phoenix produced
    before WarpGate research finished + WarpPrism). Post-fix it
    should land near 45 (≈40 Adepts + early-Gateway units).
    """
    out = _load_extractor()
    produced = out["player_stats"]["1"]["units_produced"]
    assert produced >= 30, (
        f"Expected my-side units_produced >= 30 once warp-ins are "
        f"counted; got {produced}. Check the ``UnitBornEvent or "
        f"UnitDoneEvent`` gate in extract_macro_events around the "
        f"unit_lifetimes population."
    )


def test_zerglings_are_not_corrupted_to_ling():
    """Pre-fix, ``_clean_building_name("Zergling")`` returned
    ``"ling"`` because the helper used a global ``.replace("Zerg", "")``.
    Opp's roster then showed ``"li"`` chips with zero cost
    contribution for every Zergling — half of the "opp unit count is
    way off" symptom in the bug report. Post-fix the prefix-strip is
    gated on a CamelCase boundary, so ``"Zergling"`` is preserved
    while legacy ``"ZergHatchery"`` still folds to ``"Hatchery"``.
    """
    out = _load_extractor()
    opp_at_480 = _alive_at(out["unit_timeline"], 480, "opp")
    assert "Zergling" in opp_at_480, (
        f"Expected 'Zergling' in opp roster at 8:00, got keys "
        f"{sorted(opp_at_480.keys())}. If 'ling' is in the keys, "
        f"_clean_building_name regressed back to global .replace()."
    )
    assert "ling" not in opp_at_480, (
        "Opp roster contained 'ling' — _clean_building_name corrupted "
        "the Zergling name. Check the prefix-strip CamelCase guard."
    )


def test_overlords_are_counted_in_opp_roster():
    """sc2reader's ``minerals_used_active_forces`` (which the SPA
    chart now binds to via the ``army_value`` field) INCLUDES Overlord
    supply cost in the army value, and sc2replaystats's Army Value
    chart matches that convention. Pre-bug-report, ``Overlord`` was
    in ``SKIP_UNITS`` so the roster's Σ(unit_cost × count) drifted
    ~100/Overlord below the chart's army number for every Zerg game.
    Pinning Overlord presence here keeps chart and roster in sync.
    """
    out = _load_extractor()
    opp_at_480 = _alive_at(out["unit_timeline"], 480, "opp")
    assert opp_at_480.get("Overlord", 0) >= 1, (
        f"Expected Overlord in opp roster at 8:00 (Zerg always has at "
        f"least one Overlord by then); got {opp_at_480!r}. If this "
        f"regressed, Overlord is back in SKIP_UNITS and the roster "
        f"will under-count opp army by ~100/Overlord vs the chart."
    )


def test_ability_units_skipped_from_roster():
    """KD8Charge / ForceField / OracleStasisTrap / DisruptorPhased are
    abilities, not army units, but sc2reader emits them as
    ``UnitBornEvent`` with a player pid. They have no cost-catalog
    entry and would otherwise pollute the roster as broken-icon chips.
    Audit pass over the 4 reference replays must not surface any of
    these names in any timeline tick.
    """
    out = _load_extractor()
    forbidden = {"KD8Charge", "ForceField", "OracleStasisTrap", "DisruptorPhased"}
    for entry in out["unit_timeline"]:
        for side in ("my", "opp"):
            leaked = forbidden & set((entry.get(side) or {}).keys())
            assert not leaked, (
                f"Ability/projectile name(s) leaked into timeline at "
                f"t={entry.get('time')}s ({side}): {sorted(leaked)}. "
                f"Add to SKIP_UNITS in core/event_extractor.py."
            )


def test_clean_building_name_unit_tests():
    """Pin the prefix-strip rules independently of any replay.

    This one runs in-process — ``_clean_building_name`` is a pure
    string helper that doesn't touch sc2reader, so no subprocess
    isolation is needed.
    """
    # Drop any test-isolation mocks so the real helper resolves.
    for k in list(sys.modules):
        if k == "core.event_extractor":
            sys.modules.pop(k, None)
    import importlib
    import core.event_extractor as ee  # noqa: WPS433
    importlib.reload(ee)
    fn = ee._clean_building_name
    # Modern sc2reader names — must be unchanged.
    assert fn("Zergling") == "Zergling"
    assert fn("Adept") == "Adept"
    assert fn("AdeptPhaseShift") == "AdeptPhaseShift"
    assert fn("WarpPrism") == "WarpPrism"
    assert fn("WarpPrismPhasing") == "WarpPrismPhasing"
    assert fn("SupplyDepotLowered") == "SupplyDepotLowered"
    assert fn("SiegeTankSieged") == "SiegeTankSieged"
    # Spray/Reward names that happen to contain a race substring
    # mid-string — must NOT be mangled.
    assert fn("SprayZerg") == "SprayZerg"
    assert fn("SprayProtoss") == "SprayProtoss"
    assert fn("SprayTerran") == "SprayTerran"
    # Legacy sc2reader names with race prefix at a CamelCase
    # boundary — must fold to the canonical short name.
    assert fn("ProtossNexus") == "Nexus"
    assert fn("TerranBarracks") == "Barracks"
    assert fn("ZergHatchery") == "Hatchery"
    # Empty / None passes through.
    assert fn("") == ""
