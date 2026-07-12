"""Typed data classes for the Live Game Bridge.

These shapes are the contract between the three independent layers:

* ``client_api.LiveClientPoller`` produces ``LiveUIState`` /
  ``LiveGameState`` snapshots from Blizzard's local HTTP API and
  collapses them into ``LiveLifecycleEvent`` transitions.
* ``pulse_lookup.PulseClient`` produces ``OpponentProfile`` records
  for a given opponent name + region.
* ``bridge.LiveBridge`` fuses both into the outbound payload that
  ``transport`` ships to the overlay backend and the cloud.

Why dataclasses (not Pydantic): the agent already uses ``dataclass``
across ``config.py``, ``api_client.py``, etc. Adding Pydantic for one
module would bloat the PyInstaller bundle by ~6 MB without buying us
anything the stdlib doesn't already provide for these shapes —
they're flat, validated at the boundary by ``client_api``/
``pulse_lookup``, and serialised via ``dataclasses.asdict`` for the
cloud upload + Socket.io emit.
"""

from __future__ import annotations

import dataclasses
import enum
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


_CANONICAL_LIVE_RACES = {
    "p": "Protoss",
    "prot": "Protoss",
    "protoss": "Protoss",
    "t": "Terran",
    "terr": "Terran",
    "terran": "Terran",
    "z": "Zerg",
    "zerg": "Zerg",
    "r": "Random",
    "rand": "Random",
    "random": "Random",
}


def normalise_live_race(value: Optional[str]) -> Optional[str]:
    """Return a canonical race only when the local API supplied one.

    Blizzard uses ``?`` while a race is unavailable, varies the casing
    of ``random``, and reports truncated forms such as ``Rand`` in some
    locales. Unknown or missing values remain ``None`` so they cannot
    create a false per-game Random latch.
    """
    if not isinstance(value, str):
        return None
    return _CANONICAL_LIVE_RACES.get(value.strip().casefold())


def _normalise_player_name(value: str) -> str:
    """Normalize case/spacing and one leading SC2 clan-tag prefix."""
    normalised = value.strip()
    if normalised.startswith("[") and "]" in normalised:
        without_clan_tag = normalised.split("]", 1)[1].strip()
        if without_clan_tag:
            normalised = without_clan_tag
    return normalised.casefold()


def _battle_tag_stem(value: str) -> str:
    """Strip a numeric BattleTag suffix without doing fuzzy matching."""
    normalised = _normalise_player_name(value)
    stem, separator, suffix = normalised.rpartition("#")
    if separator and stem and suffix.isdigit():
        return stem
    return normalised


def _unique_player_name_match(
    players: List["LivePlayer"],
    name: Optional[str],
) -> Optional["LivePlayer"]:
    if not name or not name.strip():
        return None

    normalised = _normalise_player_name(name)
    exact = [
        player for player in players
        if player.name and _normalise_player_name(player.name) == normalised
    ]
    if len(exact) == 1:
        return exact[0]

    # The configured handle and /game player name do not always both
    # include the ``#1234`` suffix. Accept a stem match only when it is
    # unique so two same-name players can never be silently swapped.
    stem = _battle_tag_stem(name)
    stem_matches = [
        player for player in players
        if player.name and _battle_tag_stem(player.name) == stem
    ]
    if len(stem_matches) == 1:
        return stem_matches[0]
    return None


class LiveLifecyclePhase(str, enum.Enum):
    """Coalesced lifecycle phases the bridge consumes.

    These are the *transitions* the bridge cares about — distinct from
    the raw ``/ui`` activeScreen strings, which include UI states like
    ``ScreenUserProfile`` that aren't relevant to widget rendering.
    """

    # SC2 client is unreachable (not running, or localhost:6119 refused).
    # The bridge stays quiet and the overlay shows nothing.
    IDLE = "idle"
    # In a menu / non-game screen. The widgets clear and wait.
    MENU = "menu"
    # The loading screen between picking a match and seeing the map. We
    # already know the opponent name + race from /game at this point —
    # this is the earliest we can pre-populate widgets, and the prompt
    # specifically calls out that they need to render BEFORE the game.
    MATCH_LOADING = "match_loading"
    # Loading finished, in-game with a non-zero displayTime. Widgets
    # show full data and persist throughout the match.
    MATCH_STARTED = "match_started"
    # Periodic in-match tick. Same payload as MATCH_STARTED but with
    # an updated displayTime so time-aware widgets (build-order
    # milestones, supply timers) can render against the live clock.
    MATCH_IN_PROGRESS = "match_in_progress"
    # The /game endpoint reported a non-Undecided result for the user's
    # player. Widgets enter their post-match state, and the bridge
    # waits for the replay file to land so the post-game pipeline can
    # supersede the live record.
    MATCH_ENDED = "match_ended"


