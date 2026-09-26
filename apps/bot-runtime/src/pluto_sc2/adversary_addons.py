"""Resolve a policy-selected landing onto an existing owned Terran addon.

Only owned observations and public ability data are read. This helper neither
chooses an action nor issues one; the caller still applies its APM controls.
"""
from __future__ import annotations

from typing import Any

from s2clientprotocol import query_pb2 as query
from sc2.ids.ability_id import AbilityId
from sc2.position import Point2

from .adversary_placement import QUERY_BATCH, find_placement, footprint_width, site_clear, visible_footprint


ADDON_REUSE_PROFILE = "visible-owned-addon-reuse-v1"
PRODUCERS = frozenset(("BARRACKS", "FACTORY", "STARPORT"))
ADDONS = {
    family: frozenset((family, *(producer + family for producer in PRODUCERS)))
    for family in ("TECHLAB", "REACTOR")
}
LAND_ABILITIES = frozenset(ability for ability in AbilityId if ability.name == "LAND"
                          or ability.name.startswith("LAND_"))


async def verified_addon_point(bot: Any, producer: Any, ability: Any) -> Point2 | None:
    """Verify an explicit addon command at the existing producer anchor.

    Public Base97563 addon abilities are PointOrNone. When the live available
    ability query requires a point, use the grounded producer center (the
    parent-plus-addon placement anchor), not the offset addon center. Query the
    exact ability with placing_unit_tag so SC2 evaluates this producer's legal
    footprint. Body and addon socket must both be currently visible.
    """
    public = getattr(bot.game_data, "abilities", {}).get(ability.value)
    target_kind = getattr(getattr(public, "_proto", None), "target", None)
    if target_kind not in {2, 4, 5}:  # Point, PointOrUnit, PointOrNone.
        return None
    if getattr(producer, "is_flying", False):
        return None
    attempts = []

    async def legal(point):
        area = bot.game_info.playable_area
        if (not visible_footprint(point, 3, bot.is_visible, area)
                or not visible_footprint(point.offset((2.5, -.5)), 2, bot.is_visible, area)):
            return False
        response = await bot.client._execute(query=query.RequestQuery(placements=[
            query.RequestQueryBuildingPlacement(ability_id=ability.value, target_pos=point.as_Point2D,
                                               placing_unit_tag=int(producer.tag))],
            ignore_resource_requirements=False))
        results = [int(row.result) for row in response.query.placements]
        attempts.append(dict(target=list(point), addon_position=list(point.offset((2.5, -.5))), result=results))
        bot._addon_point_query = dict(ability=ability.value, source_tag=int(producer.tag),
                                    producer_position=list(producer.position), public_target=target_kind,
                                    attempts=attempts)
        return results == [1]

    if await legal(producer.position):
        return producer.position
    # Some observed states require lifting to build at another location. Use
    # the same visible body/socket placement rules as an ordinary relocation,
    # then query the actual addon ability for this exact producer. At most one
    # alternative is tried; no repeated arbitrary point probing or forced lift.
    alternative = await find_placement(bot, AbilityId["LAND_" + producer.type_id.name],
                                       producer.type_id, producer.position)
    if alternative is not None and await legal(alternative):
        return alternative
    return None


def _point(value: Any) -> Point2:
    return value.position if hasattr(value, "position") else Point2(value)


def _ability_value(ability: Any, game_data: Any) -> int:
    """Public remapping makes exact and general LAND orders comparable."""
    identifier = getattr(ability, "id", ability)
    value = int(getattr(identifier, "value", identifier))
    data = getattr(game_data, "abilities", {}).get(value)
    identifier = getattr(data, "id", value)
    return int(getattr(identifier, "value", identifier))


