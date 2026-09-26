import asyncio
from collections import Counter
from types import SimpleNamespace as NS

from sc2.ids.ability_id import AbilityId as A
from sc2.ids.buff_id import BuffId as B
from sc2.ids.unit_typeid import UnitTypeId as U
from sc2.position import Point2

from pluto_sc2.coach_combat import CoachCombat, _ready_attack_in_progress


def unit(kind, tag, point, **kwargs):
    values = dict(type_id=kind, tag=tag, position=Point2(point), is_ready=True,
                  is_structure=False, is_flying=False, is_visible=True, is_snapshot=False,
                  is_mine=True, can_attack=True, can_attack_ground=True, can_attack_air=False,
                  can_be_attacked=True, health=100, health_max=100, shield=80, shield_max=80,
                  ground_range=6, air_range=0, radius=.5, weapon_cooldown=0, is_armored=False)
    values.update(kwargs)
    return NS(**values)


def test_focus_nearby_fighter_not_weaker_worker_or_far_target():
    stalker = unit(U.STALKER, 1, (50, 50))
    worker = unit(U.SCV, 2, (54, 50), health=1, shield=0)
    marine = unit(U.MARINE, 3, (54, 51), health=30, shield=0)
    far = unit(U.MARINE, 4, (68, 50), health=1, shield=0)
    plan = CoachCombat().choose([stalker], [worker, marine, far], 10)
    assert plan.target.tag == marine.tag


def test_immortal_prefers_reachable_armored_threat():
    immortal = unit(U.IMMORTAL, 1, (50, 50))
    marine = unit(U.MARINE, 2, (54, 50), health=10, shield=0)
    marauder = unit(U.MARAUDER, 3, (54, 52), is_armored=True)
    assert CoachCombat().choose([immortal], [marine, marauder], 10).target.tag == 3


def test_direct_target_closes_short_gap_instead_of_discarding_valid_target():
    stalker = unit(U.STALKER, 1, (50, 50))
    marine = unit(U.MARINE, 2, (58.5, 50), is_mine=False)
    plan = CoachCombat().choose([stalker], [marine], 10)
    assert plan.sources == (stalker,) and plan.target is marine
    assert plan.ability == A.ATTACK_ATTACK


def test_attack_stance_can_pursue_visible_target_but_does_not_change_weapon_range():
    stalker = unit(U.STALKER, 1, (50, 50))
    marine = unit(U.MARINE, 2, (60, 50), is_mine=False)
    controller = CoachCombat()
    assert controller.choose([stalker], [marine], 10) is None
    assert controller.choose([stalker], [marine], 10, pursue=True).target is marine
    assert stalker.ground_range == 6
    marine.position = Point2((62, 50))
    assert controller.choose([stalker], [marine], 10, pursue=True) is None


def test_damaged_unit_does_not_gain_extended_pursuit_allowance():
    stalker = unit(U.STALKER, 1, (50, 50), health=60, shield=0)
    marine = unit(U.MARINE, 2, (60, 50), is_mine=False)
    assert CoachCombat().choose([stalker], [marine], 10, pursue=True) is None


def test_damage_retreat_does_not_pull_zealot_or_whole_group():
    hurt = unit(U.STALKER, 1, (50, 50), health=20, shield=0)
    healthy = unit(U.STALKER, 2, (50, 52))
    enemy = unit(U.MARINE, 3, (54, 50))
    intent = CoachCombat().choose([hurt, healthy], [enemy], 10)
    assert intent.sources == (hurt,)
    assert intent.ability == A.MOVE_MOVE
    assert intent.target.x < 50
    zealot = unit(U.ZEALOT, 4, (50, 50), ground_range=.1, health=20, shield=0)
    assert CoachCombat().choose([zealot], [enemy], 10) is None


def test_cooldown_kites_melee_only_while_weapon_reloading():
    enemy = unit(U.ZERGLING, 2, (52, 50), ground_range=.1)
    stalker = unit(U.STALKER, 1, (50, 50), weapon_cooldown=12)
    assert CoachCombat().choose([stalker], [enemy], 10).reason == 'cooldown_kite'
    stalker.weapon_cooldown = 0
    assert CoachCombat().choose([stalker], [enemy], 10).ability == A.ATTACK_ATTACK


