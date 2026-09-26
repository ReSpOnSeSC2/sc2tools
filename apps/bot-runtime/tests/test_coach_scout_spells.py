import asyncio
from collections import Counter
from types import SimpleNamespace as NS

import pytest
from sc2.ids.ability_id import AbilityId as A
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.coach_scout_spells import CoachScoutSpells


def unit(kind, tag, point=(50, 50), **kwargs):
    values = dict(type_id=kind, tag=tag, position=Point2(point), is_ready=True,
                  is_mine=True, is_visible=True, is_snapshot=False, is_hallucination=False,
                  energy=75, energy_max=200, can_attack=False)
    return NS(**(values | kwargs))


class Bot:
    def __init__(self, available=None):
        self.time = 200
        self.available = available or {}
        self.queries = []
        self.issues = []
        self.selections = []
        self.action_counts = Counter()
        self.game_data = NS(abilities={})
        self.enemy_start_locations = [Point2((150, 150))]
        self.allow_selection = True
        self.fairplay = NS(on_screen=lambda u: u.position.x < 100,
                           source_available=lambda *_: True, issue=self.issue)

    async def get_available_abilities(self, sources, **kwargs):
        assert kwargs == {"ignore_resource_requirements": False}
        self.queries.append([u.tag for u in sources])
        return [self.available.get(u.tag, []) for u in sources]

    async def issue(self, bot, sources, ability, target, **kwargs):
        self.issues.append((sources, ability, target, kwargs))
        return self.allow_selection

    def _record_selection(self, name, target):
        self.selections.append((name, target))


def step(controller, bot, own, enemies=(), order=None):
    return asyncio.run(controller.step(bot, own, enemies, order or NS(scout=True, stance="defend")))


def cast(controller, bot, sentry, existing=()):
    bot.available[sentry.tag] = [A.HALLUCINATION_PHOENIX]
    assert step(controller, bot, [sentry, *existing])
    assert bot.selections[-1][0] == "scout_hallucinate_phoenix"
    controller.confirm("scout_hallucinate_phoenix", True, bot.time, [sentry.tag])


def test_recharge_then_confirmed_cast_then_observed_phoenix_dispatch():
    sentry, nexus = unit(U.SENTRY, 1), unit(U.NEXUS, 2, (55, 50))
    bot = Bot({1: [A.HALLUCINATION_PHOENIX], 2: [A.ENERGYRECHARGE_ENERGYRECHARGE]})
    controller = CoachScoutSpells()
    assert step(controller, bot, [sentry, nexus])
    assert bot.issues[-1] == ([nexus], A.ENERGYRECHARGE_ENERGYRECHARGE, sentry, {"minimap": False})
    assert not step(controller, bot, [sentry, nexus])  # Selection is not a cast.
    controller.confirm("scout_energy_recharge", True, 201, [2])
    bot.time = 201
    assert step(controller, bot, [sentry, nexus])
    assert bot.issues[-1] == ([sentry], A.HALLUCINATION_PHOENIX, None, {"minimap": False})
    phantom = unit(U.PHOENIX, 3, (51, 50), is_hallucination=True)
    bot.available[3] = [A.MOVE_MOVE]
    assert not step(controller, bot, [phantom])
    controller.confirm("scout_hallucinate_phoenix", True, 202, [1])
    bot.time = 202
    assert step(controller, bot, [phantom])
    assert bot.issues[-1] == ([phantom], A.MOVE_MOVE, bot.enemy_start_locations[0], {"minimap": True})
    controller.confirm("scout_hallucinated_phoenix", True, 203, [3])
    assert controller.status["confirmed_dispatches"] == 1
    assert controller.status["dispatched_tags"] == [3]
    assert not step(controller, bot, [phantom])


@pytest.mark.parametrize("energy", [151, 199, 200])
def test_recharge_does_not_waste_grant_on_nearly_full_sentry(energy):
    sentry, nexus = unit(U.SENTRY, 1, energy=energy), unit(U.NEXUS, 2)
    bot = Bot({1: [A.HALLUCINATION_PHOENIX], 2: [A.ENERGYRECHARGE_ENERGYRECHARGE]})
    assert step(CoachScoutSpells(), bot, [sentry, nexus])
    assert bot.issues[-1][1] == A.HALLUCINATION_PHOENIX


