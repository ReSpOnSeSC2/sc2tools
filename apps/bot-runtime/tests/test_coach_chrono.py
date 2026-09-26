from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.unit import Unit as SC2Unit
from s2clientprotocol import raw_pb2 as raw

from pluto_sc2.coach_chrono import CoachChrono


def unit(kind=U.NEXUS, tag=1, *, queue=(), **changes):
    fields = dict(type_id=kind, tag=tag, is_mine=True, is_on_screen=True, is_visible=True,
        is_snapshot=False, is_hallucination=False,
        orders=[NS(ability=NS(id=ability), progress=progress) for ability, progress in queue])
    fields.update(changes)
    return NS(**fields)


def nexus(tag=1, progress=.1, **changes):
    return unit(tag=tag, queue=[(A.NEXUSTRAIN_PROBE, progress)], **changes)


def gateway(tag=2, progress=.1, **changes):
    return unit(U.GATEWAY, tag, queue=[(A.GATEWAYTRAIN_STALKER, progress)], **changes)


def after_first_chrono():
    planner = CoachChrono(enabled=True)
    planner.observe([nexus()], 5)
    assert planner.decision(40, 5)["allowed"]
    assert planner.record_command("chrono_boost", True, 5.5, audit_index=1, source_tags=[1])
    return planner


def test_default_disabled_gate_preserves_ordinary_chrono_and_targets():
    decision = CoachChrono().decision(0, 0)
    assert decision["allowed"] and decision["phase"] == "ordinary" and decision["target_tags"] is None


def test_starting_probes_and_large_bank_do_not_prove_first_probe_order():
    planner = CoachChrono(enabled=True)
    planner.observe([unit(U.PROBE, tag=i + 1) for i in range(8)], 0)
    assert planner.decision(500, 0)["reason"] == "wait_for_first_probe_order"


@pytest.mark.parametrize("minerals,allowed", [(0, False), (39, False), (39.99, False), (40, True), (500, True)])
def test_first_chrono_requires_current_40_minerals_after_probe_order(minerals, allowed):
    planner = CoachChrono(enabled=True)
    assert planner.record_command("train_probe", True, 1, audit_index=0, source_tags=[1])
    planner.observe([nexus()], 5)
    decision = planner.decision(minerals, 5)
    assert decision["allowed"] is allowed
    assert decision["target_tags"] == [1] and decision["phase"] == "first_chrono"


def test_observed_probe_queue_can_prove_order_even_without_recorded_command():
    planner = CoachChrono(enabled=True)
    planner.observe([nexus(progress=0)], 3)
    assert planner.first_probe_order["source"] == "observed_current_probe_queue"
    assert planner.decision(40, 3)["allowed"]


def test_bank_requirement_is_current_not_a_persistent_40_mineral_latch():
    planner = CoachChrono(enabled=True)
    planner.observe([nexus()], 3)
    assert planner.decision(40, 3)["allowed"]
    planner.observe([nexus()], 4)
    assert not planner.decision(35, 4)["allowed"]


@pytest.mark.parametrize("minerals", [None, True, -1, float("nan"), float("inf")])
def test_invalid_or_negative_current_bank_cannot_authorize_first_chrono(minerals):
    planner = CoachChrono(enabled=True)
    planner.observe([nexus()], 3)
    assert not planner.decision(minerals, 3)["allowed"]


def test_first_accepted_probe_order_without_current_producing_nexus_waits_for_target():
    planner = CoachChrono(enabled=True)
    planner.record_command("train_probe", True, 1, audit_index=0, source_tags=[1])
    planner.observe([unit()], 5)
    decision = planner.decision(40, 5)
    assert not decision["allowed"] and decision["target_tags"] == []
    assert decision["reason"] == "wait_for_current_visible_probe_producing_nexus"


def test_rejected_probe_command_and_attempt_counter_cannot_unlock_first_chrono():
    planner = CoachChrono(enabled=True)
    assert not planner.record_command("train_probe", False, 1, audit_index=0)
    assert planner.first_probe_order is None and not planner.decision(500, 2)["allowed"]