def test_no_hidden_targets_workers_or_retreat_override():
    stalker = unit(U.STALKER, 1, (50, 50))
    enemy = unit(U.MARINE, 2, (54, 50), is_visible=False)
    controller = CoachCombat()
    assert controller.choose([stalker], [enemy], 10) is None
    enemy.is_visible = True
    assert controller.choose([stalker], [enemy], 10, retreat=True) is None
    assert controller.choose([unit(U.PROBE, 3, (50, 50))], [enemy], 10) is None


def test_attention_rotates_types_and_preserves_withdrawing_member():
    controller = CoachCombat()
    zealot = unit(U.ZEALOT, 1, (50, 50), ground_range=.1)
    stalker = unit(U.STALKER, 2, (50, 50))
    other = unit(U.STALKER, 3, (51, 50))
    enemy = unit(U.MARINE, 4, (51, 50))
    first = controller.choose([zealot, stalker, other], [enemy], 10)
    controller.type_attention[first.sources[0].type_id] = 10
    next_order = controller.choose([zealot, stalker, other], [enemy], 11)
    assert next_order.sources[0].type_id != first.sources[0].type_id
    controller.withdrawing[other.tag] = 20
    controller.type_attention[U.ZEALOT] = 12
    assert controller.choose([zealot, stalker, other], [enemy], 13).sources == (stalker,)


def test_screen_boundary_precedes_any_pathing_query():
    hurt = unit(U.STALKER, 1, (50, 50), health=10, shield=0)
    enemy = unit(U.MARINE, 2, (54, 50))
    bot = NS(time=10, fairplay=NS(on_screen=lambda x: hasattr(x, 'tag'), source_available=lambda *_: True),
             is_visible=lambda _: True,
             in_pathing_grid=lambda _: (_ for _ in ()).throw(AssertionError('Offscreen pathing leaked')))
    assert not asyncio.run(CoachCombat().step(bot, [hurt], [enemy], None))


def test_execution_uses_ability_query_and_fairplay_gate(monkeypatch):
    import pluto_sc2.coach_combat as module
    monkeypatch.setattr(module, 'duplicate_order', lambda *_: False)
    calls = []
    async def abilities(sources, **kwargs):
        calls.append(('query', sources, kwargs))
        return [[A.ATTACK_ATTACK] for _ in sources]
    async def issue(*args, **kwargs):
        calls.append(('issue', args, kwargs))
        return True
    bot = NS(time=10, fairplay=NS(on_screen=lambda _: True, source_available=lambda *_: True, issue=issue),
             get_available_abilities=abilities, game_data=NS(abilities={}),
             _record_selection=lambda *args: calls.append(('record', args)), action_counts=Counter())
    own = unit(U.STALKER, 1, (50, 50))
    enemy = unit(U.MARINE, 2, (54, 50), is_mine=False)
    controller = CoachCombat()
    assert asyncio.run(controller.step(bot, [own], [enemy], None))
    assert calls[0][0] == 'query' and calls[1][0] == 'issue'
    assert calls[1][2] == {'minimap': False}
    assert controller.choose([own], [enemy], 10.5) is None


def test_guardian_shield_for_local_group_under_ranged_pressure():
    own = [unit(U.SENTRY, 1, (50, 50), energy=75), unit(U.STALKER, 2, (50, 52)),
           unit(U.ZEALOT, 3, (52, 50))]
    enemies = [unit(U.MARINE, i, (54, 50)) for i in range(4, 7)]
    controller = CoachCombat()
    intent = controller.choose(own, enemies, 10)
    assert intent.ability == A.GUARDIANSHIELD_GUARDIANSHIELD and intent.target is None
    own[0].buffs = {B.GUARDIANSHIELD}
    assert controller.choose(own, enemies, 10).ability != A.GUARDIANSHIELD_GUARDIANSHIELD


def test_guardian_shield_not_spent_without_nearby_army():
    sentry = unit(U.SENTRY, 1, (50, 50), energy=200)
    enemies = [unit(U.MARINE, i, (54, 50)) for i in range(4, 7)]
    assert CoachCombat().choose([sentry], enemies, 10).ability != A.GUARDIANSHIELD_GUARDIANSHIELD


def test_retreat_considers_second_enemy_instead_of_backing_into_it():
    hurt = unit(U.STALKER, 1, (50, 50), health=10, shield=0)
    first = unit(U.MARINE, 2, (54, 50), ground_dps=1)
    second = unit(U.MARAUDER, 3, (46, 50), ground_dps=20)
    intent = CoachCombat().choose([hurt], [first, second], 10)
    assert intent.ability == A.MOVE_MOVE
    assert intent.target.x > 49
    assert abs(intent.target.y - 50) > 2


