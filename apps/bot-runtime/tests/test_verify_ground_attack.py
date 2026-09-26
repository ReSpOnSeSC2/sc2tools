"""Native diagnostic evidence must establish real point orders, not just clicks."""
from copy import deepcopy
import asyncio
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
import numpy as np
from s2clientprotocol import raw_pb2
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.fairplay import ActionBudget, FAIRPLAY_VERSION
from pluto_sc2.schema import ACTION_NAMES, ACTION_TO_INDEX


source = Path(__file__).parents[1] / "scripts" / "verify_ground_attack.py"
spec = importlib.util.spec_from_file_location("verify_ground_attack", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def evidence():
    report = dict(starting_workers=[8, 8], engine_results=["Defeat", "Victory"],
                  concession_reason="verification_complete", debug_used=False, learned_policy_used=False,
                  ppo_updates=0, corpus_writes=False, nexus_alive_at_end=True, nexus_tag=12,
                  max_owned_zealots=1, post_stop_stable_seconds=2,
                  nexus_position=[50, 50], nexus_footprint_radius=2.5,
                  public_abilities={"23": {"target": "PointOrUnit"}}, cases={})
    actions = []
    budget = ActionBudget(200)
    for case_number, (case, ability) in enumerate(module.CASES.items()):
        start = case_number * 3.0
        corner = case in module.CORNER_DIRECTIONS
        intended, camera_target = (module.corner_geometry(case, (50, 50), 2.5) if corner
                                   else (Point2((50, 50)), Point2((50, 50))))
        camera_index = None
        if corner:
            camera_index = len(actions)
            actions.append(dict(kind="camera", time=start - .4, camera=[50, 50],
                                destination=list(camera_target), result=[1]))
        selection_index = len(actions)
        common = dict(camera=list(camera_target), source_tags=[11])
        actions.append(dict(common, kind="selection", time=start, ability=ability,
                            source_positions=[[50, 50]], result=[1]))
        command_loop = round((start + .4) * 22.4)
        destination = [70, 50] if case == "legacy_nexus" else [55, 50]
        actions.append(dict(common, kind="command", time=start + .4, ability=ability,
                            minimap=case == "legacy_nexus", target=destination, effective_target=destination,
                            intended_target=list(intended),
                            diagnostic_case=case, game_loop=command_loop, result=[1],
                            ground_target_safety="current_visible_empty_screen",
                            ground_redirect_reason="offscreen_forward_waypoint" if case == "guarded_offscreen"
                                else "occupied_screen_target",
                            diagnostic_only_exact_ability=case == "legacy_nexus",
                            diagnostic_screen_evidence=dict(player_relative=0, unit_type=0, unit_density=0,
                                                            visibility_map=2, pathable=1),
                            selection_audit_index=selection_index))
        stop_index = len(actions)
        actions.append(dict(common, kind="selection", time=start + .8, ability=4,
                            source_positions=[[50, 50]], result=[1]))
        stop_loop = round((start + 1.2) * 22.4)
        actions.append(dict(common, kind="command", time=start + 1.2, ability=4,
                            minimap=False, target=None, game_loop=stop_loop, result=[1],
                            selection_audit_index=stop_index))
        report["cases"][case] = dict(source_tag=11, observation_loop=command_loop + 2,
            stop_selection_audit_index=stop_index, stop_observation_loop=stop_loop + 2,
            order=dict(ability_id=ability, target_unit_tag=12 if case == "legacy_nexus" else None,
                       target_world_position=None if case == "legacy_nexus" else destination),
            stop_confirmed=True, friendly_order_seen=case == "legacy_nexus",
            target_was_offscreen=case == "guarded_offscreen", distance_advanced=2.5,
            goal_distance_before=20, goal_distance_after=17.5, target=list(intended))
        if corner:
            report["cases"][case]["prepared_camera"] = {"target": list(camera_target),
                                                       "audit_index": camera_index}
    for event in actions:
        assert budget.consume(event["time"])
    summary = dict(version=FAIRPLAY_VERSION, max_apm=200, total_actions=budget.total,
                   peak_rolling_60s_actions=budget.peak, raw_unit_commands=0,
                   minimum_input_interval_seconds=budget.interval)
    return report, dict(summary=summary, actions=actions)


def test_full_native_order_and_movement_evidence_passes():
    module.verify_evidence(*evidence())


def guarded_evidence():
    report, audit = evidence()
    report.update(mode="guarded_only", legacy_reproduction_in_this_game=False)
    report["cases"].pop("legacy_nexus")
    audit["actions"] = audit["actions"][4:]
    for action in audit["actions"]:
        if "selection_audit_index" in action:
            action["selection_audit_index"] -= 4
    for case in report["cases"].values():
        case["stop_selection_audit_index"] -= 4
        if "prepared_camera" in case:
            case["prepared_camera"]["audit_index"] -= 4
    audit["summary"].update(total_actions=len(audit["actions"]), peak_rolling_60s_actions=len(audit["actions"]))
    return report, audit


def test_guarded_only_requires_six_real_guarded_cases_without_legacy_claim():
    module.verify_evidence(*guarded_evidence())


def test_guarded_only_cannot_claim_it_reproduced_legacy_attack():
    report, audit = guarded_evidence()
    report["legacy_reproduction_in_this_game"] = True
    with pytest.raises(RuntimeError, match="cannot claim"):
        module.verify_evidence(report, audit)


def test_guarded_only_still_requires_native_forward_movement():
    report, audit = guarded_evidence()
    report["cases"]["guarded_offscreen"]["distance_advanced"] = 0
    with pytest.raises(RuntimeError, match="did not move"):
        module.verify_evidence(report, audit)


def test_guarded_only_does_not_allow_an_extra_legacy_case():
    report, audit = evidence()
    report.update(mode="guarded_only", legacy_reproduction_in_this_game=False)
    with pytest.raises(RuntimeError, match="Unexpected legacy case"):
        module.verify_evidence(report, audit)


def test_prior_legacy_reference_preserves_failed_whole_run_status(tmp_path):
    prior = tmp_path / "verification.json"
    prior.write_text(json.dumps(dict(passed=False, error="Later native ability 24 rejected", nexus_tag=12,
        cases={"legacy_nexus": dict(friendly_order_seen=True, stop_confirmed=True,
            order=dict(ability_id=23, target_unit_tag=12))})), encoding="utf-8")
    reference = module.prior_legacy_reference(prior)
    assert reference["legacy_case_observed"] and reference["legacy_stop_confirmed"]
    assert reference["whole_prior_diagnostic_passed"] is False
    assert reference["prior_error"] == "Later native ability 24 rejected"
    assert len(reference["sha256"]) == 64


def test_guarded_only_setup_starts_production_case_without_unsafe_reproduction(tmp_path):
    probe = module.GroundAttackProbe({}, tmp_path, 540, guarded_only=True)
    zealot = setup_unit(U.ZEALOT, 11)
    asyncio.run(probe.setup([zealot]))
    assert probe.phase == "start_guarded_nexus"
    assert probe.fairplay.used_cases == set()


def test_case_order_preserves_original_cases_and_exercises_four_corners_before_advancing():
    sequence = module.case_sequence(True)
    assert sequence[0] == "guarded_nexus" and sequence[-1] == "guarded_offscreen"
    assert set(sequence[1:-1]) == set(module.CORNER_DIRECTIONS)
    assert len(sequence) == 6 and len(module.case_sequence()) == 7


@pytest.mark.parametrize("case", module.CORNER_DIRECTIONS)
def test_corner_targets_are_inside_square_but_outside_inscribed_circle(case):
    target, camera = module.corner_geometry(case, (143.5, 149.5), 2.5)
    center = Point2((143.5, 149.5))
    assert max(abs(target.x - center.x), abs(target.y - center.y)) < 2.5
    assert target.distance_to(center) > 2.5
    sx, sy = module.CORNER_DIRECTIONS[case]
    assert camera == center.offset((sx * 3, sy * 2))


def test_missing_one_corner_command_cannot_pass_the_expanded_gate():
    report, audit = evidence()
    audit["actions"] = [row for row in audit["actions"] if row.get("diagnostic_case") != "guarded_corner_sw"]
    with pytest.raises(RuntimeError, match="command count"):
        module.verify_evidence(report, audit)


def test_empty_pixel_and_point_order_inside_square_nexus_footprint_still_fail():
    report, audit = evidence()
    point = [52.25, 47.75]
    report["cases"]["guarded_corner_se"]["order"]["target_world_position"] = point
    command = next(row for row in audit["actions"] if row.get("diagnostic_case") == "guarded_corner_se")
    command["effective_target"] = command["target"] = point
    with pytest.raises(RuntimeError, match="square footprint"):
        module.verify_evidence(report, audit)


def test_corner_requested_target_cannot_be_replaced_with_an_easy_open_ground_case():
    report, audit = evidence()
    report["cases"]["guarded_corner_ne"]["target"] = [60, 60]
    with pytest.raises(RuntimeError, match="specified footprint corner"):
        module.verify_evidence(report, audit)


def test_corner_camera_change_requires_accepted_paid_input():
    report, audit = evidence()
    index = report["cases"]["guarded_corner_ne"]["prepared_camera"]["audit_index"]
    audit["actions"][index]["result"] = [2]
    with pytest.raises(RuntimeError, match="preceding paid input"):
        module.verify_evidence(report, audit)


def test_corner_camera_offsets_must_produce_four_distinct_observed_views():
    report, audit = evidence()
    for row in audit["actions"]:
        if row.get("diagnostic_case") in module.CORNER_DIRECTIONS:
            row["camera"] = [50, 50]
    with pytest.raises(RuntimeError, match="distinct observed camera"):
        module.verify_evidence(report, audit)


@pytest.mark.parametrize("case", module.CORNER_DIRECTIONS)
def test_corner_runner_pays_camera_then_uses_normal_probe_path_on_next_observation(tmp_path, case):
    from test_adapter import Unit
    from test_fairplay import RecordingClient
    probe = module.GroundAttackProbe({"cases": {}, "nexus_footprint_radius": 2.5}, tmp_path, 240,
                                    guarded_only=True)
    probe.state = SimpleNamespace(game_loop=2240)
    probe.game_info = SimpleNamespace(map_size=Point2((200, 200)))
    probe.client = RecordingClient()
    probe.fairplay.camera_center = Point2((50, 50))
    corners = list(module.CORNER_DIRECTIONS)
    if corners.index(case):
        _, probe.fairplay.camera_center = module.corner_geometry(corners[corners.index(case) - 1], (50, 50), 2.5)
    probe.zealot_tag, probe.nexus_tag = 11, 12
    probe.phase = "start_" + case
    own = [Unit(U.ZEALOT, tag=11, position=(51, 50)),
           Unit(U.NEXUS, tag=12, is_structure=True)]
    offered = []

    async def abilities(units, **kwargs):
        assert units == own[:1]
        return [[A.ATTACK_ATTACK]]

    async def normal_probe(bot, source, name, target):
        offered.append((source.tag, name, target))
        return True

    probe.get_available_abilities = abilities
    probe.fairplay.issue_probe = normal_probe
    asyncio.run(probe.start_case(own))
    target, camera = module.corner_geometry(case, (50, 50), 2.5)
    assert not offered and len(probe.client.requests) == 1
    assert probe.fairplay.audit[0]["kind"] == "camera"
    assert probe.fairplay.budget.total == 1
    probe.state.game_loop += 8
    probe.fairplay.camera_center = camera  # Next observed camera, not an inferred movement.
    asyncio.run(probe.start_case(own))
    assert offered == [(11, case, target)] and probe.phase == "observe_case"
    assert probe.report["cases"][case]["prepared_camera"]["audit_index"] == 0
    assert len(probe.client.requests) == 1


@pytest.mark.parametrize("field,value", [
    ("starting_workers", [12, 8]), ("engine_results", ["Tie", "Tie"]),
    ("concession_reason", "verification_timeout"), ("nexus_alive_at_end", False),
    ("max_owned_zealots", 2), ("post_stop_stable_seconds", 1.9),
    ("ppo_updates", 1), ("debug_used", True), ("bot_error", "unexpected engine failure"),
])
def test_invalid_or_incomplete_game_fails_closed(field, value):
    report, audit = evidence()
    report[field] = value
    with pytest.raises(RuntimeError):
        module.verify_evidence(report, audit)


def test_legacy_reproduction_requires_actual_own_nexus_target():
    report, audit = evidence()
    report["cases"]["legacy_nexus"]["order"]["target_unit_tag"] = 99
    with pytest.raises(RuntimeError, match="not reproduced"):
        module.verify_evidence(report, audit)


@pytest.mark.parametrize("case", ["guarded_nexus", "guarded_offscreen"])
def test_accepted_point_ability_that_targeted_unit_is_not_a_pass(case):
    report, audit = evidence()
    report["cases"][case]["order"]["target_unit_tag"] = 12
    with pytest.raises(RuntimeError, match="unit target"):
        module.verify_evidence(report, audit)


def test_accepted_but_nonadvancing_offscreen_point_is_not_a_pass():
    report, audit = evidence()
    report["cases"]["guarded_offscreen"]["distance_advanced"] = 0
    with pytest.raises(RuntimeError, match="did not move"):
        module.verify_evidence(report, audit)


def test_old_precommand_observation_is_not_native_confirmation():
    report, audit = evidence()
    report["cases"]["guarded_nexus"]["observation_loop"] = 1
    with pytest.raises(RuntimeError, match="subsequent source observation"):
        module.verify_evidence(report, audit)


def test_point_must_match_emitted_minimap_destination():
    report, audit = evidence()
    report["cases"]["guarded_nexus"]["order"]["target_world_position"] = [150, 150]
    with pytest.raises(RuntimeError, match="differs from emitted"):
        module.verify_evidence(report, audit)


@pytest.mark.parametrize("layer,value", [("player_relative", 1), ("unit_type", 59),
    ("unit_density", 1), ("visibility_map", 0), ("pathable", 0)])
def test_guarded_attack_requires_current_visible_empty_pathable_pixel(layer, value):
    report, audit = evidence()
    audit["actions"][5]["diagnostic_screen_evidence"][layer] = value
    with pytest.raises(RuntimeError, match="screen pixel evidence"):
        module.verify_evidence(report, audit)


def test_guarded_attack_cannot_use_diagnostic_bypass():
    report, audit = evidence()
    audit["actions"][5]["diagnostic_only_exact_ability"] = True
    with pytest.raises(RuntimeError, match="production empty-screen guard"):
        module.verify_evidence(report, audit)


def test_guarded_attack_cannot_fall_back_to_minimap():
    report, audit = evidence()
    audit["actions"][5]["minimap"] = True
    with pytest.raises(RuntimeError, match="exact diagnostic command"):
        module.verify_evidence(report, audit)


def test_offscreen_waypoint_movement_must_advance_toward_requested_goal():
    report, audit = evidence()
    report["cases"]["guarded_offscreen"]["goal_distance_after"] = 22
    with pytest.raises(RuntimeError, match="did not advance"):
        module.verify_evidence(report, audit)


def test_exact_ability_must_be_sent_not_production_remapping():
    report, audit = evidence()
    audit["actions"][1]["ability"] = 24
    with pytest.raises(RuntimeError, match="exact diagnostic command"):
        module.verify_evidence(report, audit)


def test_stop_claim_requires_accepted_stop_command():
    report, audit = evidence()
    audit["actions"][3]["result"] = [2]
    with pytest.raises(RuntimeError, match="accepted STOP"):
        module.verify_evidence(report, audit)


def test_apm_gate_still_checked_with_complete_native_evidence():
    report, audit = deepcopy(evidence())
    audit["actions"][1]["time"] = audit["actions"][0]["time"]
    with pytest.raises(ValueError, match="spacing"):
        module.verify_evidence(report, audit)


def setup_unit(kind, tag, *, orders=(), idle=True, ready=True, position=(55, 50)):
    return SimpleNamespace(type_id=kind, tag=tag, is_ready=ready, is_idle=idle,
                           position=Point2(position), _proto=raw_pb2.Unit(orders=[
                               raw_pb2.UnitOrder(ability_id=ability) for ability in orders]))


def setup_probe(tmp_path, *, now=31, action="build_gateway", issued=30, source_tag=11):
    probe = module.GroundAttackProbe({}, tmp_path, 540)
    probe.state = SimpleNamespace(game_loop=now * 22.4)
    probe.game_data = SimpleNamespace(abilities={})
    probe.is_visible = lambda point: True
    probe.setup_done.add("build_pylon")
    probe.setup_attempts[action] = 1
    probe.fairplay.audit.append(dict(command_confirmation="accepted"))
    probe.setup_submitted = dict(action=action, audit_index=0, issued=issued, source_tag=source_tag,
        target=None if action == "train_zealot" else [55, 50],
        ability_ids=[916] if action == "train_zealot" else [883])
    return probe


def mock_setup_actions(monkeypatch, probe, available=()):
    selected = []

    async def legal(bot):
        return [name in available for name in ACTION_NAMES]

    async def execute(bot, index):
        selected.append(ACTION_NAMES[index])
        return True

    monkeypatch.setattr(module, "legal_action_mask", legal)
    monkeypatch.setattr(module, "execute_action", execute)
    return selected


def test_accepted_gateway_input_does_not_complete_or_interrupt_pending_builder(tmp_path, monkeypatch):
    probe = setup_probe(tmp_path)
    builder = setup_unit(U.PROBE, 11)
    selected = mock_setup_actions(monkeypatch, probe, ["harvest_minerals"])
    probe._pluto_action_context = {ACTION_TO_INDEX["harvest_minerals"]: SimpleNamespace(sources=[builder])}
    asyncio.run(probe.setup([builder]))
    assert "build_gateway" not in probe.setup_done
    assert probe.setup_submitted is not None
    assert selected == []  # Original v1 sent Gather here, cancelling the build.


def test_travelling_builder_remains_reserved_after_retry_delay(tmp_path, monkeypatch):
    probe = setup_probe(tmp_path, now=55)
    builder = setup_unit(U.PROBE, 11, orders=[883], idle=False)
    selected = mock_setup_actions(monkeypatch, probe, ["harvest_minerals", "build_gateway"])
    asyncio.run(probe.setup([builder]))
    assert probe.setup_submitted is not None
    assert "build_gateway" not in probe.setup_done
    assert selected == []


def test_observed_gateway_starts_release_builder_for_mining(tmp_path, monkeypatch):
    probe = setup_probe(tmp_path)
    builder = setup_unit(U.PROBE, 11)
    gateway = setup_unit(U.GATEWAY, 22, ready=False)
    selected = mock_setup_actions(monkeypatch, probe, ["harvest_minerals"])
    probe._pluto_action_context = {ACTION_TO_INDEX["harvest_minerals"]: SimpleNamespace(sources=[builder])}
    asyncio.run(probe.setup([builder, gateway]))
    assert "build_gateway" in probe.setup_done
    assert probe.setup_submitted is None
    assert probe.report["setup_events"][0]["event"] == "observed_structure"
    assert selected == ["harvest_minerals"]


def test_idle_source_without_gateway_gets_bounded_retry(tmp_path, monkeypatch):
    probe = setup_probe(tmp_path, now=51)
    builder = setup_unit(U.PROBE, 11)
    selected = mock_setup_actions(monkeypatch, probe, ["build_gateway"])
    probe._pluto_action_context = {ACTION_TO_INDEX["build_gateway"]: SimpleNamespace(
        sources=[builder], ability=A.PROTOSSBUILD_GATEWAY, target=Point2((55, 50)))}
    asyncio.run(probe.setup([builder]))
    assert selected == ["build_gateway"]
    assert "build_gateway" not in probe.setup_done
    assert probe.setup_attempts["build_gateway"] == 2
    assert probe.report["setup_events"][0]["event"] == "retry_idle_source_without_product"


def test_unobserved_busy_construction_fails_with_bounded_diagnostic(tmp_path, monkeypatch):
    probe = setup_probe(tmp_path, now=91)
    builder = setup_unit(U.PROBE, 11, orders=[883], idle=False)
    mock_setup_actions(monkeypatch, probe)
    with pytest.raises(RuntimeError, match="within 60 seconds"):
        asyncio.run(probe.setup([builder]))


def test_observed_zealot_queue_prevents_duplicate_training(tmp_path, monkeypatch):
    probe = setup_probe(tmp_path, action="train_zealot", source_tag=22)
    gateway = setup_unit(U.GATEWAY, 22, orders=[916], idle=False)
    selected = mock_setup_actions(monkeypatch, probe, ["train_zealot"])
    asyncio.run(probe.setup([gateway]))
    assert "train_zealot" in probe.setup_done
    assert probe.setup_submitted is None
    assert probe.zealot_queue_seen_at == 31
    assert selected == []


def test_accepted_train_input_without_queue_is_not_completed(tmp_path, monkeypatch):
    probe = setup_probe(tmp_path, action="train_zealot", source_tag=22)
    gateway = setup_unit(U.GATEWAY, 22)
    selected = mock_setup_actions(monkeypatch, probe, ["train_zealot"])
    asyncio.run(probe.setup([gateway]))
    assert "train_zealot" not in probe.setup_done
    assert probe.setup_submitted is not None
    assert selected == []


def test_numpy_point_target_never_uses_ambiguous_point_truth_value(tmp_path, monkeypatch):
    probe = setup_probe(tmp_path, now=51)
    builder = setup_unit(U.PROBE, 11)
    target = Point2((np.float64(55.5), np.float64(50.5)))
    with pytest.raises(TypeError, match="bool"):
        bool(target)  # Exact native placement shape that broke v2.
    selected = mock_setup_actions(monkeypatch, probe, ["build_gateway"])
    probe._pluto_action_context = {ACTION_TO_INDEX["build_gateway"]: SimpleNamespace(
        sources=[builder], ability=A.PROTOSSBUILD_GATEWAY, target=target)}
    asyncio.run(probe.setup([builder]))
    assert selected == ["build_gateway"]
    assert probe.setup_submitted["target"] == [55.5, 50.5]
    assert all(type(value) is float for value in probe.setup_submitted["target"])


@pytest.mark.parametrize("leave_fails", [False, True])
def test_diagnostic_exception_concedes_to_unblock_peer_and_preserves_original(tmp_path, monkeypatch, leave_fails):
    probe = setup_probe(tmp_path)
    calls = []
    probe.save = lambda: None
    probe.fairplay.sync_camera = lambda bot: None

    def broken_observation(bot):
        raise ValueError("original native verification failure")

    async def leave():
        calls.append("leave")
        if leave_fails:
            raise OSError("transport already closed")

    probe.client = SimpleNamespace(leave=leave)
    monkeypatch.setattr(module, "screen_entities", broken_observation)
    with pytest.raises(ValueError, match="original native verification failure"):
        asyncio.run(probe.on_step(0))
    assert calls == ["leave"]
    assert probe.report["concession_reason"] == "diagnostic_error"
    assert probe.report["bot_error"] == "ValueError: original native verification failure"
    if leave_fails:
        assert probe.report["error_concession_failure"] == "OSError: transport already closed"


def stopping_probe(tmp_path, *, now=101, confirmation="source_not_selected"):
    probe = setup_probe(tmp_path, now=now)
    probe.case, probe.zealot_tag = "legacy_nexus", 11
    probe.report["cases"] = {"legacy_nexus": {}}
    probe.phase, probe.stop_index, probe.stop_started = "stopping", 0, 100
    probe.fairplay.audit[0]["command_confirmation"] = confirmation
    probe.fairplay._selection_failures[11] = 108
    return probe


def mock_stop_issue(probe):
    emitted = []

    async def abilities(sources, ignore_resource_requirements=False):
        return [[A.STOP_STOP]]

    async def issue(bot, sources, ability, target):
        emitted.append(dict(tags=[unit.tag for unit in sources], ability=ability, target=target))
        probe.fairplay.audit.append({})
        return True

    probe.get_available_abilities = abilities
    probe.fairplay.issue = issue
    return emitted


def test_rejected_stop_selection_waits_for_normal_source_cooldown(tmp_path):
    probe = stopping_probe(tmp_path)
    source = setup_unit(U.ZEALOT, 11, orders=[23], idle=False)
    emitted = mock_stop_issue(probe)
    assert asyncio.run(probe.confirm_stop([source])) is False
    assert emitted == []
    assert probe.stop_index is None
    assert probe.report["cases"]["legacy_nexus"]["stop_retries"][0]["confirmation"] == "source_not_selected"
    assert probe.fairplay._selection_failures[11] == 108


def test_rejected_stop_retries_observed_zealot_after_cooldown(tmp_path):
    probe = stopping_probe(tmp_path, now=109)
    source = setup_unit(U.ZEALOT, 11, orders=[23], idle=False)
    emitted = mock_stop_issue(probe)
    assert asyncio.run(probe.confirm_stop([source])) is False
    assert emitted == [dict(tags=[11], ability=A.STOP_STOP, target=None)]
    assert probe.stop_index == 1
    assert probe.report["cases"]["legacy_nexus"]["stop_selection_audit_index"] == 1


def test_stop_retry_still_respects_action_budget(tmp_path):
    probe = stopping_probe(tmp_path, now=109)
    source = setup_unit(U.ZEALOT, 11, orders=[23], idle=False)
    assert probe.fairplay.budget.consume(108.9)
    emitted = mock_stop_issue(probe)
    assert asyncio.run(probe.confirm_stop([source])) is False
    assert emitted == []
    assert probe.fairplay.budget.total == 1


def test_stop_retry_does_not_recover_source_from_unseen_state(tmp_path):
    probe = stopping_probe(tmp_path, now=109)
    emitted = mock_stop_issue(probe)
    assert asyncio.run(probe.confirm_stop([])) is False
    assert emitted == []
    assert probe.report["cases"]["legacy_nexus"]["stop_status"] == "waiting_for_current_screen_source"


def test_stop_retry_deadline_is_ten_game_seconds(tmp_path):
    probe = stopping_probe(tmp_path, now=110)
    source = setup_unit(U.ZEALOT, 11, orders=[23], idle=False)
    emitted = mock_stop_issue(probe)
    with pytest.raises(RuntimeError, match="within 10 game seconds"):
        asyncio.run(probe.confirm_stop([source]))
    assert emitted == []


def test_retry_requires_observed_cleared_order_before_confirming_stop(tmp_path):
    probe = stopping_probe(tmp_path, now=109, confirmation="accepted")
    source = setup_unit(U.ZEALOT, 11)
    emitted = mock_stop_issue(probe)
    assert asyncio.run(probe.confirm_stop([source])) is True
    assert emitted == []
    assert probe.report["cases"]["legacy_nexus"]["stop_status"] == "confirmed"
