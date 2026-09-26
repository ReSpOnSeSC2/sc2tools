"""An accepted UI request alone must never pass the native group fixture."""
from copy import deepcopy
import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from s2clientprotocol import sc2api_pb2 as api
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.fairplay import ActionBudget, CAMERA_WIDTH, FAIRPLAY_VERSION, SCREEN_SIZE
from pluto_sc2.schema import ACTION_TO_INDEX


path = Path(__file__).parents[1] / "scripts/verify_group_controls.py"
spec = importlib.util.spec_from_file_location("verify_group_controls", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def evidence():
    report = {"starting_workers": [8, 8], "engine_results": ["Defeat", "Victory"],
              "concession_reason": "verification_complete", "debug_used": False,
              "learned_policy_used": False, "ppo_updates": 0, "corpus_writes": False,
              "setup_probe_queues_empty": True, "previously_seen_army_tags": [21, 22], "cases": {}}
    cases, actions, groups = report["cases"], [], {}

    def selection(name, mode, selected, sources, positions, camera=(50, 50), group=None, types=None):
        index = len(actions)
        loop = round((index + 1) * .4 * 22.4)
        event = {"kind": "selection", "selection_mode": mode, "time": (index + 1) * .4,
                 "camera": list(camera), "source_tags": sources, "source_positions": positions,
                 "selected_tags": selected, "command_source_tags": selected, "result": [1],
                 "selection_confirmation": "confirmed", "command_confirmation": "selection_only",
                 "command_loop": loop}
        if group is not None:
            event.update(control_group=group, registered_tags=groups[group]["tags"],
                         group_assignment_audit_index=groups[group]["index"])
        if mode == "rectangle":
            scale = SCREEN_SIZE[0] / CAMERA_WIDTH
            pixels = [[int(SCREEN_SIZE[0] / 2 + (p[0] - camera[0]) * scale),
                       int(SCREEN_SIZE[1] / 2 - (p[1] - camera[1]) * scale)] for p in positions]
            event["selection_rectangle"] = [[min(p[axis] for p in pixels) - 1 for axis in (0, 1)],
                                              [max(p[axis] for p in pixels) + 1 for axis in (0, 1)]]
        actions.append(event)
        cases[name] = {"selection_index": index, "observation_loop": loop,
                       "selected_tags": selected, "types": types or {}, "current_visible_tags": sources}
        return index

    def assign(name, group, selected_case, tags, sources, positions, camera=(50, 50), append=False):
        index = len(actions)
        old = groups[group]["tags"] if append else []
        event = {"kind": "selection", "selection_mode": "control_group_append" if append else "control_group_set",
                 "time": (index + 1) * .4, "camera": list(camera), "result": [1], "control_group": group,
                 "source_tags": sources, "source_positions": positions,
                 "selected_tags": cases[selected_case]["selected_tags"], "registered_tags": tags,
                 "prior_group_tags": old, "selection_provenance_audit_index": cases[selected_case]["selection_index"]}
        actions.append(event)
        groups[group] = {"tags": tags, "index": index}
        cases[name] = {"assignment_index": index}

    selection("nexus_first", "point", [11], [11], [[50, 50]], types={"11": U.NEXUS.value})
    assign("nexus_set", 2, "nexus_first", [11], [11], [[50, 50]])
    selection("nexus_second", "point", [12], [12], [[56, 50]], types={"12": U.NEXUS.value})
    assign("nexus_append", 2, "nexus_second", [11, 12], [12], [[56, 50]], append=True)
    selection("mixed_rectangle", "rectangle", [21, 22], [21, 22], [[50, 50], [51, 50]],
              types={"21": U.ZEALOT.value, "22": U.STALKER.value})
    selection("army_f2", "army", [21, 22], [22], [[70, 50]], camera=(70, 50))
    cases["army_f2"]["previously_seen_offscreen_tags"] = [21]
    assign("army_set", 1, "army_f2", [21, 22], [22], [[70, 50]], camera=(70, 50))
    selection("army_deselect", "point", [22], [22], [[70, 50]], camera=(70, 50))
    selection("army_recall", "control_group", [21, 22], [], [], camera=(70, 50), group=1)
    army_index = selection("army_ground", "control_group", [21, 22], [], [], camera=(70, 50), group=1)
    command_index = len(actions)
    actions[army_index]["command_confirmation"] = "accepted"
    actions.append({"kind": "command", "selection_mode": "control_group", "control_group": 1,
        "time": (command_index + 1) * .4, "camera": [70, 50], "result": [1],
        "ability": A.ATTACK_ATTACK.value, "target": [73, 50], "effective_target": [73, 50],
        "target_kind": "ground", "minimap": False, "ground_target_safety": "current_visible_empty_screen",
        "game_loop": round((command_index + 1) * .4 * 22.4), "selection_audit_index": army_index,
        "selection_provenance_audit_index": army_index, "source_tags": [21, 22],
        "visible_command_source_tags": [22], "offscreen_selected_count": 1, "source_free_ground_command": False,
        "group_production": None})
    cases["army_ground"] = {"selection_index": army_index, "command_index": command_index,
        "previously_offscreen_tag": 21, "last_seen_loop": 10, "last_seen_position": [50, 50],
        "native_order_loop": 110, "native_order": {"ability_id": 23, "target_unit_tag": None,
                                                    "target_world_position": [73, 51]},
        "friendly_order_seen": False, "distance_moved": 18, "distance_to_command": 5, "arrival_loop": 115}
    production = {"workers_before": 12, "workers_after": 14, "baseline_loop": 116,
                  "command_indices": [], "worker_observation_loop": 500,
                  "no_other_probe_orders_during_measurement": True}
    for number in range(2):
        index = selection(f"production_{number}", "control_group", [11, 12], [], [], camera=(70, 50), group=2)
        actions[index].update(command_confirmation="production_subselection", diagnostic_visible_nexus_tags=[])
        child = selection(f"producer_{number}", "control_group_producer", [11 + number], [], [], camera=(70, 50), group=2)
        actions[child].update(command_confirmation="accepted", parent_selection_audit_index=index,
            parent_selected_tags=[11, 12], production_ui_index=number, production_ui_unit_type=U.NEXUS.value,
            diagnostic_visible_nexus_tags=[])
        command_index = len(actions)
        loop = round((command_index + 1) * .4 * 22.4)
        actions[child]["command_loop"] = loop
        actions.append({"kind": "command", "selection_mode": "control_group_producer", "control_group": 2,
            "time": (command_index + 1) * .4, "camera": [70, 50], "result": [1],
            "ability": A.NEXUSTRAIN_PROBE.value, "target": None, "target_kind": "none", "minimap": False,
            "game_loop": loop, "selection_audit_index": child, "selection_provenance_audit_index": child,
            "source_tags": [11 + number], "visible_command_source_tags": [], "offscreen_selected_count": 1,
            "diagnostic_visible_nexus_tags": [], "source_free_ground_command": False,
            "diagnostic_ui_before": {"panel": "single", "unit": {"unit_type": U.NEXUS.value,
                "player_relative": 1, "build_progress": 1}, "abilities": [A.NEXUSTRAIN_PROBE.value],
                "game_loop": loop, "build_queue_count": None, "production_queue_count": None},
            "group_production": {"kind": "train", "group": 2, "selection_ui_abilities": [A.NEXUSTRAIN_PROBE.value],
                "mineral_cost": 50, "vespene_cost": 0, "supply_cost": 1,
                "queue_evidence": {"source": "selected_production_panel", "producer_count": 1,
                    "producer_type": U.NEXUS.value, "build_queue_count": 0, "production_queue_count": 0,
                    "queue_item_count": 0},
                "group_assignment_audit_index": groups[2]["index"]}})
        production["command_indices"].append(command_index)
        if number == 0:
            production["first_observed_queue"] = {"panel": "production", "unit": {"unit_type": U.NEXUS.value,
                "player_relative": 1}, "selected_tags": [11], "game_loop": loop + 1,
                "build_queue": [{"unit_type": U.PROBE.value}], "production_queue": [],
                "build_queue_count": 1, "production_queue_count": 0}
    cases["offscreen_production"] = production
    budget = ActionBudget(200)
    for event in actions:
        assert budget.consume(event["time"])
    return report, {"summary": {"version": FAIRPLAY_VERSION, "max_apm": 200, "total_actions": budget.total,
        "peak_rolling_60s_actions": budget.peak, "minimum_input_interval_seconds": budget.interval,
        "raw_unit_commands": 0}, "actions": actions}


def test_complete_native_selection_and_hud_evidence_passes():
    module.verify_evidence(*evidence())


@pytest.mark.parametrize("change,match", [
    (lambda r, a: r.update(starting_workers=[12, 8]), "eight workers"),
    (lambda r, a: r.update(engine_results=["Defeat", "Unknown"]), "paired normal"),
    (lambda r, a: r.update(concession_reason="verification_timeout"), "paired normal"),
    (lambda r, a: r.update(debug_used=True), "isolation"),
    (lambda r, a: r.update(ppo_updates=1), "isolation"),
    (lambda r, a: r.update(corpus_writes=True), "isolation"),
    (lambda r, a: r.update(setup_probe_queues_empty=False), "Setup Probe queues"),
    (lambda r, a: r["cases"]["mixed_rectangle"].update(types={"21": U.ZEALOT.value, "22": U.PROBE.value}), "Zealot and a Stalker"),
    (lambda r, a: r["cases"]["army_f2"].update(previously_seen_offscreen_tags=[]), "offscreen army"),
    (lambda r, a: r["cases"]["army_f2"].update(current_visible_tags=[21, 22]), "offscreen army"),
    (lambda r, a: r.update(previously_seen_army_tags=[22]), "prior current-screen"),
    (lambda r, a: r["cases"]["offscreen_production"].update(workers_after=12), "two observed additional"),
    (lambda r, a: r["cases"]["offscreen_production"].update(workers_after=13), "two observed additional"),
    (lambda r, a: r["cases"]["offscreen_production"].update(worker_observation_loop=1), "two observed additional"),
    (lambda r, a: r["cases"]["offscreen_production"].update(no_other_probe_orders_during_measurement=False), "two observed additional"),
])
def test_incomplete_or_contaminated_native_evidence_fails(change, match):
    report, audit = evidence()
    change(report, audit)
    with pytest.raises(RuntimeError, match=match):
        module.verify_evidence(report, audit)


@pytest.mark.parametrize("mutation,match", [
    (lambda event: event.update(result=[2]), "not accepted"),
    (lambda event: event.update(selection_mode="point"), "UI selection mode"),
    (lambda event: event.update(selection_confirmation="requested"), "engine-confirmed"),
    (lambda event: event.update(selected_tags=[21]), "subsequent native"),
])
def test_rectangle_requires_actual_engine_selection(mutation, match):
    report, audit = evidence()
    mutation(audit["actions"][report["cases"]["mixed_rectangle"]["selection_index"]])
    with pytest.raises(RuntimeError, match=match):
        module.verify_evidence(report, audit)


@pytest.mark.parametrize("mutation,match", [
    (lambda event: event.update(result=[2]), "not accepted"),
    (lambda event: event.update(diagnostic_visible_nexus_tags=[11]), "not offscreen"),
    (lambda event: event["group_production"].update(selection_ui_abilities=[]), "selected UI ability"),
    (lambda event: event["group_production"].update(group=1), "selected UI ability"),
    (lambda event: event.update(target=[50, 50]), "selected UI ability"),
])
def test_offscreen_production_requires_actual_recall_and_ui_validation(mutation, match):
    report, audit = evidence()
    mutation(audit["actions"][report["cases"]["offscreen_production"]["command_indices"][0]])
    with pytest.raises(RuntimeError, match=match):
        module.verify_evidence(report, audit)


def test_group_append_must_preserve_the_first_nexus():
    report, audit = evidence()
    audit["actions"][report["cases"]["nexus_append"]["assignment_index"]]["registered_tags"] = [12]
    with pytest.raises(RuntimeError, match="append lost"):
        module.verify_evidence(report, audit)


@pytest.mark.parametrize("mutation,match", [
    (lambda proof: proof.update(distance_moved=0), "did not visibly arrive"),
    (lambda proof: proof.update(distance_to_command=20), "did not visibly arrive"),
    (lambda proof: proof.update(friendly_order_seen=True), "did not visibly arrive"),
    (lambda proof: proof["native_order"].update(target_unit_tag=22), "native point order"),
    (lambda proof: proof.update(native_order_loop=1), "native point order"),
    (lambda proof: proof["native_order"].update(target_world_position=[90, 50]), "native point order"),
])
def test_group_command_requires_real_safe_movement_of_offscreen_member(mutation, match):
    report, audit = evidence()
    mutation(report["cases"]["army_ground"])
    with pytest.raises(RuntimeError, match=match):
        module.verify_evidence(report, audit)


def test_queue_cap_proof_is_required_even_when_resources_are_available():
    report, audit = evidence()
    command = audit["actions"][report["cases"]["offscreen_production"]["command_indices"][0]]
    command["group_production"]["queue_evidence"]["queue_item_count"] = 2
    with pytest.raises(RuntimeError, match="bounded selected production queue"):
        module.verify_evidence(report, audit)


@pytest.mark.parametrize("field,value", [("panel", "single"), ("selected_tags", [12]), ("game_loop", 1),
                                         ("build_queue", [])])
def test_idle_panel_acceptance_requires_real_subsequent_probe_queue(field, value):
    report, audit = evidence()
    report["cases"]["offscreen_production"]["first_observed_queue"][field] = value
    with pytest.raises(RuntimeError, match="transition to an actual"):
        module.verify_evidence(report, audit)


def test_ui_snapshot_distinguishes_missing_single_and_production_panels():
    observation = api.Observation()
    assert module.ui_panel_snapshot(observation)["panel"] is None
    observation.ui_data.single.unit.unit_type = U.NEXUS.value
    observation.ui_data.single.unit.player_relative = 1
    observation.abilities.add(ability_id=A.NEXUSTRAIN_PROBE.value)
    single = module.ui_panel_snapshot(observation)
    assert single["panel"] == "single" and single["unit"]["unit_type"] == U.NEXUS.value
    assert single["build_queue_count"] is None and single["production_queue_count"] is None
    assert not module.observed_probe_queue(single)
    observation.ui_data.production.unit.unit_type = U.NEXUS.value
    observation.ui_data.production.unit.player_relative = 1
    observation.ui_data.production.production_queue.add(ability_id=A.NEXUSTRAIN_PROBE.value, build_progress=.1)
    production = module.ui_panel_snapshot(observation)
    assert production["panel"] == "production" and production["production_queue_count"] == 1
    assert module.observed_probe_queue(production)
    production["unit"]["player_relative"] = 4
    assert not module.observed_probe_queue(production)


def test_original_recall_and_portrait_are_distinct_paid_inputs():
    report, audit = evidence()
    command = audit["actions"][report["cases"]["offscreen_production"]["command_indices"][0]]
    child_index = command["selection_audit_index"]
    parent_index = audit["actions"][child_index]["parent_selection_audit_index"]
    assert module.selection_leaf(audit["actions"], parent_index) == child_index
    assert parent_index < child_index < report["cases"]["offscreen_production"]["command_indices"][0]


def test_additional_probe_command_invalidates_measurement_even_if_flag_claims_clean():
    report, audit = evidence()
    extra = deepcopy(audit["actions"][report["cases"]["offscreen_production"]["command_indices"][0]])
    audit["actions"].append(extra)
    with pytest.raises(RuntimeError, match="Additional Probe orders"):
        module.verify_evidence(report, audit)


def test_real_pacing_auditor_rejects_more_than_200_apm_budget():
    report, audit = evidence()
    audit["actions"][3]["time"] = audit["actions"][2]["time"] + .1
    with pytest.raises(ValueError, match="APM or minimum"):
        module.verify_evidence(report, audit)


def test_numpy_point_target_never_uses_ambiguous_bool():
    point = Point2((np.float64(0), np.float64(7.5)))
    assert module.point_values(point) == [0.0, 7.5]
    assert module.point_values(None) is None
    assert module.point_values(SimpleNamespace(position=point)) == [0.0, 7.5]


def test_setup_does_not_interrupt_pending_builder(monkeypatch):
    builder = SimpleNamespace(tag=7, is_idle=False, type_id=U.PROBE, _proto=SimpleNamespace(orders=[]))
    audit = [{"command_confirmation": "accepted"}]
    bot = SimpleNamespace(time=11, last_setup_check=0, setup_pending={"name": "build_gateway", "source_tag": 7,
        "type_id": U.GATEWAY.value, "prior_tags": [], "ability_ids": [883], "audit_index": 0, "issued": 10},
        fairplay=SimpleNamespace(audit=audit, camera_center=Point2((50, 50))),
        setup_done=set(), setup_attempts={"build_gateway": 1}, report={},
        supply_workers=8, minerals=200, vespene=0)

    async def mask(_):
        return np.zeros(len(ACTION_TO_INDEX), dtype=np.bool_)

    async def forbidden(*args):
        pytest.fail("A pending builder must not receive another setup command")

    monkeypatch.setattr(module, "legal_action_mask", mask)
    monkeypatch.setattr(module, "execute_action", forbidden)
    asyncio.run(module.GroupControlsProbe.setup(bot, [builder]))
    assert bot.setup_pending is not None and "build_gateway" not in bot.setup_done


def test_setup_cannot_silently_wait_forever_for_accepted_build(monkeypatch):
    builder = SimpleNamespace(tag=7, is_idle=False, type_id=U.PROBE, _proto=SimpleNamespace(orders=[]))
    bot = SimpleNamespace(time=100, last_setup_check=0, setup_pending={"name": "build_gateway", "source_tag": 7,
        "type_id": U.GATEWAY.value, "prior_tags": [], "ability_ids": [883], "audit_index": 0, "issued": 10},
        fairplay=SimpleNamespace(audit=[{"command_confirmation": "accepted"}], camera_center=Point2((50, 50))),
        setup_done=set(), report={}, minerals=400, vespene=100, supply_workers=12)
    with pytest.raises(RuntimeError, match="not observed in time"):
        asyncio.run(module.GroupControlsProbe.setup(bot, [builder]))


def test_failed_selection_is_retried_without_advancing_case():
    bot = SimpleNamespace(operation={"name": "army_f2", "selection_index": 0, "ability": None},
        fairplay=SimpleNamespace(pending=False, audit=[{"command_confirmation": "source_not_selected"}]), report={})
    assert module.GroupControlsProbe.finish_selection(bot, []) is True
    assert bot.operation is None and len(bot.report["selection_retries"]) == 1


def test_error_concedes_normally_before_preserving_failure(monkeypatch):
    calls = []

    def fail_sync(_):
        raise RuntimeError("expected failure")

    async def concede(reason):
        calls.append(reason)

    bot = SimpleNamespace(leaving=False, fairplay=SimpleNamespace(sync_camera=fail_sync),
                          report={}, save=lambda: None, concede=concede)
    with pytest.raises(RuntimeError, match="expected failure"):
        asyncio.run(module.GroupControlsProbe.on_step(bot, 0))
    assert calls == ["diagnostic_error"]
    assert "expected failure" in bot.report["bot_error"]


@pytest.mark.parametrize("seconds", [0, 119, 551, float("inf"), float("nan"), True])
def test_invalid_duration_rejected_before_any_engine_launch(tmp_path, monkeypatch, seconds):
    monkeypatch.setattr(module, "run_game", lambda *a, **k: pytest.fail("Must not launch"))
    with pytest.raises(RuntimeError, match="bounded"):
        module.verify(tmp_path / "new", "unused", seconds)


def test_existing_engine_prevents_duplicate_launch(tmp_path, monkeypatch):
    monkeypatch.setattr(module.psutil, "process_iter", lambda fields: [SimpleNamespace(info={"name": "SC2_x64.exe"})])
    monkeypatch.setattr(module, "run_game", lambda *a, **k: pytest.fail("Must not launch"))
    with pytest.raises(RuntimeError, match="already active"):
        module.verify(tmp_path / "new", "unused")


def test_stop_marker_prevents_launch(tmp_path, monkeypatch):
    output = tmp_path / "new"
    output.mkdir()
    (output / "STOP").write_text("paused", encoding="utf-8")
    monkeypatch.setattr(module.psutil, "process_iter", lambda fields: [])
    monkeypatch.setattr(module, "run_game", lambda *a, **k: pytest.fail("Must not launch"))
    with pytest.raises(RuntimeError, match="STOP marker"):
        module.verify(output, "unused")


def test_production_controller_has_no_legacy_diagnostic_override(tmp_path):
    probe = module.GroupControlsProbe({"cases": {}}, tmp_path, 450)
    assert type(probe.fairplay) is module.FairPlayController
    assert not hasattr(probe.fairplay, "issue_probe")
    assert probe.fairplay.budget.max_apm == 200


def test_fixture_site_uses_static_nearest_expansion_not_initial_base():
    assert module.fixture_expansion_site([(50, 50), (55, 50), (70, 50), (120, 120)], Point2((50, 50))) == (70, 50)
    with pytest.raises(RuntimeError, match="No public expansion"):
        module.fixture_expansion_site([(50, 50)], Point2((50, 50)))


def expansion_bot(monkeypatch, *, worker_visible=True, footprint_visible=True, camera_at_site=True):
    calls = []
    worker = SimpleNamespace(tag=7, type_id=U.PROBE, is_ready=True,
                             position=Point2((70, 50)), distance_to=lambda p: 0)

    async def move_camera(bot, point):
        calls.append(("camera", point))
        return True

    async def available(units, **kwargs):
        assert units == [worker]
        calls.append(("ability", [unit.tag for unit in units]))
        return [[A.PROTOSSBUILD_NEXUS]]

    async def can_place(ability, point):
        calls.append(("placement", point))
        return True

    async def issue(bot, units, ability, point, **kwargs):
        assert units == [worker]
        calls.append(("input", ability, point))
        return True

    monkeypatch.setattr(module, "_visible_footprint", lambda bot, point, width: footprint_visible)
    monkeypatch.setattr(module, "_placement_width", lambda bot, kind: 5)
    bot = SimpleNamespace(time=25, nexus_task={"position": [70, 50], "source_tag": 7,
        "started": 20, "move_selection_index": 0}, setup_done=set(), setup_attempts={}, setup_pending=None,
        nexuses_seen={11: {}}, fairplay=SimpleNamespace(audit=[{"command_confirmation": "accepted"}],
            on_screen=lambda point: camera_at_site, move_camera=move_camera, issue=issue),
        get_available_abilities=available, can_place_single=can_place,
        game_data=SimpleNamespace(abilities={A.PROTOSSBUILD_NEXUS.value: SimpleNamespace(id=A.PROTOSSBUILD_NEXUS)}))
    return bot, [worker] if worker_visible else [], calls


@pytest.mark.parametrize("case", ["fog", "worker_offscreen", "site_offscreen"])
def test_expansion_queries_require_both_current_worker_and_entire_visible_footprint(monkeypatch, case):
    bot, own, calls = expansion_bot(monkeypatch, worker_visible=case != "worker_offscreen",
                                   footprint_visible=case != "fog", camera_at_site=case != "site_offscreen")
    asyncio.run(module.GroupControlsProbe.nexus_fixture_step(bot, own))
    assert not any(call[0] in {"ability", "placement", "input"} for call in calls)
    assert bool(calls) is (case == "site_offscreen")
    if case == "site_offscreen":
        assert calls[0][0] == "camera"


def test_current_visible_site_uses_native_placement_and_tracks_actual_pending_builder(monkeypatch):
    bot, own, calls = expansion_bot(monkeypatch)
    asyncio.run(module.GroupControlsProbe.nexus_fixture_step(bot, own))
    assert [call[0] for call in calls] == ["ability", "placement", "input"]
    assert bot.setup_pending["source_tag"] == 7 and bot.setup_pending["name"] == "build_nexus"
    assert bot.setup_pending["target"] == [70.0, 50.0]
    assert "build_nexus" not in bot.setup_done  # Input acceptance is not observed construction.


def test_fixture_builder_missing_from_view_cannot_wait_forever(monkeypatch):
    bot, own, calls = expansion_bot(monkeypatch, worker_visible=False)
    bot.time = 70
    with pytest.raises(RuntimeError, match="builder did not enter"):
        asyncio.run(module.GroupControlsProbe.nexus_fixture_step(bot, own))
    assert not calls


def test_setup_can_finish_after_separate_camera_visits_to_two_nexuses(monkeypatch):
    new_nexus = SimpleNamespace(tag=12, type_id=U.NEXUS, is_ready=True, is_idle=True)
    next_phase = []
    bot = SimpleNamespace(time=300, last_setup_check=0, setup_pending=None, initial_nexus=11,
        setup_done={name for name, _ in module.SETUP}, army_seen={21: {"type_id": U.ZEALOT.value},
        22: {"type_id": U.STALKER.value}}, report={"setup_probe_queues_empty": True}, minerals=200, vespene=0,
        supply_workers=12, fairplay=SimpleNamespace(camera_center=Point2((70, 50))), state=SimpleNamespace(game_loop=6720),
        phase_to=lambda phase: next_phase.append(phase))
    asyncio.run(module.GroupControlsProbe.setup(bot, [new_nexus]))
    assert next_phase == ["nexus_first"]
