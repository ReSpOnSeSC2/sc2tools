import asyncio

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.runner import validate_action_audit
from test_coach_bot import Unit, cohort_world, known_base, order, world
from test_fairplay import RecordingClient


def failure(bot, sources, target=(138.7343801362831, 118.19959143132402)):
    return {"kind": "selection", "ability": 23, "source_tags": [unit.tag for unit in sources],
            "camera": list(bot.fairplay.camera_center), "target_kind": "ground",
            "intended_target": list(target), "command_confirmation": "no_clear_visible_screen_ground"}


def blocked_army(tmp_path):
    bot = world(tmp_path)
    bot.state.game_loop = 10080  #450 game seconds: the native failing defense interval.
    bot.fairplay.camera_center = Point2((145.3125, 142.1875))
    own = [Unit(U.ZEALOT, tag=7, position=(136.31494140625, 137.970703125), can_attack=True),
           Unit(U.ZEALOT, tag=8, position=(138.52978515625, 138.478515625), can_attack=True)]
    bot._queue_ground_camera_recovery(failure(bot, own), 12, "defend", own)
    return bot, own


def test_confirmed_rejection_queues_recovery_but_is_not_an_accepted_army_dispatch(tmp_path):
    bot = world(tmp_path)
    own = [Unit(U.STALKER, tag=7, can_attack=True)]
    event = failure(bot, own, target=(80, 50))
    bot.fairplay.audit.append(event)
    bot._selected_actions[0] = {"name": "defend", "position": [80, 50], "revision": 1,
                               "defense_alert_base_tag": 99}
    bot._confirm_commands(own)
    request = bot._ground_camera_recovery
    assert request["source_tags"] == [7] and request["intended_target"] == [80, 50]
    assert request["selection_audit_index"] == 0
    assert not bot._defense_dispatched and not bot.client.requests
    assert bot._last_defense_dispatch == -100
    assert not bot._ground_source_retry_allowed(own[0])


def test_partial_selection_recovers_only_the_currently_selected_requested_sources(tmp_path):
    bot = world(tmp_path)
    own = [Unit(U.STALKER, tag=7, can_attack=True),
           Unit(U.STALKER, tag=8, position=(53, 50), can_attack=True)]
    event = failure(bot, own, target=(80, 50))
    event["selected_tags"] = [7]
    bot._queue_ground_camera_recovery(event, 1, "defend", own)
    assert bot._ground_camera_recovery["source_tags"] == [7]
    assert not bot._ground_source_retry_allowed(own[0])
    assert bot._ground_source_retry_allowed(own[1])


