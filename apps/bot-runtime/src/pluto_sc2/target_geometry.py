"""Current-screen occupancy checks for spatial command clicks.

Feature-layer player_relative/unit_density describe the actual command image:
https://github.com/google-deepmind/pysc2/blob/master/docs/environment.md
No minimap unit data, unseen positions, or global live counts are inspected.
"""
from __future__ import annotations

import math

from s2clientprotocol import common_pb2 as common
from sc2.position import Point2


def screen_pixel(bot, layer, pixel, expected_size):
    observation = getattr(bot.state, "observation", None)
    layers = getattr(getattr(observation, "feature_layer_data", None), "renders", None)
    image = getattr(layers, layer, None)
    if image is None or not image.data:
        return None
    width, height, bits = image.size.x, image.size.y, image.bits_per_pixel
    if (width, height) != expected_size or bits not in {1, 8, 16, 32}:
        return None
    if not 0 <= pixel.x < width or not 0 <= pixel.y < height:
        return None
    index = pixel.y * width + pixel.x
    data = image.data
    if len(data) != (width * height * bits + 7) // 8:
        return None
    if bits == 1:
        return (data[index // 8] >> (7 - index % 8)) & 1
    size = bits // 8
    return int.from_bytes(data[index * size:(index + 1) * size], "little")


def visible_screen_units(bot, controller):
    # on_screen checks engine visibility flags before reading world geometry.
    return [unit for unit in getattr(bot, "all_units", ()) if controller.on_screen(unit)
            and not getattr(unit, "is_snapshot", False)]


def overlapping_units(controller, pixel, units, *, exclude_tag=None):
    overlaps = []
    for unit in units:
        if unit.tag == exclude_tag:
            continue
        center = controller.screen_point(unit)
        radius = getattr(unit, "radius", 1.0)
        if not isinstance(radius, (int, float)) or not math.isfinite(radius) or radius <= 0:
            radius = 1.0
        # Feature occupancy is circular, but command picking can accept its
        # bounding-box corners: native v9 Nexus and v13 idle Stalker evidence.
        # Empty feature pixels alone therefore do not prove empty click space.
        structure = getattr(unit, "is_structure", False)
        footprint = getattr(unit, "footprint_radius", None) if structure else None
        if isinstance(footprint, (int, float)) and math.isfinite(footprint) and footprint > 0:
            radius = max(radius, footprint)
        # screen_point truncates unit centers to integer pixels. Round the
        # exclusion outward too: otherwise the last fractional pixel creates
        # a gap (native v14 Zealot, radius .5, offset five pixels).
        pixel_radius = math.ceil(radius * 128 / 24 + 2)
        dx, dy = abs(center.x - pixel.x), abs(center.y - pixel.y)
        overlaps_pick_area = max(dx, dy) <= pixel_radius
        if overlaps_pick_area:
            overlaps.append(unit)
    return overlaps


def clear_ground_pixel(bot, controller, pixel, screen_size, *, units=None):
    values = {name: screen_pixel(bot, name, pixel, screen_size)
              for name in ("player_relative", "unit_type", "unit_density")}
    # Missing/unreadable screen occupancy is not evidence of an empty pixel.
    if any(value is None or value != 0 for value in values.values()):
        return False
    return not overlapping_units(controller, pixel, visible_screen_units(bot, controller) if units is None else units)


GROUND_ATTACK_SEARCH_RADIUS = 24
GROUND_ATTACK_MAX_WAYPOINT = 8.0
# Keep room for camera-edge uncertainty. This margin alone did not fix native
# v9: square building-footprint exclusion above is required independently.
GROUND_ATTACK_SCREEN_MARGIN = 12


def visible_empty_ground_pixel(bot, controller, pixel, screen_size, *, units=None):
    """Only an observed, pathable, empty screen pixel can receive Attack(23)."""
    return (screen_pixel(bot, "visibility_map", pixel, screen_size) == 2
            and screen_pixel(bot, "pathable", pixel, screen_size) == 1
            and clear_ground_pixel(bot, controller, pixel, screen_size, units=units))


def resolve_ground_attack(bot, controller, target, sources, screen_size, camera_width):
    """Bounded current-screen terrain search; never inspect minimap units.

    Returns (pixel-center world point, screen pixel, redirection reason), or
    None. Off-screen intentions become a forward waypoint at most eight world
    units from the currently visible selected-source center. Selection may
    have moved the scene, so callers invoke this on the command observation.
    """
    if not all(math.isfinite(value) for value in target):
        return None
    width, height = screen_size
    scale = width / camera_width
    margin = GROUND_ATTACK_SCREEN_MARGIN
    center = controller.camera_center
    offscreen = not controller.on_screen(target)
    if offscreen:
        # A real F2/group selection can command visible ground while its units
        # are elsewhere. Only computing an offscreen forward waypoint needs
        # current source geometry; never reconstruct it from hidden positions.
        own = [unit for unit in sources if getattr(unit, "is_mine", False) and controller.on_screen(unit)]
        if not own:
            return None
        source = Point2((sum(unit.position.x for unit in own) / len(own),
                         sum(unit.position.y for unit in own) / len(own)))
        dx, dy = target.x - source.x, target.y - source.y
        distance = math.hypot(dx, dy)
        if distance <= 0:
            return None
        ux, uy = dx / distance, dy / distance
        limit = min(GROUND_ATTACK_MAX_WAYPOINT, distance)
        left, right = center.x - width / (2 * scale) + margin / scale, center.x + width / (2 * scale) - margin / scale
        bottom, top = center.y - height / (2 * scale) + margin / scale, center.y + height / (2 * scale) - margin / scale
        for origin, direction, low, high in ((source.x, ux, left, right), (source.y, uy, bottom, top)):
            if direction > 0:
                limit = min(limit, (high - origin) / direction)
            elif direction < 0:
                limit = min(limit, (low - origin) / direction)
        if limit <= .25:
            return None
        anchor = source.offset((ux * limit, uy * limit))
        anchor_x = int(width / 2 + (anchor.x - center.x) * scale)
        anchor_y = int(height / 2 - (anchor.y - center.y) * scale)
        reason = "offscreen_forward_waypoint"
    else:
        anchor = target
        projected = controller.screen_point(target)
        anchor_x, anchor_y = projected.x, projected.y
        reason = "occupied_screen_target"
    units = visible_screen_units(bot, controller)
    candidates = []
    radius = GROUND_ATTACK_SEARCH_RADIUS
    for dy_pixel in range(-radius, radius + 1):
        for dx_pixel in range(-radius, radius + 1):
            squared = dx_pixel * dx_pixel + dy_pixel * dy_pixel
            if squared > radius * radius:
                continue
            x, y = anchor_x + dx_pixel, anchor_y + dy_pixel
            if not margin <= x < width - margin or not margin <= y < height - margin:
                continue
            point = Point2((center.x + (x + .5 - width / 2) / scale,
                            center.y - (y + .5 - height / 2) / scale))
            if offscreen:
                displacement = (point.x - source.x, point.y - source.y)
                if (math.hypot(*displacement) > GROUND_ATTACK_MAX_WAYPOINT
                        or displacement[0] * ux + displacement[1] * uy <= .25
                        or point.distance_to(target) >= source.distance_to(target)):
                    continue
            candidates.append((squared, point.distance_to(target), y, x, point))
    for squared, _remaining, y, x, point in sorted(candidates):
        pixel = common.PointI(x=x, y=y)
        if visible_empty_ground_pixel(bot, controller, pixel, screen_size, units=units):
            return point, pixel, reason if offscreen or squared else None
    return None


def clear_enemy_target_pixel(bot, controller, pixel, target, screen_size):
    if not getattr(target, "is_enemy", False) or getattr(target, "is_mine", False):
        return False
    relative = screen_pixel(bot, "player_relative", pixel, screen_size)
    kind = screen_pixel(bot, "unit_type", pixel, screen_size)
    density = screen_pixel(bot, "unit_density", pixel, screen_size)
    expected_kind = getattr(getattr(target, "type_id", None), "value", getattr(target, "type_id", None))
    # With a point-or-unit attack, unreadable occupancy cannot establish that
    # the click is on the intended enemy rather than an overlapping friend.
    if relative != 4:
        return False
    if kind is None or kind != expected_kind:
        return False
    if density != 1:
        return False
    return not overlapping_units(controller, pixel, visible_screen_units(bot, controller), exclude_tag=target.tag)