def _landing_claims(owned: list[Any], origin: Any, game_data: Any) -> list[tuple[Point2, float]]:
    claims = []
    source_tag = getattr(origin, "tag", None)
    land_ids = {_ability_value(ability, game_data) for ability in LAND_ABILITIES}
    for unit in owned:
        if not getattr(unit, "is_flying", False) or getattr(unit, "tag", None) == source_tag:
            continue
        # Burnysc2 UnitOrder resolves raw exact IDs through the same public
        # game data. No enemy orders or inferred hidden targets are consulted.
        for order in getattr(unit, "orders", ()):
            if _ability_value(order.ability, game_data) not in land_ids:
                continue
            target = getattr(order, "target", None)
            if target is None or isinstance(target, int):
                continue
            point = _point(target)
            width = 5.0 if unit.type_id.name.removesuffix("FLYING") in {
                "COMMANDCENTER", "ORBITALCOMMAND"
            } else 3.0
            claims.append((point, width))
    return claims


async def reusable_addon_site(bot: Any, producer_kind: Any, origin: Any,
                              addon_kind: str | None = None, *,
                              excluded_addon_tags: frozenset[int] = frozenset()) -> tuple[Any, Point2] | None:
    """Return the closest visible legal (owned addon, 3x3 landing point).

    ``origin`` accepts a unit or a point. Pass the flying producer itself to
    exclude its existing landing order from other units' reservations. Addons
    are interchangeable across producer types, including previously attached
    subtypes. ``addon_kind`` optionally restricts reuse to TECHLAB or REACTOR.
    """
    producer_name = getattr(producer_kind, "name", str(producer_kind)).upper().removesuffix("FLYING")
    if producer_name not in PRODUCERS:
        raise ValueError("Addon reuse requires a Barracks, Factory, or Starport")
    family = addon_kind.upper() if addon_kind is not None else None
    if family is not None and family not in ADDONS:
        raise ValueError("Addon kind must be TECHLAB or REACTOR")
    allowed_types = ADDONS[family] if family else ADDONS["TECHLAB"] | ADDONS["REACTOR"]
    owned = [unit for unit in getattr(bot, "structures", ()) if getattr(unit, "is_mine", True)]
    grounded = [unit for unit in owned if not getattr(unit, "is_flying", False)]
    attached_tags = {getattr(unit, "add_on_tag", 0) for unit in grounded
                     if unit.type_id.name in PRODUCERS}
    game_data = getattr(bot, "game_data", None)
    all_addon_types = ADDONS["TECHLAB"] | ADDONS["REACTOR"]
    occupied = [(unit.position, 2.0 if unit.type_id.name in all_addon_types
                 else footprint_width(unit.type_id, game_data)) for unit in grounded]
    occupied.extend(_landing_claims(owned, origin, game_data))
    area = bot.game_info.playable_area
    origin_point = _point(origin)
    candidates = []
    for addon in grounded:
        if (addon.type_id.name not in allowed_types or addon.tag in attached_tags or addon.tag in excluded_addon_tags
                or not getattr(addon, "is_ready", False)
                or not getattr(addon, "is_visible", False)
                or getattr(addon, "is_snapshot", False)):
            continue
        point = addon.position.offset((-2.5, .5))
        # The body and the existing addon meet at their edges. Checking the
        # actual 2x2 addon footprint does not require that socket to be empty.
        if (not visible_footprint(point, 3, bot.is_visible, area)
                or not visible_footprint(addon.position, 2, bot.is_visible, area)
                or not site_clear(point, 3, occupied=occupied)):
            continue
        candidates.append((addon, point))
    candidates.sort(key=lambda item: (origin_point.distance_to(item[1]), item[0].tag))
    ability = AbilityId["LAND_" + producer_name]
    for offset in range(0, len(candidates), QUERY_BATCH):
        batch = candidates[offset:offset + QUERY_BATCH]
        # A Depot query at the socket would reject the very addon being reused.
        # Ask SC2 about the selected producer's actual LAND body instead.
        legal = await bot.can_place(ability, [point for _, point in batch])
        for candidate, allowed in zip(batch, legal, strict=True):
            if allowed:
                return candidate
    return None