def test_exact_fifty_headroom_can_use_available_recharge():
    bot = Bot({2: [A.ENERGYRECHARGE_ENERGYRECHARGE]})
    assert step(CoachScoutSpells(), bot, [unit(U.SENTRY, 1, energy=150), unit(U.NEXUS, 2)])
    assert bot.issues[-1][1] == A.ENERGYRECHARGE_ENERGYRECHARGE


def test_spell_legality_comes_from_engine_not_assumed_energy():
    bot = Bot({1: [A.HALLUCINATION_PHOENIX]})
    assert step(CoachScoutSpells(), bot, [unit(U.SENTRY, 1, energy=1)])
    bot = Bot()
    assert not step(CoachScoutSpells(), bot, [unit(U.SENTRY, 1, energy=200), unit(U.NEXUS, 2, energy=200)])
    assert not bot.issues


@pytest.mark.parametrize("public_range,distance,expected", [(6, 7, False), (6, 5, True),
                                                            (500, 13, False), (0, 11, True)])
def test_public_cast_range_and_safe_home_radius(public_range, distance, expected):
    bot = Bot({2: [A.ENERGYRECHARGE_ENERGYRECHARGE]})
    bot.game_data.abilities[A.ENERGYRECHARGE_ENERGYRECHARGE.value] = NS(
        id=A.ENERGYRECHARGE_ENERGYRECHARGE, _proto=NS(cast_range=public_range))
    assert step(CoachScoutSpells(), bot, [unit(U.SENTRY, 1), unit(U.NEXUS, 2, (50+distance, 50))]) is expected


def test_canonical_available_ability_alias_is_accepted():
    bot = Bot({1: [A.HALLUCINATION_ORACLE]})
    bot.game_data.abilities[A.HALLUCINATION_PHOENIX.value] = NS(id=A.HALLUCINATION_ORACLE)
    assert step(CoachScoutSpells(), bot, [unit(U.SENTRY, 1)])
    assert bot.issues[-1][1] == A.HALLUCINATION_PHOENIX


@pytest.mark.parametrize("changed", [{"is_mine": False}, {"is_visible": False}, {"is_snapshot": True},
                                    {"is_ready": False}, {"is_hallucination": True}, {"point": (150, 150)}])
def test_hidden_unready_enemy_or_fake_sentry_is_never_used(changed):
    bot = Bot({1: [A.HALLUCINATION_PHOENIX]})
    assert not step(CoachScoutSpells(), bot, [unit(U.SENTRY, 1, **changed)])
    assert not bot.queries and not bot.issues


def test_visible_threat_preserves_sentry_energy_for_guardian():
    bot = Bot({1: [A.HALLUCINATION_PHOENIX], 2: [A.ENERGYRECHARGE_ENERGYRECHARGE]})
    own = [unit(U.SENTRY, 1), unit(U.NEXUS, 2)]
    threat = unit(U.MARINE, 3, can_attack=True, is_mine=False)
    assert not step(CoachScoutSpells(), bot, own, [threat])
    assert not bot.queries
    threat.is_visible = False
    assert step(CoachScoutSpells(), bot, own, [threat])


def test_existing_real_or_precast_hallucinated_phoenix_is_not_mistaken_for_new_scout():
    bot, controller, sentry = Bot(), CoachScoutSpells(), unit(U.SENTRY, 1)
    old = unit(U.PHOENIX, 2, is_hallucination=True)
    cast(controller, bot, sentry, [old])
    real = unit(U.PHOENIX, 3)
    bot.available.update({2: [A.MOVE_MOVE], 3: [A.MOVE_MOVE]})
    assert not step(controller, bot, [old, real])


def test_unselectable_preexisting_hallucination_still_enters_birth_baseline():
    bot, controller, sentry = Bot(), CoachScoutSpells(), unit(U.SENTRY, 1)
    old = unit(U.PHOENIX, 2, is_hallucination=True)
    bot.fairplay.source_available = lambda u, _: u.tag != 2
    cast(controller, bot, sentry, [old])
    bot.fairplay.source_available = lambda *_: True
    bot.available[2] = [A.MOVE_MOVE]
    assert not step(controller, bot, [old])


