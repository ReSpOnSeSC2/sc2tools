import asyncio
from types import SimpleNamespace as NS

import numpy as np
import pytest
from s2clientprotocol import common_pb2 as common, raw_pb2 as raw
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.production_attention import ProductionAttention
from pluto_sc2.runner import validate_action_audit
from pluto_sc2.sc2_adapter import NeuralBot, legal_action_mask, screen_entities
from pluto_sc2.schema import ACTION_NAMES, ACTION_TO_INDEX, BASE_OBSERVATION_SIZE
from test_adapter import Unit, scene
from test_fairplay import RecordingClient


def nexus(tag=1, position=(50, 50), **changes):
    return Unit(U.NEXUS, tag=tag, position=position, is_structure=True, is_mine=True,
                abilities=[A.NEXUSTRAIN_PROBE], **changes)


def see(helper, bot, now, own=(), enemies=(), camera=(50, 50), visible=True):
    bot.time = now
    bot.fairplay.camera_center = Point2(camera)
    bot.is_visible = lambda _: visible
    helper.observe(bot, list(own), list(enemies))


@pytest.mark.parametrize("visible,limit,reason", [(True, 15, "production_away_timeout"),
                                                (False, 8, "empty_fog_timeout")])
def test_only_observed_production_anchors_can_trigger_return_after_bounded_timeout(visible, limit, reason):
    helper, bot = ProductionAttention(), scene()
    see(helper, bot, 0, [nexus()])
    see(helper, bot, 1, camera=(150, 150), visible=visible)
    assert helper.request(limit + .99) is None
    request = helper.request(1 + limit)
    assert request["reason"] == reason and request["target"] == [50, 50]
    assert request["anchor_last_seen"] == 0
    assert helper.pending is None and not bot.fairplay.audit


def test_empty_unknown_map_has_no_invented_home_production_anchor():
    helper, bot = ProductionAttention(), scene()
    see(helper, bot, 0, camera=(150, 150), visible=False)
    see(helper, bot, 50, camera=(150, 150), visible=False)
    assert helper.request(50) is None and not helper.anchors


def test_return_does_not_start_upkeep_until_production_is_actually_observed():
    helper, bot = ProductionAttention(), scene()
    see(helper, bot, 0, [nexus()])
    see(helper, bot, 1, camera=(150, 150), visible=False)
    request = helper.request(9)
    helper.attempted(request, 9, True, 0)
    assert helper.upkeep_until == 0
    see(helper, bot, 9.5, [nexus()])
    assert helper.upkeep_until == 13.5 and helper.pending is None
    assert helper.events[-1]["arrival"] == "production_observed"


def test_fogged_failed_return_is_unverified_not_destroyed_and_not_revisited():
    helper, bot = ProductionAttention(), scene()
    see(helper, bot, 0, [nexus()])
    see(helper, bot, 1, camera=(150, 150), visible=False)
    helper.attempted(helper.request(9), 9, True, 0)
    see(helper, bot, 9.5, camera=(50, 50), visible=False)
    assert 1 in helper.anchors and 1 in helper.unverified
    assert helper.request(20) is None and helper.upkeep_until == 0
    see(helper, bot, 21, [nexus()])
    assert 1 not in helper.unverified
    see(helper, bot, 22, camera=(150, 150), visible=False)
    assert helper.request(30) is not None


def test_observed_absent_anchor_is_removed_without_querying_offscreen_memory():
    helper, bot = ProductionAttention(), scene()
    see(helper, bot, 0, [nexus()])
    bot.time = 1
    bot.fairplay.camera_center = Point2((150, 150))

    def only_current(point):
        assert bot.fairplay.on_screen(point)
        return True

    bot.is_visible = only_current
    helper.observe(bot, [], [])
    assert 1 in helper.anchors
    bot.time = 2
    bot.fairplay.camera_center = Point2((50, 50))
    helper.observe(bot, [], [])
    assert 1 not in helper.anchors