def test_focus_does_not_draw_remote_same_type_reinforcements_into_fight():
    own = [unit(U.STALKER, 1, (50, 50)), unit(U.STALKER, 2, (50, 51)),
           unit(U.STALKER, 3, (35, 50))]
    enemy = unit(U.MARINE, 4, (55, 50))
    intent = CoachCombat().choose(own, [enemy], 10)
    assert intent.sources == (own[0],)


def test_preserve_ready_attack_only_with_current_reachable_target():
    shooter = unit(U.STALKER, 1, (50, 50),
                   orders=[NS(ability=NS(id=A.ATTACK_ATTACK), target=2)])
    enemy = unit(U.MARINE, 2, (55, 50))
    assert _ready_attack_in_progress(shooter, [enemy])
    shooter.orders[0].ability.id = A.ATTACK
    assert _ready_attack_in_progress(shooter, [enemy])
    assert not _ready_attack_in_progress(shooter, [])
    enemy.position = Point2((70, 50))
    assert not _ready_attack_in_progress(shooter, [enemy])


def test_retreat_tries_visible_alternative_without_querying_fog(monkeypatch):
    monkeypatch.setattr('pluto_sc2.coach_combat.duplicate_order', lambda *_: False)
    hurt = unit(U.STALKER, 1, (50, 50), health=10, shield=0)
    enemy = unit(U.MARINE, 2, (54, 50), is_mine=False)
    selected = []
    async def abilities(sources, **kwargs):
        return [[A.MOVE_MOVE] for _ in sources]
    async def issue(bot, sources, ability, target, **kwargs):
        selected.append(target)
        return True
    def pathing(point):
        assert abs(point.y - 50) > .1, 'Fog point queried'
        return True
    bot = NS(time=10, fairplay=NS(on_screen=lambda _: True, source_available=lambda *_: True, issue=issue),
             is_visible=lambda point: abs(point.y - 50) > .1, in_pathing_grid=pathing,
             get_available_abilities=abilities, game_data=NS(abilities={}),
             _record_selection=lambda *_: None, action_counts=Counter())
    assert asyncio.run(CoachCombat().step(bot, [hurt], [enemy], None))
    assert abs(selected[0].y - 50) > .1


def test_source_lease_exclusion_prevents_all_type_reselection(monkeypatch):
    monkeypatch.setattr('pluto_sc2.coach_combat.duplicate_order', lambda *_: False)
    own = [unit(U.STALKER, i, (50, 50 + i)) for i in range(1, 4)]
    enemy = unit(U.MARINE, 5, (54, 52), is_mine=False)
    groups = []
    async def abilities(sources, **kwargs):
        return [[A.ATTACK_ATTACK] for _ in sources]
    async def issue(bot, sources, *args, **kwargs):
        groups.append(sources)
        return True
    bot = NS(time=10, fairplay=NS(on_screen=lambda _: True, source_available=lambda u, _: u.tag != 3,
                                 issue=issue), get_available_abilities=abilities,
             game_data=NS(abilities={}), _record_selection=lambda *_: None, action_counts=Counter())
    assert asyncio.run(CoachCombat().step(bot, own, [enemy], None))
    assert len(groups[0]) == 1 and groups[0][0].tag != 3


def test_hallucinated_scout_is_not_commanded_as_real_combat_unit():
    fake = unit(U.PHOENIX, 1, (50, 50), is_hallucination=True, is_flying=True,
                can_attack_air=True)
    enemy = unit(U.VIKINGFIGHTER, 2, (54, 50), is_flying=True)
    assert CoachCombat().choose([fake], [enemy], 10) is None


def test_pending_prism_pickup_prevents_combat_from_moving_its_target():
    hurt = unit(U.STALKER, 1, (50, 50), health=10, shield=0)
    enemy = unit(U.MARINE, 2, (54, 50), is_mine=False)
    bot = NS(time=10, fairplay=NS(on_screen=lambda _: True, source_available=lambda *_: True))
    assert not asyncio.run(CoachCombat().step(bot, [hurt], [enemy], None, protected_tags={1}))