def test_rejected_cast_never_unlocks_phoenix_dispatch():
    bot, controller = Bot({1: [A.HALLUCINATION_PHOENIX]}), CoachScoutSpells()
    assert step(controller, bot, [unit(U.SENTRY, 1)])
    controller.confirm("scout_hallucinate_phoenix", False, 200, [1])
    bot.time = 204
    bot.available[2] = [A.MOVE_MOVE]
    assert not step(controller, bot, [unit(U.PHOENIX, 2, is_hallucination=True)])
    assert controller.confirmed_casts == 0


def test_failed_selection_sets_no_pending_cast():
    bot, controller = Bot({1: [A.HALLUCINATION_PHOENIX]}), CoachScoutSpells()
    bot.allow_selection = False
    assert not step(controller, bot, [unit(U.SENTRY, 1)])
    assert controller.pending is None and not bot.selections


def test_birth_observation_timeout_does_not_spam_sentry_or_infer_hidden_unit():
    bot, controller, sentry = Bot(), CoachScoutSpells(), unit(U.SENTRY, 1)
    cast(controller, bot, sentry)
    bot.time = 216
    assert not step(controller, bot, [sentry])
    assert controller.awaiting_birth is None
    bot.time = 260
    assert step(controller, bot, [sentry])


def test_dispatch_uses_only_one_hallucination_even_with_same_type_real_units_present():
    bot, controller, sentry = Bot(), CoachScoutSpells(), unit(U.SENTRY, 1)
    cast(controller, bot, sentry)
    first, second, real = [unit(U.PHOENIX, tag, is_hallucination=tag != 4) for tag in (2, 3, 4)]
    bot.available.update({tag: [A.MOVE_MOVE] for tag in (2, 3, 4)})
    assert step(controller, bot, [first, second, real])
    assert bot.issues[-1][0] == [first]


@pytest.mark.parametrize("order", [NS(scout=False, stance="defend"), NS(scout=True, stance="retreat")])
def test_strategy_can_disable_scout_spending(order):
    bot = Bot({1: [A.HALLUCINATION_PHOENIX]})
    assert not step(CoachScoutSpells(), bot, [unit(U.SENTRY, 1)], order=order)
    assert not bot.queries


def test_unrelated_or_wrong_source_confirmation_does_not_unlock_pending_cast():
    bot, controller = Bot({1: [A.HALLUCINATION_PHOENIX]}), CoachScoutSpells()
    assert step(controller, bot, [unit(U.SENTRY, 1)])
    controller.confirm("train_sentry", True, 201, [1])
    controller.confirm("scout_hallucinate_phoenix", True, 201, [999])
    assert controller.pending is not None and controller.awaiting_birth is None


def test_initial_chrono_reservation_is_twenty_seconds_once_and_uses_permitted_memory():
    controller = CoachScoutSpells()
    order = NS(scout=True, stance="defend")
    record = {"tag": 1, "type": "SENTRY", "last_seen_seconds": 150, "is_hallucination": False}
    report = {"own_memory": [record], "current_own": []}
    assert controller.reserve_for_first_recharge(report, order, 170)
    assert controller.reserve_for_first_recharge(report, order, 189.9)
    assert not controller.reserve_for_first_recharge(report, order, 190)
    record["last_seen_seconds"] = 200
    assert not controller.reserve_for_first_recharge(report, order, 200)  # Cannot renew the lease.
    assert report["own_memory"][0] is record


@pytest.mark.parametrize("queued", [{"produces": "SENTRY"}, {"ability_id": A.GATEWAYTRAIN_SENTRY.value}])
def test_observed_sentry_queue_can_reserve_before_unit_appears(queued):
    controller = CoachScoutSpells()
    record = {"tag": 2, "type": "GATEWAY", "orders": [queued]}
    assert controller.reserve_for_first_recharge({"current_own": [record]}, NS(scout=True, stance="defend"), 160)


