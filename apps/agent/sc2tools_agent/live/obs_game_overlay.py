"""Explicit game-source choices and additive OBS updates; no automatic writes."""
from __future__ import annotations

import threading
from typing import Any, Optional, Sequence

OBS_GAME_WRITE_LOCK = threading.RLock()
GAME_WIDGETS = ("overlay", "ghost-build", "randomizer", "stats-ticker")
GAME_WIDGET_LABELS = {
    "overlay": "All-in-one overlay", "ghost-build": "Ghost Build coach",
    "randomizer": "Build randomizer", "stats-ticker": "Stats ticker",
}
GAME_INPUT_NAMES = {
    "overlay": "SC2 Tools Game Overlay", "ghost-build": "SC2 Tools Ghost Build",
    "randomizer": "SC2 Tools Build Randomizer", "stats-ticker": "SC2 Tools Stats Ticker",
}


def selected_game_widgets(raw: Optional[Sequence[str]]) -> tuple[str, ...]:
    if raw is None:
        return ("overlay",)
    if not isinstance(raw, (list, tuple)) or len(raw) > len(GAME_WIDGETS):
        raise ValueError("Choose only the four supported during-game sources")
    if any(not isinstance(value, str) or value not in GAME_WIDGETS for value in raw):
        raise ValueError("Unknown during-game source")
    return tuple(value for value in GAME_WIDGETS if value in raw)


def planned_game_widgets(sx: float, sy: float, selected: Optional[Sequence[str]], show_credit: bool = True):
    from .obs_layout import PlannedItem, Rect
    rectangles = {
        "overlay": Rect(0, 0, 1920, 1080),
        "ghost-build": Rect(1480, 20, 420, 780),
        "randomizer": Rect(700, 20, 520, 360),
        "stats-ticker": Rect(0, 1024, 1920, 56),
    }
    return [PlannedItem(
        label=GAME_WIDGET_LABELS[key], rect=rectangles[key].scaled(sx, sy), z=2,
        browser_path=("" if show_credit else "?credit=0") if key == "overlay" else f"widget/{key}",
        input_name=GAME_INPUT_NAMES[key], share_key=f"during_game:{key}",
    ) for key in selected_game_widgets(selected)]


def matching_game_input(client: Any, item) -> Optional[str]:
    """Reuse an existing renderer for the exact origin/token/route.

    Its settings are never changed. A scene reference can be placed without
    starting a second browser/audio connection, including across scenes.
    """
    from .obs_layout import BROWSER_INPUT_KIND, _overlay_url_key
    expected = _overlay_url_key(item.browser_path)
    rows = client.get_input_list(BROWSER_INPUT_KIND)
    if len(rows) > 1000:
        raise ValueError("OBS has too many Browser Sources to check safely")
    for row in rows:
        if row.get("kind") != BROWSER_INPUT_KIND:
            continue
        name = row.get("name")
        if name and _overlay_url_key(client.get_input_settings(name).get("url", "")) == expected:
            return str(name)
    return None


def add_missing_game_sources(client: Any, plan, scene_names: Sequence[str]) -> list[str]:
    """Add only selected missing inputs/references, preserving existing order.

    New items are inserted below existing manual covers/chat alerts. Their
    indices can shift, but no existing relative order, transform or input
    setting is changed. Discovery errors abort rather than duplicate audio.
    """
    from .obs_layout import (
        SCENE_IN_GAME, _assert_ours, _create_item, _transform_for,
        _overlay_url_key, _manual_override_url_from_overlay_url,
    )
    added = []
    for scene in plan.scenes:
        if scene.name not in scene_names or scene.name != SCENE_IN_GAME or not scene.exists:
            continue
        _assert_ours(scene.name)
        for item in scene.items:
            if not item.share_key or not item.share_key.startswith("during_game:"):
                continue
            rows = client.get_scene_item_list(scene.name)
            if len(rows) > 2000:
                raise ValueError("OBS scene is too large to update safely")
            expected = _overlay_url_key(item.browser_path)
            if any(row.get("input_kind") == "browser_source" and _overlay_url_key(
                client.get_input_settings(str(row.get("source_name") or "")).get("url", "")
            ) == expected for row in rows):
                continue
            shared = {}
            existing = matching_game_input(client, item)
            if existing:
                shared[item.share_key] = existing
            widget_id = item.share_key.split(":", 1)[1]
            manual = _manual_override_url_from_overlay_url(
                item.browser_path, expected_route=("overlay", "") if widget_id == "overlay" else ("widget", widget_id),
            )
            anchor_keys = {_overlay_url_key(manual)}
            if manual:
                anchor_keys.add(_overlay_url_key(manual.replace("/scene/manual", "/widget/chat-alerts")))
            anchors = [int(row.get("index", index)) for index, row in enumerate(rows)
                       if row.get("input_kind") == "browser_source" and _overlay_url_key(
                           client.get_input_settings(str(row.get("source_name") or "")).get("url", ""),
                       ) in anchor_keys]
            new_id = _create_item(client, scene.name, item, shared_browser_inputs=shared)
            if new_id is None:
                continue
            client.set_scene_item_transform(scene_name=scene.name, item_id=new_id, transform=_transform_for(item.rect))
            if anchors:
                client.set_scene_item_index(scene_name=scene.name, item_id=new_id, index=min(anchors))
            added.append(item.label)
    return added