def test_recovery_pays_camera_from_current_centroid_and_waits_for_actual_camera_observation(tmp_path):
    bot, own = blocked_army(tmp_path)
    original = bot.fairplay.camera_center
    # Current positions change after the rejected selection; recovery must not
    # use stale event/source coordinates or global unit collections.
    own[0].position = own[0].position.offset((.5, .2))
    center = Point2(tuple(sum(unit.position[i] for unit in own) / 2 for i in range(2)))
    target = center.towards(Point2(bot._ground_camera_recovery["intended_target"]), 2)
    bot.units = bot.enemy_units = None
    assert asyncio.run(bot._ground_camera_recovery_step(own))
    assert bot.fairplay.camera_center == original  # Sending a camera input is not observing its arrival.
    assert not bot._ground_source_retry_allowed(own[0])
    event = bot._ground_recovery_events[-1]
    assert event["status"] == "camera_accepted"
    assert event["camera_target"] == list(target)
    assert event["observed_centroid"] == list(center)
    assert bot.fairplay.audit[-1]["kind"] == "camera"
    assert all(not action.HasField("action_raw") for request in bot.client.requests for action in request.actions)
    assert validate_action_audit({"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})["valid"]
    bot.state.observation_raw.player.camera.x, bot.state.observation_raw.player.camera.y = target
    bot.fairplay.sync_camera(bot)
    assert bot._ground_source_retry_allowed(own[0])
    assert bot._army_attention_until == bot.time + 3


def test_recovery_does_not_override_input_spacing_or_pending_selection(tmp_path):
    bot, own = blocked_army(tmp_path)
    assert bot.fairplay.budget.consume(bot.time - .1)
    assert not asyncio.run(bot._ground_camera_recovery_step(own))
    assert not bot.client.requests and bot._ground_camera_recovery is not None
    bot.state.game_loop += 8
    assert asyncio.run(bot._ground_camera_recovery_step(own))
    assert len(bot.client.requests) == 1


def test_recent_recovery_defers_new_request_until_cadence_without_resampling_bad_view(tmp_path):
    bot, own = blocked_army(tmp_path)
    bot._last_ground_recovery = bot.time - 1
    assert not asyncio.run(bot._ground_camera_recovery_step(own))
    assert bot._ground_camera_recovery is not None and not bot.client.requests
    assert not bot._ground_source_retry_allowed(own[0])


def test_expired_request_does_not_move_camera_and_retry_block_expires(tmp_path):
    bot, own = blocked_army(tmp_path)
    bot.state.game_loop += 135
    assert not asyncio.run(bot._ground_camera_recovery_step(own))
    assert bot._ground_camera_recovery is None and not bot.client.requests
    assert bot._ground_recovery_events[-1]["status"] == "expired"
    assert bot._ground_source_retry_allowed(own[0])


def test_recovery_never_reads_position_of_source_that_left_the_current_screen(tmp_path):
    bot, _ = blocked_army(tmp_path)

    class Hidden:
        tag = 7
        is_on_screen = False

        @property
        def position(self):
            pytest.fail("Cannot recover camera using hidden own coordinates")

    assert not asyncio.run(bot._ground_camera_recovery_step([Hidden()]))
    assert not bot.client.requests
    assert bot._ground_recovery_events[-1]["status"] == "source_not_currently_visible"


@pytest.mark.parametrize("name,target_kind", [("build_pylon", "ground"), ("defend", "unit"),
                                            ("harvest_minerals", "ground")])
def test_non_army_or_non_ground_failures_do_not_schedule_camera_recovery(tmp_path, name, target_kind):
    bot = world(tmp_path)
    own = [Unit(U.STALKER, tag=7, can_attack=True)]
    event = failure(bot, own)
    event["target_kind"] = target_kind
    bot._queue_ground_camera_recovery(event, 1, name, own)
    assert bot._ground_camera_recovery is None and not bot._ground_recovery_blocks


def test_defense_does_not_repeat_rejected_selection_at_same_camera(tmp_path):
    bot = world(tmp_path)
    own = [Unit(U.STALKER, tag=7, can_attack=True)]
    bot.memory.own[99] = known_base((80, 50))
    bot._defense_alert = {"base_tag": 99, "position": [80, 50], "last_seen_seconds": bot.time}
    bot._queue_ground_camera_recovery(failure(bot, own, (72, 50)), 1, "defend", own)
    bot.game_data.abilities[A.ATTACK_ATTACK.value] = type("Ability", (), {"id": A.ATTACK_ATTACK})()

    async def available(units, **kwargs):
        return [[A.ATTACK_ATTACK] for _ in units]

    bot.get_available_abilities = available
    assert not asyncio.run(bot._defense_step(own, order()))
    assert not bot.client.requests and bot.fairplay.pending is False


def test_cohort_does_not_repeat_rejected_selection_at_same_camera(tmp_path):
    bot, own = cohort_world(tmp_path)
    own.append(Unit(U.STALKER, tag=7, position=(50, 50), can_attack=True))
    bot.cohesion.update([], 12, (58, 50), (150, 50), bot.time)
    bot._queue_ground_camera_recovery(failure(bot, own[-1:], (58, 50)), 1, "cohort_assemble", own)
    assert not asyncio.run(bot._cohesion_step(own, order(stance="attack")))
    assert not bot.client.requests and not bot.fairplay.pending


def test_recovery_is_serviced_before_defense_and_macro_retry_in_normal_step(tmp_path):
    bot = world(tmp_path)
    calls = []

    async def recover(own):
        calls.append("recovery")
        return True

    async def forbidden(*args):
        pytest.fail("A paid recovery camera input must finish this step")

    bot._ground_camera_recovery_step = recover
    bot._defense_step = bot._expansion_step = forbidden
    asyncio.run(bot._step(0))
    assert calls == ["recovery"]


def test_combat_camera_lease_defers_recovery_without_discarding_request(tmp_path):
    bot, own = blocked_army(tmp_path)
    bot._combat_camera_until = bot.time + 2
    assert not asyncio.run(bot._ground_camera_recovery_step(own))
    assert bot._ground_camera_recovery is not None and not bot.client.requests
    assert not bot._ground_recovery_events


def test_rejected_paid_recovery_consumes_step_without_claiming_camera_arrival(tmp_path):
    bot, own = blocked_army(tmp_path)
    bot.client = RecordingClient(results=(2,))
    assert asyncio.run(bot._ground_camera_recovery_step(own))
    assert bot.fairplay.audit[-1]["result"] == [2]
    assert bot._ground_recovery_events[-1]["status"] == "camera_rejected"
    assert not bot.action_counts["camera_recover_ground_target"]
    assert bot._ground_camera_recovery is None