def test_queue_reservation_covers_public_remaining_training_time_plus_camera_margin():
    controller = CoachScoutSpells()
    order = NS(scout=True, stance="defend")
    record = {"tag": 2, "type": "GATEWAY", "orders": [{"produces": "SENTRY", "progress": .25}]}
    report = {"current_own": [record], "action_costs": {"train_sentry": {"time_seconds": 24}}}
    assert controller.reserve_for_first_recharge(report, order, 160)
    assert controller.reserve_for_first_recharge(report, order, 181)  # Old20s lease would expire too early.
    assert controller.reserve_for_first_recharge(report, order, 197.9)
    assert not controller.reserve_for_first_recharge(report, order, 198)  #18train+20camera.


def test_sentry_queue_reservation_accounts_for_preceding_training_and_is_capped():
    controller = CoachScoutSpells()
    order = NS(scout=True, stance="defend")
    record = {"tag": 2, "type": "GATEWAY", "orders": [{"produces": "STALKER", "progress": .5},
                                                       {"produces": "SENTRY", "progress": 0}]}
    report = {"current_own": [record], "action_costs": {"train_sentry": {"time_seconds": 24},
                                                        "train_stalker": {"time_seconds": 40}}}
    assert controller.reserve_for_first_recharge(report, order, 160)
    assert controller.reserve_for_first_recharge(report, order, 219.9)
    assert not controller.reserve_for_first_recharge(report, order, 220)  #64 capped at60.


def test_unknown_public_train_time_reserves_sixty_seconds_only_once():
    controller = CoachScoutSpells()
    order = NS(scout=True, stance="defend")
    record = {"tag": 2, "type": "GATEWAY", "orders": [{"produces": "SENTRY"}]}
    report = {"current_own": [record]}
    assert controller.reserve_for_first_recharge(report, order, 160)
    assert controller.reserve_for_first_recharge(report, order, 219)
    assert not controller.reserve_for_first_recharge(report, order, 220)
    assert not controller.reserve_for_first_recharge(report, order, 260)


@pytest.mark.parametrize("record", [
    {"tag": 1, "type": "SENTRY", "last_seen_seconds": 90},
    {"tag": 1, "type": "SENTRY", "last_seen_seconds": 155, "is_hallucination": True},
    {"tag": 2, "type": "GATEWAY", "last_seen_seconds": 90, "orders": [{"produces": "SENTRY"}]},
    {"tag": 1, "type": "SENTRY"},
])
def test_stale_fake_or_undated_memory_does_not_start_chrono_reservation(record):
    controller = CoachScoutSpells()
    assert not controller.reserve_for_first_recharge({"own_memory": [record]}, NS(scout=True, stance="defend"), 160)


@pytest.mark.parametrize("now,scout,stance", [(301, True, "defend"), (160, False, "defend"),
                                            (160, True, "retreat"), (-1, True, "defend")])
def test_initial_reservation_only_applies_to_early_enabled_scouting(now, scout, stance):
    controller = CoachScoutSpells()
    report = {"current_own": [{"tag": 1, "type": "SENTRY"}]}
    assert not controller.reserve_for_first_recharge(report, NS(scout=scout, stance=stance), now)


@pytest.mark.parametrize("accepted", [True, False])
def test_actual_recharge_confirmation_releases_reservation_but_failure_does_not(accepted):
    controller = CoachScoutSpells()
    bot = Bot({2: [A.ENERGYRECHARGE_ENERGYRECHARGE]})
    sentry, nexus = unit(U.SENTRY, 1), unit(U.NEXUS, 2)
    report, order = {"current_own": [{"tag": 1, "type": "SENTRY"}]}, NS(scout=True, stance="defend")
    assert controller.reserve_for_first_recharge(report, order, 200)
    assert step(controller, bot, [sentry, nexus])
    controller.confirm("scout_energy_recharge", accepted, 201, [2])
    assert controller.reserve_for_first_recharge(report, order, 201) is not accepted
    assert controller.confirmed_recharges == int(accepted)


def test_confirmed_hallucination_also_releases_initial_chrono_reservation():
    controller, bot, sentry = CoachScoutSpells(), Bot(), unit(U.SENTRY, 1)
    report, order = {"current_own": [{"tag": 1, "type": "SENTRY"}]}, NS(scout=True, stance="defend")
    assert controller.reserve_for_first_recharge(report, order, 200)
    cast(controller, bot, sentry)
    assert not controller.reserve_for_first_recharge(report, order, 201)
