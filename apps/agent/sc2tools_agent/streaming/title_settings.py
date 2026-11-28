"""Private, opt-in stream-title configuration and account-bound receipts.

No provider requests happen here. Saving an opt-in never publishes a title.
"""
from __future__ import annotations

import copy
import hashlib
import math

from .title_channel import CHANNEL_PLATFORMS, MAX_TAGS, valid_tag
from .title_template import CURRENT_MATCH_TEMPLATE, MAX_TEMPLATE_LENGTH, validate_template

PLATFORMS = ("twitch", "kick", "youtube")
DEFAULT_SELECTION = {"twitch": True, "kick": True, "youtube": False}
LEGACY_MATCH_TEMPLATE_SUFFIXES = (
    " | v {opp} {aka} | {h2h} ({h2h_wr}) | {map}",
    " | {match_mmr} v {opp} {aka} | {h2h} ({h2h_wr}) | {map}",
)


def connection_key(connection):
    """Do not persist account credentials; rotate consent on token/base changes."""
    base, token = connection
    if not isinstance(base, str) or not isinstance(token, str) or not token:
        return ""
    return hashlib.sha256((base + "\0" + token).encode("utf-8")).hexdigest()


def _game_receipt(value):
    """A saved game key, or an empty receipt when it is not a short printable string."""
    ok = (isinstance(value, str) and value.strip() and len(value) <= 300
          and not any(ord(char) < 32 or ord(char) == 127 for char in value))
    return value if ok else ""


def load_title_settings(value, owner):
    value = value if isinstance(value, dict) else {}
    same_owner = bool(owner and value.get("owner") == owner)
    template = value.get("template", "") if same_owner else ""
    try:
        template = validate_template(template)
    except ValueError:
        template = ""
    # Upgrade saved copies of either old preset with a plain-text prefix.
    for suffix in LEGACY_MATCH_TEMPLATE_SUFFIXES:
        prefix = template.removesuffix(suffix)
        if prefix != template and prefix and not any(char in prefix for char in "|{}"):
            updated = f"{prefix} | {CURRENT_MATCH_TEMPLATE}"
            if len(updated) <= MAX_TEMPLATE_LENGTH:
                template = updated
            break
    selected = value.get("platforms") if same_owner else None
    selected = selected if isinstance(selected, dict) else {}
    attempt = value.get("last_attempt", 0) if same_owner else 0
    attempt = attempt if (isinstance(attempt, (float, int)) and not isinstance(attempt, bool)
                          and math.isfinite(attempt) and attempt >= 0) else 0
    titles = value.get("last_titles") if same_owner else None
    titles = titles if isinstance(titles, dict) else {}
    start_game = value.get("last_start_game") if same_owner else None
    start_game = _game_receipt(start_game)
    channel_game = value.get("last_channel_game") if same_owner else None
    channel_game = _game_receipt(channel_game)
    record_game = value.get("last_record_game") if same_owner else None
    record_game = _game_receipt(record_game)
    written = value.get("last_tags") if same_owner else None
    written = written if isinstance(written, dict) else {}
    return {"owner": owner, "enabled": same_owner and value.get("enabled") is True,
            "on_game_start": same_owner and value.get("on_game_start") is True,
            "channel_tags": same_owner and value.get("channel_tags") is True,
            "category_guard": same_owner and value.get("category_guard") is True,
            "record_chapters": same_owner and value.get("record_chapters") is True,
            "save_clips": same_owner and value.get("save_clips") is True,
            "last_record_game": record_game,
            "last_channel_game": channel_game,
            "last_tags": {name: [tag for tag in written[name][:MAX_TAGS] if valid_tag(tag)]
                          for name in CHANNEL_PLATFORMS if isinstance(written.get(name), list)},
            "last_start_game": start_game,
            "template": template,
            "platforms": {name: selected.get(name) if type(selected.get(name)) is bool
                          else DEFAULT_SELECTION[name] for name in PLATFORMS},
            "last_attempt": attempt,
            "last_titles": {name: title for name, title in titles.items()
                            if name in PLATFORMS and isinstance(title, str) and len(title) <= 70}}


def configure_title_settings(current, payload, owner):
    """Strict opt-in: master switch and every platform require actual booleans."""
    if not isinstance(payload, dict) or type(payload.get("enabled")) is not bool:
        raise ValueError("Choose whether automatic stream titles are enabled.")
    on_game_start = payload.get("on_game_start", current.get("on_game_start", False))
    if type(on_game_start) is not bool:
        raise ValueError("Choose whether titles refresh at the start of each game.")
    channel_tags = payload.get("channel_tags", current.get("channel_tags", False))
    category_guard = payload.get("category_guard", current.get("category_guard", False))
    if type(channel_tags) is not bool or type(category_guard) is not bool:
        raise ValueError("Choose whether channel tags and the category guard are enabled.")
    record_chapters = payload.get("record_chapters", current.get("record_chapters", False))
    if type(record_chapters) is not bool:
        raise ValueError("Choose whether game-start chapters are added to the OBS recording.")
    save_clips = payload.get("save_clips", current.get("save_clips", False))
    if type(save_clips) is not bool:
        raise ValueError("Choose whether a replay-buffer clip is saved after each game.")
    selected = payload.get("platforms")
    if (not isinstance(selected, dict) or set(selected) != set(PLATFORMS)
            or any(type(selected[name]) is not bool for name in PLATFORMS)):
        raise ValueError("Choose the platforms that may receive automatic stream titles.")
    channel = channel_tags or category_guard
    titles = payload["enabled"] or on_game_start
    automatic = titles or channel or record_chapters or save_clips
    if automatic and not owner:
        raise ValueError("Pair this agent with your SC2Tools account first.")
    try:
        template = validate_template(payload.get("template"))
    except ValueError:
        if titles:
            raise
        # Turning automation off must remain possible while the user is
        # editing an empty or invalid draft. Keep only a valid saved template.
        try:
            template = validate_template(current.get("template"))
        except ValueError:
            template = ""
    if (titles or channel) and not any(selected.values()):
        raise ValueError("Choose at least one platform for automatic stream titles.")
    if channel and not any(selected[name] for name in CHANNEL_PLATFORMS):
        raise ValueError("Choose Twitch or Kick for channel tags and the category guard.")
    result = copy.deepcopy(current)
    result.update(owner=owner, enabled=payload["enabled"], template=template,
                  on_game_start=on_game_start, channel_tags=channel_tags, category_guard=category_guard,
                  record_chapters=record_chapters, save_clips=save_clips, platforms=copy.deepcopy(selected))
    return result
