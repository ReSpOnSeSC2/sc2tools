"""The desktop card's copy of the widget's seeded opening-unit draw, and
the read that feeds it (``build_checkin/randomizer_draw.py``)."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest

from sc2tools_agent.build_checkin.models import RandomizerStripModel
from sc2tools_agent.build_checkin.randomizer_draw import (
    DrawKey,
    DrawStep,
    RandomizerDraw,
    RandomizerDrawSource,
    draw_for,
    first_steps,
    infer_gate_count,
    mulberry32,
    normalize,
    opening_units,
    overlay_config,
    seed_from_string,
)

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "web" / "lib" / "randomizer" / "__tests__" / "unitDrawParity.json")
    .read_text(encoding="utf-8")
)
KEY = DrawKey(game_key="Foo|Me|1790000000000", matchup="PvP", build_key="pvp-2-gate-expand")
POOL = {"matchups": {"PvP": {"enabled": True, "builds": [
    {"id": "pvp-2-gate-expand", "name": "PvP - 2 Gate Expand", "race": "Protoss"},
]}}}
OFFERED = {"builds": [{"key": "pvp-2-gate-expand", "name": "PvP - 2 Gate Expand", "source": "catalog"}]}
ANSWER = {"config": POOL, "options": OFFERED}


@pytest.mark.parametrize("seed", FIXTURE["seeds"], ids=lambda seed: seed["text"])
def test_the_generator_matches_the_widget_value_for_value(seed: Dict[str, Any]) -> None:
    assert seed_from_string(seed["text"]) == seed["seed"]
    rng = mulberry32(seed["seed"])
    assert [rng() for _ in seed["values"]] == seed["values"]


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=lambda case: case["name"])
def test_the_units_match_the_widget_for_every_fixture_case(case: Dict[str, Any]) -> None:
    key = DrawKey(game_key=case["gameKey"], matchup=case["matchup"], build_key=case["buildKey"])
    served = overlay_config(case["config"], case["matchup"], case["options"])
    assert list(opening_units(served, key)) == case["units"]


def test_the_gateway_count_follows_the_build_name_then_the_matchup() -> None:
    assert infer_gate_count("PvT", "PvT - 2-Gate Blink") == 2
    assert infer_gate_count("PvP", "PvP 1 Gateway Robo") == 1
    assert infer_gate_count("PvP", "PvP - Stargate") == 2
    assert infer_gate_count("PvZ", "PvZ - 12 Gate") == 1


def test_the_widget_draws_from_the_pool_as_the_overlay_serves_it() -> None:
    stored = {"version": 2, "matchups": {
        "PvP": {"enabled": True, "builds": [
            {"id": "kept", "name": "Old name", "race": "Terran", "source": "catalog", "weight": 3},
            {"id": "gone", "name": "Retired", "race": "Protoss"},
            "not a build",
        ]},
        "PvZ": {"enabled": False, "builds": [{"id": "gone", "name": "Retired", "race": "Protoss"}]},
    }}
    offered = {"builds": [{"key": "kept", "name": "1 Gate Kept", "source": "custom"}, {"name": "No key"}]}
    served = overlay_config(stored, "PvP", offered)
    assert served["matchups"]["PvP"] == {"enabled": True, "builds": [
        {"id": "kept", "name": "1 Gate Kept", "race": "Protoss", "source": "custom", "weight": 3},
    ]}
    assert served["matchups"]["PvZ"] is stored["matchups"]["PvZ"] and served["version"] == 2
    assert overlay_config(stored, "PvZ", offered) is stored, "a matchup that is off is served as stored"
    assert overlay_config(stored, "PvP", None)["matchups"]["PvP"]["builds"] == []
    crowded = {"matchups": {"PvP": {"enabled": True, "builds": [{"id": "kept", "name": "x"}] * 501}}}
    assert overlay_config(crowded, "PvP", offered)["matchups"]["PvP"]["builds"] == []


def test_javascript_spaces_count_between_the_number_and_gate() -> None:
    for code in (0xA0, 0x2009, 0x3000, 0xFEFF):
        assert infer_gate_count("PvZ", f"PvZ 2{chr(code)}Gate Blink") == 2, hex(code)
    assert infer_gate_count("PvP", f"PvP 1{chr(0x85)}Gate") == 2, "U+0085 is no JavaScript space"


def sum_left_to_right(values: List[float]) -> float:
    total = 0.0
    for value in values:
        total += value
    return total


def test_sums_run_left_to_right_and_all_zero_weights_share_the_odds() -> None:
    assert normalize([0.1] * 10)[-1] == 0.1 / sum_left_to_right([0.1] * 10)
    assert normalize([0, 0]) == [0.5, 0.5]
    assert normalize([3, -1, 1]) == [0.75, 0.0, 0.25]


def test_a_saved_weight_that_is_not_a_number_counts_as_one() -> None:
    def picks(weight: Any) -> tuple:
        pool = {"matchups": {"PvT": {"enabled": True, "builds": [{
            "id": "b", "name": "PvT Build", "race": "Protoss", "openingUnits": {
                "gateCount": 1, "useCustomWeights": True,
                "units": [{"id": "zealot", "weight": weight}, {"id": "adept", "weight": 1}],
            },
        }]}}}
        return opening_units(pool, DrawKey("Bar|Me|1790000000123", "PvT", "b"))

    assert picks("9") == picks(1) == picks(float("nan"))
    assert picks(None) == picks(0) == ("adept",)


def test_reference_steps_come_first_and_unknown_parts_stay_unknown() -> None:
    build = {
        "buildOrder": {"steps": [
            {"t": 18, "supply": 14, "action": "Pylon"},
            {"t": None, "supply": 15.5, "supplyApprox": True, "action": " Gateway "},
            {"t": 75, "supply": None, "action": "CyberneticsCore"},
            {"t": 80, "supply": 19, "action": ""},
            {"t": 95, "supply": 20, "action": "Nexus"},
            {"t": 100, "supply": 21, "action": "Stalker"},
        ]},
        "steps": [{"supply": 9, "time": "0:05", "action": "Ignored legacy step"}],
    }
    assert first_steps(build) == (
        DrawStep("Pylon", "0:18", "14"),
        DrawStep("Gateway", None, "\N{ALMOST EQUAL TO}15.5"),
        DrawStep("CyberneticsCore", "1:15", None),
        DrawStep("Nexus", "1:35", "20"),
    )
    assert first_steps({"steps": [{"supply": 14, "time": " 0:18 ", "action": "Pylon"}]}) == (
        DrawStep("Pylon", "0:18", "14"),
    )
    assert first_steps({}) == first_steps(None) == first_steps({"buildOrder": {"steps": []}}) == ()


def test_a_draw_combines_the_units_and_the_custom_steps() -> None:
    custom = DrawKey(KEY.game_key, "PvP", "custom:two-gate")
    config = {"matchups": {"PvP": {"enabled": True, "builds": [
        {"id": "custom:two-gate", "name": "My 2 Gate", "race": "Protoss"},
    ]}}}
    answer = {"config": config, "options": {"builds": [{"key": "custom:two-gate", "name": "My 2 Gate", "source": "custom"}]},
              "build": {"steps": [{"supply": 14, "action": "Pylon"}]}}
    draw = draw_for(custom, answer)
    assert draw == RandomizerDraw(KEY.game_key, "custom:two-gate", (DrawStep("Pylon", None, "14"),), ("Zealot", "Adept"))
    assert draw_for(KEY, {"config": None, "build": None}).empty


class Starts:
    """Runs each read when the test says so."""

    def __init__(self) -> None:
        self.pending: List[Any] = []

    def __call__(self, work: Any) -> None:
        self.pending.append(work)

    def run(self) -> None:
        while self.pending:
            self.pending.pop(0)()


def card(build_key: str = KEY.build_key, game_key: str = KEY.game_key, matchup: str = "PvP") -> Any:
    strip = RandomizerStripModel(label="", rolled_key=build_key, rolled_name="PvP - 2 Gate Expand")
    return SimpleNamespace(game_key=game_key, matchup=matchup, randomizer=strip)


def test_the_source_reads_once_per_saved_pick_and_delivers_the_still() -> None:
    reads: List[Dict[str, Any]] = []
    delivered: List[RandomizerDraw] = []
    starts = Starts()
    source = RandomizerDrawSource(lambda request: reads.append(request) or ANSWER, start=starts)
    source.request(card(), delivered.append)
    source.request(card(), delivered.append)
    starts.run()
    source.request(card(), delivered.append)
    starts.run()
    assert reads == [{"action": "randomizer_draw", "matchup": "PvP", "customSlug": None}]
    assert [draw.units for draw in delivered] == [("Zealot", "Adept")]
    source.request(card("pvp-1-gate"), delivered.append)
    assert len(starts.pending) == 1, "a reroll is a new pick"


def test_nothing_is_read_when_the_card_shows_no_pick_or_nothing_more_exists() -> None:
    starts = Starts()
    source = RandomizerDrawSource(lambda _request: pytest.fail("no read expected"), start=starts)
    source.request(SimpleNamespace(game_key="g", matchup="PvP", randomizer=None), lambda _draw: None)
    source.request(card(matchup=None), lambda _draw: None)
    source.request(card("tvz-reaper", matchup="TvZ"), lambda _draw: None)
    assert starts.pending == []


def test_a_failed_read_is_tried_once_more_and_an_empty_draw_is_not_shown() -> None:
    answers: List[Any] = [RuntimeError("offline"), {"config": {}}]
    delivered: List[RandomizerDraw] = []
    starts = Starts()

    def fetch(_request: Dict[str, Any]) -> Any:
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    source = RandomizerDrawSource(fetch, start=starts)
    for _ in range(3):
        source.request(card(), delivered.append)
        starts.run()
    assert answers == [] and delivered == []


def test_a_read_for_a_replaced_pick_is_dropped() -> None:
    delivered: List[RandomizerDraw] = []
    starts = Starts()
    source = RandomizerDrawSource(lambda _request: ANSWER, start=starts)
    source.request(card(), delivered.append)
    source.request(card(game_key="Next|Me|1790000009999"), delivered.append)
    starts.run()
    assert [draw.game_key for draw in delivered] == ["Next|Me|1790000009999"]
