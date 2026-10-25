"""Existing conservative channel/key suggestions, separated from the page."""
import re
from collections import Counter


def suggest_catalog_choices(page):
    """Fill unambiguous form choices without saving or replacing edits."""
    state = page.state
    catalog = state.get("catalog", {})
    config = state.get("configuration", {})

    def choose(combo, value):
        index = combo.findData(value)
        if index >= 0:
            blocked = combo.blockSignals(True)
            combo.setCurrentIndex(index)
            combo.blockSignals(blocked)

    channels = {row.get("id") for row in catalog.get("channels", []) if row.get("id")}
    if page.channel_combo.currentData() is None and "channel_id" not in page.setup_edits and not config.get("channel_id") and len(channels) == 1:
        choose(page.channel_combo, next(iter(channels)))
    channel = page.channel_combo.currentData()
    if not channel or channel not in channels:
        return

    def eligible(row):
        status = row.get("status") or {}
        return (row.get("channel_id") in {None, channel}
            and not any(row.get(key) is False for key in ("eligible", "selectable", "available"))
            and row.get("bound_elsewhere") is not True and not row.get("bound_broadcast_id")
            and row.get("stream_status", status.get("streamStatus") if isinstance(status, dict) else None) != "active")

    inventory = catalog.get("streams", [])
    counts = Counter(row.get("id") for row in inventory)
    rows = [row for row in inventory if row.get("id") and counts[row["id"]] == 1 and eligible(row)]
    roles = {}
    for row in rows:
        title = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", row.get("title", "")).lower()
        horizontal = bool(re.search(r"\b(horizontal|landscape)\b", title))
        portrait = bool(re.search(r"\b(vertical|portrait)\b", title))
        roles[row["id"]] = "horizontal_id" if horizontal and not portrait else "portrait_id" if portrait and not horizontal else None
    combos = {"horizontal_id": page.horizontal_combo, "portrait_id": page.portrait_combo}
    for key in ("horizontal_id", "portrait_id") * 2:
        combo = combos[key]
        other = combos["portrait_id" if key == "horizontal_id" else "horizontal_id"].currentData()
        if key in page.setup_edits or config.get(key):
            continue
        eligible_ids = {row["id"] for row in rows}
        if combo.currentData() is not None and (combo.currentData() == other or combo.currentData() not in eligible_ids):
            choose(combo, None)
        if combo.currentData() is not None:
            continue
        candidates = {row["id"] for row in rows if row["id"] != other}
        named = {identity for identity in candidates if roles.get(identity) == key}
        if len(named) == 1:
            choose(combo, next(iter(named)))
        elif other is not None and len(candidates) == 1:
            identity = next(iter(candidates))
            if roles.get(identity) in {None, key}:
                choose(combo, identity)

