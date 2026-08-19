"""Locks the ability / spell cast extraction the map replayer draws.

sc2reader hands out command events that look like casts but are not,
and cast names that are not stable across patches. Four behaviours are
pinned here, each one a bug that shipped or nearly shipped:

  1. A command that carries no ability of its own (``ability_link``
     0) is NEVER a cast. ``UpdateTargetUnitCommandEvent`` INHERITS
     ``ability_name`` from the player's previous targeted command
     (sc2reader's ContextLoader does this deliberately), so a plain
     right-click drag arrives named "CausticSpray". Unfiltered, a
     single game reported ~3x its real cast count.
  2. Research commands are not casts. ``ResearchBlink`` unlocks Blink;
     it is not a Blink.
  3. Timestamps are REAL game seconds (``timebase.event_seconds``),
     matching ``extract_unit_tracks``' waypoints. sc2reader's
     ``event.second`` is ``frame // 16`` and runs 1.4x fast on LotV,
     which would float every spell off the unit that cast it.
  4. "NexusMassRecall" means two different abilities depending on the
     patch/datapack pairing, and is split on the event's own shape.

Runs without sc2reader by stubbing the game-event classes, matching
test_unit_tracks.py.

Module: tests
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace
from typing import Any, List
from unittest.mock import MagicMock

sys.modules.setdefault("sc2reader", MagicMock())
sys.modules.setdefault("sc2reader.events", MagicMock())
sys.modules.setdefault("sc2reader.events.tracker", MagicMock())
sys.modules.setdefault("sc2reader.events.game", MagicMock())

_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)

# LotV runs at 22.4 fps; a 1000-second replay is 22400 frames. Using a
# real ratio keeps infer_fps() on its normal path instead of the
# fallback, so the test exercises what production does.
FPS = 22.4
GAME_FRAMES = 22400
GAME_SECONDS = 1000

MY_PID = 1
OPP_PID = 2


def _import_casts():
    """Import core.ability_casts with sc2reader's game classes stubbed."""
    import importlib

    class _CommandEvent:
        pass

    class _SelectionEvent:
        pass

    game_mod = SimpleNamespace(
        CommandEvent=_CommandEvent,
        SelectionEvent=_SelectionEvent,
    )
    sys.modules["sc2reader"] = MagicMock()
    sys.modules["sc2reader.events"] = MagicMock()
    sys.modules["sc2reader.events.game"] = game_mod

    sys.modules.pop("core.ability_casts", None)
    return importlib.import_module("core.ability_casts"), SimpleNamespace(
        CommandEvent=_CommandEvent,
        SelectionEvent=_SelectionEvent,
    )


def _replay(events: List[Any]):
    return SimpleNamespace(
        events=events,
        frames=GAME_FRAMES,
        length=SimpleNamespace(seconds=GAME_SECONDS),
    )


