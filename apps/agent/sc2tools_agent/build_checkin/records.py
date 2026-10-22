"""Mutable records owned by the build check-in controller's state thread.

Nothing here is shared across threads: the controller creates, reads and
mutates these only from its single state thread, so they carry no locks.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Optional, Tuple

from .models import (
    BuildOptions,
    BuildRef,
    FrozenOptionRows,
    GameIntentState,
    LiveState,
    LoadingCardModel,
    PostgameCardModel,
    matchup_for,
)

ACTIVE_PHASES = frozenset({"match_loading", "match_started", "match_in_progress"})

# End-card variants.
FULL = "full"
NOTES_FIRST = "notes_first"

# End-card lifecycle.
CARD_HIDDEN = "hidden"
CARD_VISIBLE = "visible"
CARD_DONE = "done"


@dataclass
class LiveOp:
    """One write to ``PUT /v1/build-intents/live/:gameKey``."""

    action: str
    """``register`` | ``declare`` | ``undeclare`` | ``release``."""
    build_key: Optional[str] = None


@dataclass
class CardOp:
    """One write for an end card (game route, or the live route before
    the replay's gameId is known)."""

    action: str
    """``confirm`` | ``skip`` | ``notes`` | ``opponent``."""
    build_key: Optional[str] = None
    notes: Optional[str] = None
    final: bool = False
    """Close the card once this write lands."""
    send_opponent: bool = False
    """Carry ``opponentBuildKey`` (game route only)."""
    opponent_key: Optional[str] = None
    """The opponent's build to count; ``None`` restores the replay's label."""
    opponent_draft: Optional[Tuple[Optional[str]]] = None
    """``(opp_selection,)`` a non-final opponent write hands over: once it
    lands the row follows the server again, unless the player re-picked."""


@dataclass
class LoadingCard:
    shown_at: float
    visible: bool = True
    rows: FrozenOptionRows = field(default_factory=FrozenOptionRows)
    status: str = ""
    changing: bool = False
    """**Change** reopened the list; the pick stands until replaced."""
    model: Optional[LoadingCardModel] = None


@dataclass
class LiveGame:
    """One game the agent watched on the live bus, keyed by ``gameKey``."""

    game_key: str
    key_ms: Optional[int]
    seen_at: float
    phase: str = "match_loading"
    closed: bool = False
    """Left through menu/idle; later envelopes for this key are stale."""
    left_at: Optional[float] = None
    loading_seen: bool = False
    """This key showed its own loading screen (else: first seen mid-match)."""
    prev_key: Optional[str] = None
    """The game tracked just before this one."""
    carry_checked: bool = False
    display_time: float = 0.0
    one_v_one: Optional[bool] = None
    """From the last envelope that carried ``players``."""
    roster_complete: bool = False
    opp_name: Optional[str] = None
    opp_norm: Optional[str] = None
    user_name: Optional[str] = None
    my_race: Optional[str] = None
    opp_race: Optional[str] = None
    result: Optional[str] = None
    ended_at: Optional[float] = None
    game_id: Optional[str] = None

    live: Optional[LiveState] = None
    gen: int = 0
    live_applied_gen: int = 0
    live_read_inflight: bool = False
    live_refetch: bool = False

    declared: Optional[BuildRef] = None
    """This agent's own pick, remembered even when the server never got it."""
    declared_synced: bool = False
    declare_failed: bool = False
    resend_inflight: bool = False
    """A pick the declare never delivered is being sent after the game."""
    released: bool = False
    register_count: int = 0
    registered_with_matchup: bool = False
    ops: Deque[LiveOp] = field(default_factory=deque)
    op_inflight: Optional[LiveOp] = None

    loading: Optional[LoadingCard] = None
    card_id: Optional[str] = None

    @property
    def matchup(self) -> Optional[str]:
        return matchup_for(self.my_race, self.opp_race)

    @property
    def has_random(self) -> bool:
        return "Random" in (self.my_race, self.opp_race)

    @property
    def in_progress(self) -> bool:
        return not self.closed and self.phase in ACTIVE_PHASES

    @property
    def writing(self) -> bool:
        return self.op_inflight is not None or bool(self.ops)

    def human_1v1(self) -> Optional[bool]:
        """``True`` when this looks like 1v1 against a human."""
        if self.one_v_one is not None:
            return self.one_v_one
        return True if self.opp_name else None

    def identity_unresolvable(self) -> bool:
        """Every name is known yet the bridge could not tell us apart."""
        return self.roster_complete and not self.opp_name

    def next_gen(self) -> int:
        self.gen += 1
        return self.gen


@dataclass
class PostgameCard:
    """One end card. Survives being hidden so a draft is never lost."""

    card_id: str
    seq: int
    created_at: float
    game_key: Optional[str]
    opp_name: Optional[str] = None
    my_race: Optional[str] = None
    opp_race: Optional[str] = None
    result: Optional[str] = None
    local_declared: Optional[BuildRef] = None

    game_id: Optional[str] = None
    server: Optional[GameIntentState] = None
    variant: str = FULL
    state: str = CARD_HIDDEN
    rows: FrozenOptionRows = field(default_factory=FrozenOptionRows)

    selection: Optional[str] = None
    reason: Optional[str] = None
    passed_rules: Optional[int] = None
    rule_count: Optional[int] = None
    notes: str = ""
    notes_synced: Optional[str] = None
    """Notes the server holds, when known."""
    flush_pending: bool = False

    opp_rows: FrozenOptionRows = field(default_factory=FrozenOptionRows)
    opp_selection: Optional[str] = None
    opp_touched: bool = False
    """The player changed the opponent row; ``opp_selection`` holds it."""
    opp_base: Optional[Tuple[Optional[str]]] = None
    """``(key,)`` the server counted when the row was first changed."""
    opp_saved: Optional[Tuple[Optional[str]]] = None
    """``(opp_selection,)`` the server now holds while the card still shows
    it as a change; released when the card steps aside."""
    options_stale: bool = False
    """Builds may have changed on the web: refetch the lists with the
    next state read."""

    touched: bool = False
    reshows: int = 0
    reshow_pending: bool = False
    preempted_at: Optional[float] = None
    last_activity: float = 0.0
    status: str = ""
    awaiting_replay: bool = False
    state_fetching: bool = False
    busy: bool = False
    ops: Deque[CardOp] = field(default_factory=deque)
    op_inflight: Optional[CardOp] = None
    model: Optional[PostgameCardModel] = None

    @property
    def matchup(self) -> Optional[str]:
        if self.server is not None and self.server.matchup:
            return self.server.matchup
        return matchup_for(self.my_race, self.opp_race)

    @property
    def server_options(self) -> Optional[BuildOptions]:
        return self.server.options if self.server is not None else None

    @property
    def undecided(self) -> bool:
        return self.state != CARD_DONE


__all__ = [
    "ACTIVE_PHASES",
    "CARD_DONE",
    "CARD_HIDDEN",
    "CARD_VISIBLE",
    "CardOp",
    "FULL",
    "LiveGame",
    "LiveOp",
    "LoadingCard",
    "NOTES_FIRST",
    "PostgameCard",
]
