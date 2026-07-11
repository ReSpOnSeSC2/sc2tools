"""Chrono-boost link self-calibration on uncalibrated builds.

Every SC2 data patch can shift the ability table, and the chrono link
has already moved once (722 → 723 across 5.0.13 → 5.0.14). Each shift
used to zero the chrono counter — the "0/N chronos, 0%" Mechanics card
— until someone re-derived the new link from a fresh replay and
hardcoded another cutoff into ``_macro_link_table``.

``extract_macro_events`` now self-calibrates: when a Protoss game
yields zero chronos (or the table's chrono link is out-cast 3:1 by a
better candidate), ``_detect_chrono_link`` finds the real link
structurally — chrono is the only Protoss ability repeatedly TARGETED
at the caster's own buildings, and Battery Overcharge (the one other
own-building-targeted cast) can only hit a ShieldBattery, which chrono
never can — and the pass re-runs with the corrected table.

These tests pin all of that against the real build-96883 reference
replay (``warpgate_adept_tracking.SC2Replay``: 6 chrono head-casts at
link 723 targeting Nexus/WarpGate/Robo/Twilight) by simulating future
table shifts and asserting the extractor recovers the same counts.

Subprocess isolation, module-level rationale: see
``test_warpgate_adept_tracking._load_extractor`` — other test modules
install MagicMock shims for sc2reader that poison in-process class
identities.

Module: tests
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

_FIXTURE = os.path.join(
    _HERE, "fixtures", "replays", "warpgate_adept_tracking.SC2Replay",
)

try:
    import sc2reader  # type: ignore  # noqa: F401
except Exception:  # noqa: BLE001
    sc2reader = None  # type: ignore


pytestmark = pytest.mark.skipif(
    sc2reader is None or not os.path.exists(_FIXTURE),
    reason="sc2reader not installed or fixture replay missing",
)

# The reference replay's ground truth: 6 chrono head-casts, no chains,
# targeting these buildings. (Derived once from the raw event dump; the
# in-game casts are visible in the replay itself.)
_EXPECTED_CHRONOS = 6
_EXPECTED_TARGETS = {
    "Nexus": 2, "WarpGate": 2, "RoboticsFacility": 1, "TwilightCouncil": 1,
}


def _run_scenarios():
    """Extract the fixture under three link tables in one subprocess.

    ``normal``   — the real per-build table (chrono correctly at 723).
    ``shifted``  — chrono entry points at 725 where nothing fires,
                   mimicking a patch that moved the table under us.
    ``wrong``    — chrono entry points at 635 (AdeptShadePhaseShiftCancel,
                   1 cast in this replay), mimicking a shifted neighbor
                   inheriting chrono's old slot: a small wrong count
                   must NOT mask the miss.
    """
    script = (
        "import sys, json; "
        "sys.path.insert(0, %r); "
        "import sc2reader; "
        "import core.event_extractor as ee; "
        "r = sc2reader.load_replay(%r, load_level=4); "
        "res = {}; "
        "orig = ee._macro_link_table; "
        "res['normal'] = ee.extract_macro_events(r, my_pid=1, opp_pid=2); "
        "ee._macro_link_table = lambda b: {725: 'chrono', 113: 'inject', 92: 'mule'}; "
        "res['shifted'] = ee.extract_macro_events(r, my_pid=1, opp_pid=2); "
        "ee._macro_link_table = lambda b: {635: 'chrono', 113: 'inject', 92: 'mule'}; "
        "res['wrong'] = ee.extract_macro_events(r, my_pid=1, opp_pid=2); "
        "ee._macro_link_table = orig; "
        "json.dump({k: {'ability_counts': v['ability_counts'], "
        "'chrono_targets': v['chrono_targets']} for k, v in res.items()}, "
        "sys.stdout)"
    ) % (_ROOT, _FIXTURE)
    res = subprocess.run(
        [sys.executable, "-c", script],
        check=True, capture_output=True, text=True, timeout=120,
    )
    return json.loads(res.stdout)


@pytest.fixture(scope="module")
def scenarios():
    return _run_scenarios()


def _target_map(chrono_targets):
    return {
        row["building_name"]: row["count"]
        for row in chrono_targets
    }


def test_correct_table_counts_unchanged(scenarios):
    """Baseline: with the real table the calibration must be a no-op.

    If this count drifts, either the pass regressed or the calibration
    is promoting a bogus candidate on a healthy replay.
    """
    out = scenarios["normal"]
    assert out["ability_counts"]["chrono"] == _EXPECTED_CHRONOS
    assert _target_map(out["chrono_targets"]) == _EXPECTED_TARGETS


def test_recovers_from_table_shift_with_zero_matches(scenarios):
    """Chrono at an unknown link → the old code reported 0/N chronos.

    The calibration must find link 723 from the own-building-target
    signature and recover the exact same counts and target breakdown.
    """
    out = scenarios["shifted"]
    assert out["ability_counts"]["chrono"] == _EXPECTED_CHRONOS, (
        "Self-calibration failed to recover the chrono link after a "
        "simulated ability-table shift — every new-patch Protoss game "
        "will show '0/N chronos' on the Mechanics card again."
    )
    assert _target_map(out["chrono_targets"]) == _EXPECTED_TARGETS


def test_recovers_from_table_pointing_at_wrong_ability(scenarios):
    """A shifted neighbor inheriting chrono's slot must not mask the miss.

    The wrong link fires once in this replay, so the naive
    'chrono count == 0' trigger alone would never re-calibrate; the
    3:1 head-cast dominance trigger must kick in and replace it.
    """
    out = scenarios["wrong"]
    assert out["ability_counts"]["chrono"] == _EXPECTED_CHRONOS
    assert _target_map(out["chrono_targets"]) == _EXPECTED_TARGETS


def test_detect_chrono_link_guardrails():
    """Pure-function guardrails, no replay needed.

    Runs in-process against real sc2reader class identities — drop any
    mock shims other collected modules left behind first (same recipe
    as test_warpgate_adept_tracking's in-process test).
    """
    for k in list(sys.modules):
        if k == "core.event_extractor":
            sys.modules.pop(k, None)
    import importlib
    import core.event_extractor as ee  # noqa: WPS433
    importlib.reload(ee)
    from sc2reader.events.game import CommandEvent  # noqa: WPS433

    def cast(link, target, pid=1):
        e = CommandEvent.__new__(CommandEvent)
        e.player = type("P", (), {"pid": pid})()
        e.ability_link = link
        e.target_unit_id = target
        return e

    table = {113: "inject", 92: "mule"}
    buildings = {10: "Nexus", 11: "WarpGate", 12: "ShieldBattery"}

    # Happy path: repeated own-building casts on one link win.
    events = [cast(723, 10), cast(723, 11), cast(723, 10)]
    assert ee._detect_chrono_link(events, 1, table, buildings) == (723, 3)

    # Below the head-cast floor: never promote a one-off.
    assert ee._detect_chrono_link(events[:2], 1, table, buildings) is None

    # ShieldBattery targets are Battery Overcharge, not chrono.
    battery = [cast(730, 12), cast(730, 12), cast(730, 12)]
    assert ee._detect_chrono_link(battery, 1, table, buildings) is None

    # Links below the floor are right-click/rally noise.
    low = [cast(122, 10), cast(122, 10), cast(122, 10)]
    assert ee._detect_chrono_link(low, 1, table, buildings) is None

    # Untargeted casts and other players never count.
    other = [cast(723, 10, pid=2)] * 3 + [cast(723, 0)] * 3
    assert ee._detect_chrono_link(other, 1, table, buildings) is None