def _cmd(klass: type, second: float, *, pid: int, name: str,
         link: int = 100, loc=None, target_unit_id=None) -> Any:
    """A CommandEvent as sc2reader shapes it.

    ``link`` 0 reproduces the right-click / inherited-name events that
    must never become casts.
    """
    ev = klass()
    ev.frame = int(second * FPS)
    ev.second = int(ev.frame // 16)     # sc2reader's 1.4x-fast value
    ev.player = SimpleNamespace(pid=pid)
    ev.ability_name = name
    ev.has_ability = link != 0
    ev.ability_link = link
    if loc is not None:
        ev.location = (loc[0], loc[1], 4096)
    if target_unit_id is not None:
        ev.target_unit_id = target_unit_id
    return ev


def _selection(klass: type, second: float, *, pid: int, unit_ids) -> Any:
    ev = klass()
    ev.frame = int(second * FPS)
    ev.player = SimpleNamespace(pid=pid)
    ev.control_group = 10          # 10 == the ACTIVE selection
    ev.new_unit_ids = list(unit_ids)
    return ev


def test_commands_without_their_own_ability_are_never_casts():
    """The Update*CommandEvent name-inheritance trap.

    A right-click drag inherits the previous cast's ``ability_name``
    but carries ``ability_link == 0``. Both events below claim to be a
    Psi Storm; only the one that owns an ability is.
    """
    mod, ev = _import_casts()
    events = [
        _cmd(ev.CommandEvent, 100.0, pid=MY_PID, name="PsionicStorm",
             link=178, loc=(50.0, 60.0)),
        _cmd(ev.CommandEvent, 101.0, pid=MY_PID, name="PsionicStorm",
             link=0, loc=(12.0, 12.0)),
        _cmd(ev.CommandEvent, 102.0, pid=MY_PID, name="RightClick",
             link=0, loc=(13.0, 13.0)),
    ]
    out = mod.extract_ability_casts(_replay(events), MY_PID)
    assert [c["ability"] for c in out["casts"]] == ["PsiStorm"]
    assert out["casts"][0]["x"] == 50.0
    # The dropped events must not pollute the diagnostic either.
    assert out["unmapped"] == {}


def test_raw_names_map_onto_stable_slugs():
    """Patch-specific raw names collapse to the client-facing slug."""
    mod, ev = _import_casts()
    cases = [
        ("PsionicStorm", "PsiStorm"),
        ("EMPRound", "EMP"),
        ("FungalGrowth", "FungalGrowth"),
        ("RavagerCorrosiveBile", "CorrosiveBile"),
        ("UseStimpack", "Stim"),
        ("ChronoBoostEnergyCost", "ChronoBoost"),
        ("TemporalField", "TimeWarp"),
        ("PurificationNovaTargeted", "PurificationNova"),
        ("YamatoGun", "Yamato"),
        ("ExtraSupplies", "SupplyDrop"),
        ("RavenScramblerMissile", "InterferenceMatrix"),
        ("RavenShredderMissile", "AntiArmorMissile"),
        ("Hyperjump", "TacticalJump"),
        ("OracleWeapon", "PulsarBeam"),
        ("BuildOracleStasisTrap", "StasisWard"),
        ("InfestorNeuralParasite", "NeuralParasite"),
        ("BurrowLurker", "Burrow"),
        ("UnburrowLurker", "Unburrow"),
        ("BurrowRavagerDown", "Burrow"),
        ("BurrowRavagerUp", "Unburrow"),
        ("AttackWidowMine", "WidowMineDetonate"),
        ("TacticalNukeStrike", "Nuke"),
        ("ChannelSnipe", "Snipe"),
        ("MassRecallMothership", "MassRecall"),
    ]
    events = [
        _cmd(ev.CommandEvent, 10.0 + i, pid=MY_PID, name=raw, loc=(5.0, 5.0))
        for i, (raw, _) in enumerate(cases)
    ]
    out = mod.extract_ability_casts(_replay(events), MY_PID)
    assert [c["ability"] for c in out["casts"]] == [slug for _, slug in cases]
    # Every slug produced must be one the wire vocabulary knows.
    assert {c["ability"] for c in out["casts"]} <= set(mod.CAST_SLUGS)


def test_research_commands_are_not_casts():
    """Researching Blink is not casting Blink -- and must not show up
    as an unmapped 'candidate' either, or the diagnostic cries wolf
    every game."""
    mod, ev = _import_casts()
    events = [
        _cmd(ev.CommandEvent, 60.0 + i, pid=MY_PID, name=raw, loc=(5.0, 5.0))
        for i, raw in enumerate([
            "ResearchBlink", "ResearchPsiStormTech", "ResearchCharge",
            "ResearchStimpack", "EvolveNeuralParasite", "ResearchBurrow",
            "TrainNuke", "BuildNuke",
        ])
    ]
    out = mod.extract_ability_casts(_replay(events), MY_PID)
    assert out["casts"] == []
    assert out["unmapped"] == {}


def test_timestamps_are_real_game_seconds_not_blizzard_game_time():
    """The whole payload shares one clock.

    ``event_seconds`` divides by the replay's real fps (22.4 here);
    sc2reader's ``event.second`` divides by 16 and would put this cast
    at 140s instead of 100s -- 40% adrift from the unit tracks.
    """
    mod, ev = _import_casts()
    cast_ev = _cmd(ev.CommandEvent, 100.0, pid=MY_PID, name="PsionicStorm",
                   loc=(50.0, 60.0))
    assert cast_ev.second == 140      # the value we must NOT use
    out = mod.extract_ability_casts(_replay([cast_ev]), MY_PID)
    assert out["casts"][0]["t"] == 100.0


def test_nexus_mass_recall_splits_chrono_boost_from_strategic_recall():
    """sc2reader 1.8.0's newest datapack is LotV 80949; on newer builds
    Chrono Boost's ability id resolves against 80949's entry and comes
    back named "NexusMassRecall". Chrono Boost targets a STRUCTURE (a
    TargetUnit command), Strategic Recall targets a POINT."""
    mod, ev = _import_casts()
    chrono = _cmd(ev.CommandEvent, 30.0, pid=MY_PID, name="NexusMassRecall",
                  link=723, loc=(40.0, 40.0), target_unit_id=12345)
    recall = _cmd(ev.CommandEvent, 40.0, pid=MY_PID, name="NexusMassRecall",
                  link=723, loc=(90.0, 90.0))
    out = mod.extract_ability_casts(_replay([chrono, recall]), MY_PID)
    assert [c["ability"] for c in out["casts"]] == ["ChronoBoost", "MassRecall"]
    assert out["casts"][0]["targetUnitId"] == 12345
    assert out["casts"][1]["targetUnitId"] is None


def test_owner_is_relative_to_the_requesting_player():
    mod, ev = _import_casts()
    events = [
        _cmd(ev.CommandEvent, 10.0, pid=MY_PID, name="EMPRound", loc=(1.0, 1.0)),
        _cmd(ev.CommandEvent, 20.0, pid=OPP_PID, name="FungalGrowth", loc=(2.0, 2.0)),
    ]
    out = mod.extract_ability_casts(_replay(events), MY_PID)
    assert [(c["owner"], c["ability"]) for c in out["casts"]] == [
        ("me", "EMP"), ("opp", "FungalGrowth"),
    ]


def test_self_cast_is_placed_at_the_casting_units_position():
    """Stim carries no target location. The caster is recovered from
    the player's active selection and its position interpolated off
    the same waypoint track the replayer animates."""
    mod, ev = _import_casts()
    tracks = {
        "my_units": [
            {"id": 7, "name": "Marine", "born": 0.0, "died": None,
             "waypoints": [0.0, 10.0, 10.0, 100.0, 110.0, 10.0]},
        ],
        "opp_units": [],
    }
    events = [
        _selection(ev.SelectionEvent, 40.0, pid=MY_PID, unit_ids=[7]),
        _cmd(ev.CommandEvent, 50.0, pid=MY_PID, name="UseStimpack", link=133),
    ]
    out = mod.extract_ability_casts(_replay(events), MY_PID, tracks)
    cast = out["casts"][0]
    assert cast["ability"] == "Stim"
    # Halfway along a 0->100s track that runs x 10 -> 110.
    assert cast["x"] == 60.0
    assert cast["y"] == 10.0


def test_self_cast_with_no_resolvable_caster_emits_a_null_position():
    """A stale selection must NOT put a Stim on a Warp Gate. Better an
    unplaced cast the client pins to the unit than a wrong one."""
    mod, ev = _import_casts()
    tracks = {
        "my_units": [
            {"id": 9, "name": "Zealot", "born": 0.0, "died": None,
             "waypoints": [0.0, 10.0, 10.0]},
        ],
        "opp_units": [],
    }
    events = [
        # Selection holds a Zealot; Stim can only come from bio.
        _selection(ev.SelectionEvent, 40.0, pid=MY_PID, unit_ids=[9]),
        _cmd(ev.CommandEvent, 50.0, pid=MY_PID, name="UseStimpack", link=133),
    ]
    out = mod.extract_ability_casts(_replay(events), MY_PID, tracks)
    assert out["casts"][0]["x"] is None
    assert out["casts"][0]["y"] is None
    # Same cast with no tracks at all is still emitted, just unplaced.
    out2 = mod.extract_ability_casts(_replay(events), MY_PID)
    assert len(out2["casts"]) == 1
    assert out2["casts"][0]["x"] is None


def test_unmapped_spell_shaped_names_are_reported_but_noise_is_not():
    """Today's unknown name is next patch's mapping entry -- but only
    if it is not buried under 150 Attack commands."""
    mod, ev = _import_casts()
    events = [
        _cmd(ev.CommandEvent, 10.0, pid=MY_PID, name="SomeNewSpell", loc=(1.0, 1.0)),
        _cmd(ev.CommandEvent, 11.0, pid=MY_PID, name="SomeNewSpell", loc=(1.0, 1.0)),
        _cmd(ev.CommandEvent, 12.0, pid=MY_PID, name="Attack", loc=(1.0, 1.0)),
        _cmd(ev.CommandEvent, 13.0, pid=MY_PID, name="TrainProbe"),
        _cmd(ev.CommandEvent, 14.0, pid=MY_PID, name="BuildPylon", loc=(1.0, 1.0)),
        # sc2reader could not name it at all: keyed by link so the next
        # mapping update still has something to go on.
        _cmd(ev.CommandEvent, 15.0, pid=MY_PID, name="", link=724, loc=(1.0, 1.0)),
    ]
    out = mod.extract_ability_casts(_replay(events), MY_PID)
    assert out["casts"] == []
    assert out["unmapped"] == {"SomeNewSpell": 2, "<link 724>": 1}


def test_casts_come_back_in_time_order():
    mod, ev = _import_casts()
    events = [
        _cmd(ev.CommandEvent, 300.0, pid=MY_PID, name="EMPRound", loc=(3.0, 3.0)),
        _cmd(ev.CommandEvent, 100.0, pid=MY_PID, name="PsionicStorm", loc=(1.0, 1.0)),
        _cmd(ev.CommandEvent, 200.0, pid=OPP_PID, name="FungalGrowth", loc=(2.0, 2.0)),
    ]
    out = mod.extract_ability_casts(_replay(events), MY_PID)
    assert [c["t"] for c in out["casts"]] == [100.0, 200.0, 300.0]


def test_fog_of_war_target_reports_no_position_rather_than_the_origin():
    """A TargetUnit command on a unit hidden by fog reports (0, 0).
    Drawing an EMP at map corner (0, 0) is worse than not drawing it."""
    mod, ev = _import_casts()
    fogged = _cmd(ev.CommandEvent, 50.0, pid=MY_PID, name="EMPRound",
                  loc=(0.0, 0.0), target_unit_id=0)
    out = mod.extract_ability_casts(_replay([fogged]), MY_PID)
    assert out["casts"][0]["x"] is None


def test_position_at_interpolates_and_clamps():
    mod, _ = _import_casts()
    wp = [0.0, 0.0, 0.0, 10.0, 100.0, 50.0]
    assert mod._position_at(wp, -5.0) == (0.0, 0.0)     # clamp before
    assert mod._position_at(wp, 5.0) == (50.0, 25.0)    # midpoint
    assert mod._position_at(wp, 99.0) == (100.0, 50.0)  # clamp after
    assert mod._position_at([], 1.0) == (None, None)


def test_extraction_survives_a_hostile_event():
    """Playback is additive: one poisonous event must cost that event,
    not the whole cast list."""
    mod, ev = _import_casts()

    class _Exploding:
        pass

    boom = _cmd(ev.CommandEvent, 20.0, pid=MY_PID, name="PsionicStorm",
                loc=(5.0, 5.0))

    class _Boom(ev.CommandEvent):
        @property
        def ability_name(self):
            raise RuntimeError("corrupt event")

    bad = _Boom()
    bad.frame = 100
    bad.player = SimpleNamespace(pid=MY_PID)
    bad.has_ability = True
    bad.ability_link = 5

    out = mod.extract_ability_casts(_replay([bad, boom]), MY_PID)
    assert [c["ability"] for c in out["casts"]] == ["PsiStorm"]