def test_upkeep_mask_preserves_noop_production_and_original_mask_then_expires():
    helper = ProductionAttention()
    helper.production_visible, helper.upkeep_until = True, 10
    original = np.ones(len(ACTION_NAMES), dtype=bool)
    constrained = helper.restrict_mask(original, 9)
    assert original.all() and constrained is not original
    assert constrained[ACTION_TO_INDEX["no_op"]] and constrained[ACTION_TO_INDEX["train_probe"]]
    assert not constrained[ACTION_TO_INDEX["scout"]]
    assert not any(constrained[index] for index, name in enumerate(ACTION_NAMES) if name.startswith("camera_"))
    assert helper.restrict_mask(original, 10) is original


class Policy:
    def __init__(self):
        self.masks = []

    def act(self, observation, mask, **kwargs):
        self.masks.append(mask.copy())
        return ACTION_TO_INDEX["no_op"], -.25, .75

    def value(self, observation):
        return .75


def neural(monkeypatch):
    bot = NeuralBot(Policy())
    bot.state = NS(game_loop=0, upgrades=set(), observation_raw=raw.ObservationRaw(
        player=raw.PlayerRaw(camera=common.Point(x=50, y=50))))
    bot.game_info = NS(player_start_location=Point2((50, 50)), start_locations=[Point2((150, 150))],
                       map_size=Point2((200, 200)), map_center=Point2((100, 100)),
                       playable_area=NS(x=0, y=0, width=200, height=200))
    bot.game_data = NS(units={}, abilities={})
    bot.units = [Unit(U.PROBE, tag=2, position=(52, 50), is_mine=True, abilities=[A.MOVE_MOVE])]
    bot.structures, bot.enemy_units, bot.enemy_structures = [nexus()], [], []
    bot.mineral_field, bot.vespene_geyser = [], []
    bot.supply_workers, bot.supply_army = 8, 0
    bot.supply_used, bot.supply_cap, bot.supply_left = 8, 15, 7
    bot.minerals, bot.vespene = 50, 0
    bot.can_afford = lambda kind: kind == U.PROBE
    bot.can_feed = lambda _: True
    bot.is_visible = lambda _: True
    bot.client = RecordingClient()

    async def abilities(units, **kwargs):
        return [getattr(unit, "abilities", []) for unit in units]

    bot.get_available_abilities = abilities
    monkeypatch.setattr("pluto_sc2.sc2_adapter.encode_observation", lambda _: np.zeros(BASE_OBSERVATION_SIZE))
    return bot


def tick(bot, seconds, camera=(50, 50), visible=True):
    bot.state.game_loop = round(seconds * 22.4)
    bot.state.observation_raw.player.camera.x, bot.state.observation_raw.player.camera.y = camera
    bot.is_visible = lambda _: visible
    asyncio.run(bot._step(bot.state.game_loop))


def test_paid_camera_return_preserves_pending_transition_without_fabricated_policy_action(monkeypatch):
    bot = neural(monkeypatch)
    tick(bot, 0)
    tick(bot, 1, (150, 150))
    pending = bot._pending_transition
    count, decisions = len(bot.transitions), len(bot.policy.masks)
    tick(bot, 16, (150, 150))
    assert bot._pending_transition is pending and len(bot.transitions) == count
    assert len(bot.policy.masks) == decisions
    assert bot.action_counts == {"no_op": 2}
    command = bot.client.requests[-1].actions[0]
    assert command.HasField("action_feature_layer") and not command.HasField("action_raw")
    assert command.action_feature_layer.HasField("camera_move")
    event = bot.fairplay.audit[-1]
    assert event["kind"] == "camera" and event["input_origin"] == "production_attention"
    assert event["policy_sample"] is False and event["result"] == [1]
    summary = bot.control_summary
    assert summary["ground_attack"] == "current-visible-empty-screen-attack23-v1"
    assert summary["production_attention"]["counts"]["accepted_returns"] == 1
    assert validate_action_audit({"summary": bot.fairplay.summary(), "actions": bot.fairplay.audit})["valid"]


