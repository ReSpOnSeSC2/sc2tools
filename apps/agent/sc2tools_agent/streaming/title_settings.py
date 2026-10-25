"""Private, opt-in stream-title configuration and account-bound receipts.

No provider requests happen here. Saving an opt-in never publishes a title.
"""
from __future__ import annotations

import copy
import hashlib
import math

from .title_template import validate_template

PLATFORMS = ("twitch", "kick", "youtube")
DEFAULT_SELECTION = {"twitch": True, "kick": True, "youtube": False}


def connection_key(connection):
    """Do not persist account credentials; rotate consent on token/base changes."""
    base, token = connection
    if not isinstance(base, str) or not isinstance(token, str) or not token:
        return ""
    return hashlib.sha256((base + "\0" + token).encode("utf-8")).hexdigest()


def load_title_settings(value, owner):
    value = value if isinstance(value, dict) else {}
    same_owner = bool(owner and value.get("owner") == owner)
    template = value.get("template", "") if same_owner else ""
    try:
        template = validate_template(template)
    except ValueError:
        template = ""
    selected = value.get("platforms") if same_owner else None
    selected = selected if isinstance(selected, dict) else {}
    attempt = value.get("last_attempt", 0) if same_owner else 0
    attempt = attempt if (isinstance(attempt, (float, int)) and not isinstance(attempt, bool)
                          and math.isfinite(attempt) and attempt >= 0) else 0
    titles = value.get("last_titles") if same_owner else None
    titles = titles if isinstance(titles, dict) else {}
    return {"owner": owner, "enabled": same_owner and value.get("enabled") is True,
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
    selected = payload.get("platforms")
    if (not isinstance(selected, dict) or set(selected) != set(PLATFORMS)
            or any(type(selected[name]) is not bool for name in PLATFORMS)):
        raise ValueError("Choose the platforms that may receive automatic stream titles.")
    if payload["enabled"] and not owner:
        raise ValueError("Pair this agent with your SC2Tools account first.")
    template = validate_template(payload.get("template"))
    if payload["enabled"] and not any(selected.values()):
        raise ValueError("Choose at least one platform for automatic stream titles.")
    result = copy.deepcopy(current)
    result.update(owner=owner, enabled=payload["enabled"], template=template,
                  platforms=copy.deepcopy(selected))
    return result