@dataclass(frozen=True)
class LiveUIState:
    """Snapshot of ``GET /ui`` from the SC2 client.

    Blizzard's localhost API exposes a list of activeScreens, e.g.
    ``["ScreenLoading"]`` or ``["ScreenScore"]`` or ``[]`` (in-game).
    We model the raw screens for diagnostics + a derived
    ``is_in_match`` flag so callers don't have to re-parse.
    """

    active_screens: List[str] = field(default_factory=list)
    captured_at: float = field(default_factory=time.time)

    @property
    def is_loading(self) -> bool:
        return any(s == "ScreenLoading" for s in self.active_screens)

    @property
    def is_in_match(self) -> bool:
        # Blizzard reports an empty activeScreens list when the player
        # is in the actual gameplay view. ``ScreenLoading`` is also
        # in-match-adjacent but we keep it distinct so the bridge can
        # emit MATCH_LOADING separately from MATCH_STARTED.
        if not self.active_screens:
            return True
        # ``ForegroundScreen`` shows up over the gameplay view (e.g.
        # alerts, options menu mid-game). The match is still running
        # underneath, so treat it as in-match — the displayTime ticking
        # in /game is the authoritative signal.
        non_match_screens = {
            "ScreenHome",
            "ScreenLoading",
            "ScreenScore",
            "ScreenUserProfile",
            "ScreenMenu",
            "ScreenSingleplayer",
            "ScreenMultiplayer",
            "ScreenLogin",
        }
        return not any(s in non_match_screens for s in self.active_screens)


@dataclass(frozen=True)
class LivePlayer:
    """One entry from ``GET /game`` players[]."""

    name: str
    type: str  # "user" | "computer"
    race: str  # "Zerg" | "Protoss" | "Terran" | "random"/"?"
    result: str  # "Undecided" | "Victory" | "Defeat" | "Tie"
    player_id: Optional[int] = None

    @property
    def is_user(self) -> bool:
        return self.type == "user"

    @property
    def is_decided(self) -> bool:
        return self.result not in ("Undecided", "")


@dataclass(frozen=True)
class LiveGameState:
    """Snapshot of ``GET /game``.

    ``display_time`` is seconds elapsed in the game (faster than wall
    clock — SC2 uses Faster game speed by default which compresses
    real time by ~1.4x). Widgets that show "in-game time" use this
    directly; widgets that show wall-clock duration multiply by 1.4.

    ``is_replay`` is true when the user is watching a replay rather
    than playing live. The bridge ignores replay sessions so the
    overlay doesn't show "scouting" widgets while the streamer
    reviews a vod.
    """

    display_time: float = 0.0
    is_replay: bool = False
    players: List[LivePlayer] = field(default_factory=list)
    captured_at: float = field(default_factory=time.time)

    def user_for(self, user_name: Optional[str]) -> Optional[LivePlayer]:
        """Pick the local human player without guessing in team games.

        Prefer a unique display-name or BattleTag-stem match. Blizzard
        lists the local player first in 1v1 ``/game`` responses, so index
        zero is a safe last resort only when at most two humans exist.
        """
        humans = [player for player in self.players if player.is_user]
        matched = _unique_player_name_match(humans, user_name)
        if matched is not None:
            return matched
        if 1 <= len(humans) <= 2:
            return humans[0]
        return None

    def opponent_for(self, user_name: Optional[str]) -> Optional[LivePlayer]:
        """Pick the other human player in a 1v1 game.

        Reuse :meth:`user_for` so local-player and opponent selection
        cannot disagree when Blizzard reverses player order. Ambiguous
        team games remain unresolved instead of choosing a random rival.
        """
        humans = [p for p in self.players if p.is_user]
        if len(humans) != 2:
            return None
        user = self.user_for(user_name)
        if user is not None:
            return humans[1] if humans[0] is user else humans[0]
        return None

    @property
    def is_decided(self) -> bool:
        """``True`` when at least one ``user`` player has a non-Undecided
        result. Blizzard flips both players to Victory/Defeat at the
        same moment, so checking any player is sufficient."""
        return any(p.is_user and p.is_decided for p in self.players)