def test_return_wait_respects_input_spacing_and_stores_exact_upkeep_policy_mask(monkeypatch):
    bot = neural(monkeypatch)
    tick(bot, 0)
    tick(bot, 1, (150, 150), False)
    tick(bot, 9, (150, 150), False)
    pending, count = bot._pending_transition, len(bot.policy.masks)
    tick(bot, 9.1)  # Production observed, but 0.3-second input spacing still applies.
    assert len(bot.client.requests) == 1 and len(bot.policy.masks) == count
    assert bot._pending_transition is pending
    tick(bot, 9.5)
    assert len(bot.policy.masks) == count + 1
    used_mask = bot.policy.masks[-1]
    assert used_mask[ACTION_TO_INDEX["train_probe"]]
    assert not used_mask[ACTION_TO_INDEX["scout"]] and not used_mask[ACTION_TO_INDEX["camera_enemy_start"]]
    np.testing.assert_array_equal(bot._pending_transition[1], used_mask)
    np.testing.assert_array_equal(bot.transitions[-1].mask, pending[1])
    # The unconstrained current legality remains separate; no implementation
    # silently edits legal inputs or stores the original mask in PPO instead.
    actual_legal = asyncio.run(legal_action_mask(bot))
    assert actual_legal[ACTION_TO_INDEX["camera_enemy_start"]] and actual_legal[ACTION_TO_INDEX["scout"]]
    tick(bot, 13.5)
    assert bot.policy.masks[-1][ACTION_TO_INDEX["camera_enemy_start"]]


def test_rejected_camera_input_is_audited_and_never_becomes_a_policy_sample(monkeypatch):
    bot = neural(monkeypatch)
    tick(bot, 0)
    tick(bot, 1, (150, 150), False)
    bot.client.results = (2,)
    pending, count = bot._pending_transition, len(bot.policy.masks)
    tick(bot, 9, (150, 150), False)
    assert bot._pending_transition is pending and len(bot.policy.masks) == count
    assert bot.fairplay.audit[-1]["result"] == [2]
    assert bot._production_attention.pending is None
    assert bot._production_attention.counts["rejected_returns"] == 1
    tick(bot, 9.5, (150, 150), False)
    assert len(bot.client.requests) == 1  # Three-second retry cadence.


def test_attention_observes_current_frame_once_and_waits_for_pending_spatial_input(monkeypatch):
    bot = neural(monkeypatch)
    tick(bot, 0)
    tick(bot, 1, (150, 150), False)
    calls = []
    real = bot._production_attention.observe

    def observed(*args):
        calls.append(bot.state.game_loop)
        return real(*args)

    async def pending(_):
        return True

    bot._production_attention.observe = observed
    bot.fairplay.advance = pending
    old = bot._pending_transition
    tick(bot, 9, (150, 150), False)
    tick(bot, 9, (150, 150), False)
    assert len(calls) == 1 and not bot.client.requests
    assert bot._pending_transition is old


def test_attention_receives_only_current_screen_entities(monkeypatch):
    bot = neural(monkeypatch)

    class Offscreen:
        tag = 90
        is_on_screen = False

        @property
        def position(self):
            pytest.fail("Hidden own coordinates cannot guide production attention")

    bot.structures.append(Offscreen())
    tick(bot, 0)
    assert set(bot._production_attention.anchors) == {1}
    assert len(screen_entities(bot)[0]) == 2


def test_coach_does_not_activate_neural_camera_guidance(tmp_path):
    from pluto_sc2.coach_bot import CoachBot
    bot = CoachBot(tmp_path, "attention-independence", speed=50)
    assert type(bot)._step is not NeuralBot._step
    assert bot._production_attention is None
    assert bot.control_summary["production_attention"] is None
