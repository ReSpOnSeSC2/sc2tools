"""The surface the build check-in controller paints through.

The Qt layer implements :class:`BuildCheckinView`. The controller calls
it from its own state thread, so an implementation must hand every call
to the GUI thread (``GuiUI`` signals) and return immediately; it must
never block or call back into the controller synchronously.

Calls arrive only while they are current: the controller checks that a
loading card still belongs to the live game and that a post-game card
still owns the window before each ``show_*`` / ``update_*``. A view may
still drop a call whose ``game_key`` / ``card_id`` it no longer shows.

Player actions go back through the controller's public methods
(``declare``, ``undeclare``, ``roll_now``, ``not_now``, ``confirm``,
``no_set_build``, ``later``, ``interacted``, ``update_draft``,
``disable``, ``dismiss_intro``, ``reopen``, ``set_prefs``). They are
thread-safe and non-blocking.

Optional hooks a view may also provide:

* ``bind_controller(controller)`` — called once when the view is
  attached, so the window can route its buttons to the controller.
* ``update_prefs(prefs: CheckinPrefs)`` — the cloud preference changed
  (fetched, saved, or a failed save reverted); keeps the Settings
  checkboxes in sync.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from .models import LoadingCardModel, PostgameCardModel

# Why a card was hidden. Views may use these to pick an animation.
HIDE_IN_GAME = "in_game"
HIDE_MATCH_ENDED = "match_ended"
HIDE_MENU = "menu"
HIDE_NEW_GAME = "new_game"
HIDE_RANDOM = "random"
HIDE_NOT_1V1 = "not_1v1"
HIDE_DISMISSED = "dismissed"
HIDE_DISABLED = "disabled"
HIDE_TIMEOUT = "timeout"
HIDE_CONFIRMED = "confirmed"
HIDE_SKIPPED = "skipped"
HIDE_LATER = "later"
HIDE_PREEMPTED = "preempted"
HIDE_DECIDED = "decided_elsewhere"
HIDE_NOT_ELIGIBLE = "not_eligible"
HIDE_REPLACED = "replaced"


@runtime_checkable
class BuildCheckinView(Protocol):
    def show_loading(self, model: LoadingCardModel) -> None:
        """Show the loading card (never activating the window)."""

    def update_loading(self, model: LoadingCardModel) -> None:
        """Repaint the visible loading card for ``model.game_key``."""

    def hide_loading(self, game_key: str, reason: str) -> None:
        """Hide the loading card for ``game_key``."""

    def show_postgame(self, model: PostgameCardModel) -> None:
        """Show (or bring back) the end card ``model.card_id``."""

    def update_postgame(self, model: PostgameCardModel) -> None:
        """Repaint the visible end card ``model.card_id``."""

    def hide_postgame(self, card_id: str, reason: str) -> None:
        """Hide the end card ``card_id``."""


class NullView:
    """Paints nothing. Used until the Qt layer attaches a real view, so
    the controller keeps its state (and the server keeps its records)
    even when no window can be shown."""

    def show_loading(self, model: LoadingCardModel) -> None:
        return None

    def update_loading(self, model: LoadingCardModel) -> None:
        return None

    def hide_loading(self, game_key: str, reason: str) -> None:
        return None

    def show_postgame(self, model: PostgameCardModel) -> None:
        return None

    def update_postgame(self, model: PostgameCardModel) -> None:
        return None

    def hide_postgame(self, card_id: str, reason: str) -> None:
        return None


__all__ = [
    "BuildCheckinView",
    "HIDE_CONFIRMED",
    "HIDE_DECIDED",
    "HIDE_DISABLED",
    "HIDE_DISMISSED",
    "HIDE_IN_GAME",
    "HIDE_LATER",
    "HIDE_MATCH_ENDED",
    "HIDE_MENU",
    "HIDE_NEW_GAME",
    "HIDE_NOT_1V1",
    "HIDE_NOT_ELIGIBLE",
    "HIDE_PREEMPTED",
    "HIDE_RANDOM",
    "HIDE_REPLACED",
    "HIDE_SKIPPED",
    "HIDE_TIMEOUT",
    "NullView",
]