def test_selection_alone_is_not_a_chrono_receipt_or_a_stage_change():
    planner = CoachChrono(enabled=True)
    planner.observe([nexus()], 5)
    assert planner.decision(40, 5)["allowed"]
    assert planner.accepted_chronos == 0
    assert not planner.record_command("selection", True, 5, audit_index=0, source_tags=[1])
    assert planner.accepted_chronos == 0


def test_rejected_and_duplicate_chrono_receipts_never_increment_twice():
    planner = CoachChrono(enabled=True)
    assert not planner.record_command("chrono_boost", False, 1, audit_index=0)
    assert planner.accepted_chronos == 0
    assert not planner.record_command("chrono_boost", True, 1, audit_index=0, source_tags=[1])
    assert planner.record_command("chrono_boost", True, 2, audit_index=1, source_tags=[1])
    assert not planner.record_command("chrono_boost", True, 2, audit_index=1, source_tags=[1])
    assert planner.accepted_chronos == 1


def test_accepted_stalker_order_alone_does_not_prove_production_started():
    planner = after_first_chrono()
    planner.record_command("train_stalker", True, 6, audit_index=3, source_tags=[2])
    planner.observe([nexus()], 7)
    decision = planner.decision(500, 7)
    assert decision["phase"] == "second_chrono" and not decision["allowed"]
    assert decision["reason"] == "wait_for_first_stalker_production_start"
    assert planner.first_stalker_order and planner.first_stalker_start is None


@pytest.mark.parametrize("progress,allowed", [(0, False), (.0001, True), (.5, True), (1, True),
    (-.1, False), (1.1, False), (None, False), (float("nan"), False)])
def test_second_chrono_targets_actual_started_stalker_production(progress, allowed):
    planner = after_first_chrono()
    planner.observe([nexus(), gateway(progress=progress)], 6)
    decision = planner.decision(0, 6)
    assert decision["allowed"] is allowed
    assert decision["target_tags"] == ([2] if allowed else [])
    assert decision["phase"] == "second_chrono"


def test_stalker_waiting_behind_zealot_does_not_unlock_second_chrono():
    planner = after_first_chrono()
    producer = unit(U.GATEWAY, 2, queue=[(A.GATEWAYTRAIN_ZEALOT, .6), (A.GATEWAYTRAIN_STALKER, 0)])
    planner.observe([producer], 6)
    assert not planner.decision(500, 6)["allowed"]
    assert planner.first_stalker_start is None


def test_visible_completed_stalker_remembers_start_but_cannot_boost_idle_nexus_instead():
    planner = after_first_chrono()
    planner.observe([unit(U.STALKER, 10), nexus()], 6)
    decision = planner.decision(500, 6)
    assert planner.first_stalker_start["source"] == "observed_current_stalker"
    assert not decision["allowed"] and decision["target_tags"] == []
    assert decision["reason"] == "wait_for_current_visible_stalker_producer"
    planner.observe([gateway()], 7)
    assert planner.decision(0, 7)["target_tags"] == [2]


@pytest.mark.parametrize("change", [{"is_on_screen": False}, {"is_visible": False},
    {"is_snapshot": True}, {"is_mine": False}, {"is_hallucination": True}])
def test_hidden_enemy_snapshot_or_hallucinated_production_does_not_unlock_gates(change):
    planner = CoachChrono(enabled=True)
    planner.observe([nexus(**change), gateway(**change), unit(U.STALKER, 10, **change)], 1)
    assert planner.first_probe_order is None and planner.first_stalker_start is None
    assert not planner.decision(500, 1)["allowed"]


def test_hidden_orders_are_never_accessed():
    class Hidden:
        is_on_screen = False

        @property
        def orders(self):
            raise AssertionError("Hidden production inspected")

        @property
        def type_id(self):
            raise AssertionError("Hidden type inspected")

    planner = CoachChrono(enabled=True)
    planner.observe([Hidden()], 1)
    assert planner.first_probe_order is None