@dataclass(frozen=True)
class LiveLifecycleEvent:
    """Coalesced transition the bridge / transports consume.

    ``game_state`` is included for ``MATCH_LOADING`` /
    ``MATCH_STARTED`` / ``MATCH_IN_PROGRESS`` / ``MATCH_ENDED`` so the
    bridge can derive opponent name + race + game time without
    re-querying the poller.
    """

    phase: LiveLifecyclePhase
    captured_at: float = field(default_factory=time.time)
    ui_state: Optional[LiveUIState] = None
    game_state: Optional[LiveGameState] = None
    # Stable per-game identifier so the cloud can stitch live updates
    # to the post-game replay record. We synthesise it from
    # ``(player names sorted, match_started_at_ms)`` because Blizzard's
    # local API doesn't expose a gameId until the replay is parsed —
    # post-game we reconcile the two.
    game_key: Optional[str] = None


@dataclass(frozen=True)
class OpponentProfile:
    """Resolved SC2Pulse profile for the in-game opponent.

    Every field except ``name`` is optional so partial-failure paths
    (Pulse 502, ambiguous name, region miss) still surface a useful
    record. ``confidence`` lets the widget render a small "best guess"
    hint when we had to pick between multiple candidates.
    """

    name: str
    pulse_character_id: Optional[int] = None
    region: Optional[str] = None
    battle_tag: Optional[str] = None
    account_handle: Optional[str] = None
    mmr: Optional[int] = None
    league: Optional[str] = None
    league_tier: Optional[int] = None
    top_race: Optional[str] = None
    recent_games_count: Optional[int] = None
    confidence: float = 1.0
    # When confidence < 1.0 the widget can render a small disambiguation
    # hint listing the alternatives the resolver considered.
    alternatives: List[str] = field(default_factory=list)
    resolved_at: float = field(default_factory=time.time)


def to_jsonable(obj: Any) -> Any:
    """Recursively convert dataclasses (and enums) into JSON-safe dicts.

    Used by the transport layer when serialising payloads for the
    Socket.io emit and the cloud HTTP POST. Stdlib's
    ``dataclasses.asdict`` already handles nested dataclasses but
    leaves enum members as ``LiveLifecyclePhase.MATCH_LOADING``; we
    convert those to their ``.value`` strings so the receiver sees
    plain JSON tokens.
    """
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return to_jsonable(dataclasses.asdict(obj))
    if isinstance(obj, enum.Enum):
        return obj.value
    if isinstance(obj, dict):
        return {k: to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [to_jsonable(v) for v in obj]
    return obj


def envelope_for(event: LiveLifecycleEvent) -> Dict[str, Any]:
    """Wrap a lifecycle event in the on-the-wire shape the overlay
    backend and the cloud both consume.

    Shape — kept intentionally flat so widgets can read it without a
    schema lib::

        {
          "type": "liveGameState",
          "phase": "match_started",
          "capturedAt": 1717000000.123,
          "gameKey": "Player1234|Streamer#42|1717000000000",
          "displayTime": 12.5,
          "isReplay": false,
          "uiScreens": ["ForegroundScreen"],
          "players": [
            {"name": "Streamer#42", "type": "user", "race": "Zerg",
             "result": "Undecided"},
            {"name": "Player1234", "type": "user", "race": "Protoss",
             "result": "Undecided"}
          ]
        }
    """
    payload: Dict[str, Any] = {
        "type": "liveGameState",
        "phase": event.phase.value,
        "capturedAt": event.captured_at,
    }
    if event.game_key:
        payload["gameKey"] = event.game_key
    if event.game_state is not None:
        payload["displayTime"] = event.game_state.display_time
        payload["isReplay"] = event.game_state.is_replay
        payload["players"] = to_jsonable(event.game_state.players)
    if event.ui_state is not None:
        payload["uiScreens"] = list(event.ui_state.active_screens)
    return payload