def test_guardian_shield_covers_retreat_under_actual_ranged_pressure():
    own = [unit(U.SENTRY, 1, (50, 50), energy=75), unit(U.STALKER, 2, (50, 52)),
           unit(U.ZEALOT, 3, (52, 50))]
    enemies = [unit(U.MARINE, i, (54, 50)) for i in range(4, 6)]
    intent = CoachCombat().choose(own, enemies, 10, retreat=True)
    assert intent.reason == 'guardian_shield'


def test_guardian_shield_not_spent_for_out_of_range_or_melee_enemies():
    own = [unit(U.SENTRY, 1, (50, 50), energy=100), unit(U.STALKER, 2, (50, 51)),
           unit(U.ZEALOT, 3, (50, 49))]
    enemies = [unit(U.MARINE, i, (58, 50), ground_range=3) for i in range(4, 7)]
    intent = CoachCombat().choose(own, enemies, 10)
    assert intent is None or intent.reason != 'guardian_shield'
    for enemy in enemies:
        enemy.position = Point2((52, 50))
        enemy.ground_range = .1
    assert CoachCombat().choose(own, enemies, 10).reason != 'guardian_shield'


def test_guardian_shield_does_not_overlap_existing_nearby_aura():
    own = [unit(U.SENTRY, 1, (50, 50), energy=100), unit(U.SENTRY, 2, (51, 50),
           energy=100, buffs={B.GUARDIANSHIELD}), unit(U.STALKER, 3, (50, 52)),
           unit(U.ZEALOT, 4, (52, 50))]
    enemies = [unit(U.MARINE, i, (54, 50)) for i in range(5, 8)]
    assert CoachCombat().choose(own, enemies, 10).reason != 'guardian_shield'


def test_guardian_confirmation_is_per_caster_and_failure_does_not_claim_cast():
    controller = CoachCombat()
    controller.guardian_casters[1] = 12
    controller.confirm('combat_guardian_shield', False, 10, [1])
    assert controller.confirmed_guardian_casts == 0 and 1 not in controller.guardian_casters
    controller.confirm('combat_guardian_shield', True, 20, [1])
    assert controller.confirmed_guardian_casts == 1 and controller.guardian_casters[1] == 32
    own = [unit(U.SENTRY, 2, (70, 50), energy=100), unit(U.STALKER, 3, (70, 52)),
           unit(U.ZEALOT, 4, (72, 50))]
    enemies = [unit(U.MARINE, i, (74, 50)) for i in range(5, 8)]
    assert controller.choose(own, enemies, 21).sources[0].tag == 2


def test_guardian_priority_probe_does_not_consume_other_micro_opportunity():
    hurt = unit(U.STALKER, 1, (50, 50), health=10, shield=0)
    enemy = unit(U.MARINE, 2, (54, 50), is_mine=False)
    bot = NS(time=10, fairplay=NS(on_screen=lambda _: True, source_available=lambda *_: True))
    controller = CoachCombat()
    before = controller.last_input
    assert not asyncio.run(controller.step(bot, [hurt], [enemy], None, guardian_only=True))
    assert controller.last_input == before and not controller.type_attention
    assert controller.choose([hurt], [enemy], 10).reason == 'damaged_ranged_retreat'


def test_guardian_priority_pass_still_issues_shield(monkeypatch):
    monkeypatch.setattr('pluto_sc2.coach_combat.duplicate_order', lambda *_: False)
    own = [unit(U.SENTRY, 1, (50, 50), energy=75), unit(U.STALKER, 2, (50, 52)),
           unit(U.ZEALOT, 3, (52, 50))]
    enemies = [unit(U.MARINE, i, (54, 50), is_mine=False) for i in range(4, 7)]
    calls = []
    async def abilities(sources, **kwargs):
        return [[A.GUARDIANSHIELD_GUARDIANSHIELD] for _ in sources]
    async def issue(bot, sources, ability, target, **kwargs):
        calls.append(ability)
        return True
    bot = NS(time=10, fairplay=NS(on_screen=lambda _: True, source_available=lambda *_: True, issue=issue),
             get_available_abilities=abilities, game_data=NS(abilities={}),
             _record_selection=lambda *_: None, action_counts=Counter())
    assert asyncio.run(CoachCombat().step(bot, own, enemies, None, guardian_only=True))
    assert calls == [A.GUARDIANSHIELD_GUARDIANSHIELD]
