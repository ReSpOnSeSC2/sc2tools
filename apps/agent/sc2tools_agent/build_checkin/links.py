"""sc2tools.com pages the build check-in cards open in the browser."""

from __future__ import annotations

from urllib.parse import quote

from .models import BUILD_SIDES

DEFAULT_DASHBOARD_URL = "https://sc2tools.com"


def web_queue_url(dashboard_url: str) -> str:
    """Where the tray item goes when no card is waiting."""
    return dashboard_url.rstrip("/") + "/app"


def new_build_url(dashboard_url: str, game_id: str, side: str) -> str:
    """The game's page with the "Add new build" editor opened for
    ``side`` (``you`` | ``opponent``), seeded from the replay."""
    if side not in BUILD_SIDES:
        raise ValueError(f"unknown build side: {side!r}")
    return (
        f"{dashboard_url.rstrip('/')}/app/game/{quote(game_id, safe='')}"
        f"?newBuild={side}"
    )


__all__ = [
    "DEFAULT_DASHBOARD_URL",
    "new_build_url",
    "web_queue_url",
]
