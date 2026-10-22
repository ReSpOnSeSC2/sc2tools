"""Runner glue: build, attach and start the controller in one call.

``runner._gui_boot_worker`` calls :func:`start_build_checkin` once the
live bridge exists. Headless, ``--no-gui`` and ``--no-live`` runs never
get a controller. A failure here is logged and swallowed: build check-in
must never stop the agent from syncing replays.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Optional

from ..state import AgentState, save_state
from .controller import BuildCheckinController
from .view import BuildCheckinView

_log = logging.getLogger("sc2tools_agent.build_checkin")


def build_checkin_view_for(gui: Any) -> Optional[BuildCheckinView]:
    """The GUI's check-in view, when it offers one.

    ``GuiUI.build_checkin_view()`` returns the object implementing
    :class:`~.view.BuildCheckinView`; without it the controller keeps
    running on a no-op view. It is called on the boot worker thread, so
    it must only hand back a signal-forwarding adapter and leave widget
    creation to the GUI thread (the same goes for ``bind_controller``).
    """
    factory = getattr(gui, "build_checkin_view", None)
    if not callable(factory):
        return None
    try:
        return factory()
    except Exception:  # noqa: BLE001
        _log.exception("build_checkin_view_unavailable")
        return None


def web_queue_url(dashboard_url: str) -> str:
    """Where the tray item goes when no card is waiting."""
    return dashboard_url.rstrip("/") + "/app"


def start_build_checkin(
    *,
    api: Any,
    bus: Any,
    state: AgentState,
    state_dir: Path,
    dashboard_url: str,
    view: Optional[BuildCheckinView] = None,
) -> Optional[BuildCheckinController]:
    """Construct the controller, subscribe it to ``bus`` and start it."""

    def remember_intro_dismissed() -> None:
        state.build_checkin_intro_seen = True
        save_state(state_dir, state)

    try:
        controller = BuildCheckinController(
            api=api,
            view=view,
            intro_seen=state.build_checkin_intro_seen,
            on_intro_dismissed=remember_intro_dismissed,
            web_queue_url=web_queue_url(dashboard_url),
        )
        bind = getattr(view, "bind_controller", None)
        if callable(bind):
            bind(controller)
        controller.attach(bus)
        controller.start()
    except Exception:  # noqa: BLE001
        _log.exception("build_checkin_start_failed")
        return None
    return controller


__all__ = [
    "build_checkin_view_for",
    "start_build_checkin",
    "web_queue_url",
]