def test_target_tags_expire_at_next_frame_until_fresh_observation():
    planner = after_first_chrono()
    planner.observe([gateway()], 6)
    assert planner.decision(0, 6)["allowed"]
    assert not planner.decision(0, 7)["allowed"]
    planner.observe([gateway()], 7)
    assert planner.decision(0, 7)["allowed"]
    planner.observe([], 8)
    assert planner.first_stalker_start is not None
    assert planner.decision(0, 8)["target_tags"] == []


def test_first_and_second_target_sets_are_sorted_and_specific_to_current_unit_production():
    planner = CoachChrono(enabled=True)
    planner.observe([nexus(8), gateway(2), nexus(1)], 5)
    assert planner.decision(40, 5)["target_tags"] == [1, 8]
    planner.record_command("chrono_boost", True, 5, audit_index=1, source_tags=[1])
    assert planner.decision(0, 5)["target_tags"] == [2]


def test_third_and_later_chronos_restore_ordinary_target_and_timing_logic():
    planner = after_first_chrono()
    planner.observe([gateway()], 6)
    assert planner.decision(0, 6)["allowed"]
    planner.record_command("chrono_boost", True, 6.5, audit_index=4, source_tags=[1])
    planner.observe([], 7)
    decision = planner.decision(0, 7)
    assert decision["allowed"] and decision["phase"] == "ordinary" and decision["target_tags"] is None
    planner.record_command("chrono_boost", True, 8, audit_index=8, source_tags=[1])
    assert planner.accepted_chronos == 3 and planner.decision(0, 8)["allowed"]


def test_wrong_producer_kind_cannot_claim_probe_or_stalker_production():
    planner = CoachChrono(enabled=True)
    planner.observe([unit(U.GATEWAY, 1, queue=[(A.NEXUSTRAIN_PROBE, .1)]),
                     unit(U.NEXUS, 2, queue=[(A.GATEWAYTRAIN_STALKER, .1)])], 1)
    assert planner.first_probe_order is None and planner.first_stalker_start is None


def test_native_reserved_order_4135_uses_raw_queue_without_unsafe_burnysc2_decode():
    bot = NS(state=NS(game_loop=22), game_data=NS(abilities={}))
    producer = SC2Unit(raw.Unit(tag=1, unit_type=U.NEXUS.value, alliance=1, display_type=1,
        is_on_screen=True, orders=[raw.UnitOrder(ability_id=4135),
                                  raw.UnitOrder(ability_id=A.NEXUSTRAIN_PROBE.value, progress=.1)]),
        bot, base_build=99999)
    with pytest.raises(KeyError, match="4135"):
        _ = producer.orders
    planner = CoachChrono(enabled=True)
    planner.observe([producer], 1)
    assert planner.first_probe_order is not None  # An actually observed queued Probe was ordered.
    assert not planner.decision(40, 1)["allowed"]  # Unknown front item is not current Probe production.


def test_unknown_front_order_cannot_claim_stalker_started():
    bot = NS(state=NS(game_loop=22), game_data=NS(abilities={}))
    producer = SC2Unit(raw.Unit(tag=2, unit_type=U.GATEWAY.value, alliance=1, display_type=1,
        is_on_screen=True, orders=[raw.UnitOrder(ability_id=4135),
                                  raw.UnitOrder(ability_id=A.GATEWAYTRAIN_STALKER.value, progress=.5)]),
        bot, base_build=99999)
    planner = after_first_chrono()
    planner.observe([producer], 6)
    assert planner.first_stalker_start is None and not planner.decision(0, 6)["allowed"]


@pytest.mark.parametrize("tags", [[], [1, 2], [True], [0]])
def test_actual_single_source_receipt_is_required(tags):
    planner = CoachChrono(enabled=True)
    with pytest.raises(ValueError):
        planner.record_command("chrono_boost", True, 1, audit_index=0, source_tags=tags)
    assert planner.accepted_chronos == 0


@pytest.mark.parametrize("now", [float("nan"), -1, True])
def test_invalid_time_is_rejected(now):
    with pytest.raises(ValueError):
        CoachChrono().decision(40, now)


def test_backward_clock_is_rejected():
    planner = CoachChrono()
    planner.observe([], 5)
    with pytest.raises(ValueError):
        planner.decision(40, 4)
