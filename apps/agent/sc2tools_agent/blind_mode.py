"""Pure policy and geometry for a local SC2 identity shield.

The desktop controller owns windows, polling, hotkeys and monitor geometry.
This module consumes *fresh* raw localhost responses; failed requests must be
passed as ``None``, never silently replaced with cached successful responses.

The baseline rectangles are conservative 16:9 starting points, NOT verified
coverage for every SC2 layout. Calibration is necessary for panels, score and
chat protection. Even faster polling cannot guarantee first-frame coverage;
pre-armed, calibrated panels are the protection before ScreenLoading arrives.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
import math
from numbers import Real
from typing import Any, Optional


def _finite_number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, Real):
        return None
    try:
        number = float(value)
    except (ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


@dataclass(frozen=True)
class NormalizedRect:
    """An opaque rectangle relative to the SC2 *client area*, in [0, 1]."""

    x: float
    y: float
    width: float
    height: float

    def __post_init__(self) -> None:
        for name in ("x", "y", "width", "height"):
            value = getattr(self, name)
            number = _finite_number(value)
            if number is None:
                raise ValueError(f"{name} must be a finite number")
            object.__setattr__(self, name, number)
        if self.x < 0 or self.y < 0 or self.width <= 0 or self.height <= 0:
            raise ValueError("rectangle position must be nonnegative and size positive")
        if self.x + self.width > 1.0 + 1e-9 or self.y + self.height > 1.0 + 1e-9:
            raise ValueError("rectangle must fit inside the normalized client area")

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> "NormalizedRect":
        if not isinstance(raw, Mapping):
            raise ValueError("rectangle must be an object")
        try:
            return cls(*(raw[name] for name in ("x", "y", "width", "height")))
        except KeyError as exc:
            raise ValueError(f"rectangle is missing {exc.args[0]}") from exc

    def to_dict(self) -> dict[str, float]:
        return {name: getattr(self, name) for name in ("x", "y", "width", "height")}


# Approximate player-card bounds observed on a native 16:9 1v1 loading screen.
# A native full curtain is the default during confirmed loading, so protection
# then does not depend on these estimates. Calibration remains mandatory.
DEFAULT_LOADING_MASKS = (
    NormalizedRect(0.065, 0.27, 0.26, 0.30),
    NormalizedRect(0.675, 0.27, 0.26, 0.30),
)
# Start around the central chat/input area above the HUD, keeping the minimap
# and top-right player panel free. Incoming-chat bounds must be calibrated.
DEFAULT_CHAT_MASKS = (NormalizedRect(0.22, 0.50, 0.56, 0.29),)
DEFAULT_SCORE_MASKS = (NormalizedRect(0.12, 0.12, 0.76, 0.78),)
MAX_MASKS_PER_GROUP = 8


@dataclass(frozen=True)
class BlindModeConfig:
    enabled: bool = False
    loading_style: str = "curtain"
    loading_masks: tuple[NormalizedRect, ...] = DEFAULT_LOADING_MASKS
    chat_masks: tuple[NormalizedRect, ...] = DEFAULT_CHAT_MASKS
    score_masks: tuple[NormalizedRect, ...] = DEFAULT_SCORE_MASKS
    # After a previously confirmed loading screen loses /ui, do not leave a
    # whole-window curtain over potentially live gameplay indefinitely.
    # Downgrade to panels; this is NOT a timeout on a healthy long load.
    max_curtain_seconds: float = 1.5
    borderless_confirmed: bool = False
    calibrated_aspect_ratio: Optional[float] = None
    coverage_verified: bool = False

    def __post_init__(self) -> None:
        for name in ("enabled", "borderless_confirmed", "coverage_verified"):
            if not isinstance(getattr(self, name), bool):
                raise ValueError(f"{name} must be a boolean")
        if self.loading_style not in ("curtain", "panels"):
            raise ValueError("loading_style must be curtain or panels")
        for name in ("loading_masks", "chat_masks", "score_masks"):
            value = getattr(self, name)
            if not isinstance(value, (list, tuple)) or not all(
                isinstance(rect, NormalizedRect) for rect in value
            ):
                raise ValueError(f"{name} must contain NormalizedRect values")
            if not 1 <= len(value) <= MAX_MASKS_PER_GROUP:
                raise ValueError(f"{name} must contain between 1 and {MAX_MASKS_PER_GROUP} rectangles")
            object.__setattr__(self, name, tuple(value))
        seconds = _finite_number(self.max_curtain_seconds)
        if seconds is None or not 0.1 <= seconds <= 60.0:
            raise ValueError("max_curtain_seconds must be between 0.1 and 60")
        object.__setattr__(self, "max_curtain_seconds", seconds)
        if self.calibrated_aspect_ratio is not None:
            aspect = _finite_number(self.calibrated_aspect_ratio)
            if aspect is None or not 0.5 <= aspect <= 4.0:
                raise ValueError("calibrated_aspect_ratio must be between 0.5 and 4")
            object.__setattr__(self, "calibrated_aspect_ratio", aspect)

    @classmethod
    def from_dict(cls, raw: Optional[Mapping[str, Any]]) -> "BlindModeConfig":
        """Validate persisted settings. Omitted fields use safe defaults.

        ``enabled`` is optional for applications persisting their main toggle
        separately. Unknown keys are ignored for forward compatibility.
        Malformed known fields raise ValueError; callers may restore defaults.
        """
        if raw is None:
            return cls()
        if not isinstance(raw, Mapping):
            raise ValueError("blind mode config must be an object")
        fields: dict[str, Any] = {}
        for name in (
            "enabled", "loading_style", "max_curtain_seconds", "borderless_confirmed",
            "calibrated_aspect_ratio", "coverage_verified",
        ):
            if name in raw:
                fields[name] = raw[name]
        for name in ("loading_masks", "chat_masks", "score_masks"):
            if name in raw:
                if not isinstance(raw[name], (list, tuple)):
                    raise ValueError(f"{name} must be a list")
                fields[name] = tuple(NormalizedRect.from_dict(rect) for rect in raw[name])
        return cls(**fields)

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "loading_style": self.loading_style,
            "loading_masks": [rect.to_dict() for rect in self.loading_masks],
            "chat_masks": [rect.to_dict() for rect in self.chat_masks],
            "score_masks": [rect.to_dict() for rect in self.score_masks],
            "max_curtain_seconds": self.max_curtain_seconds,
            "borderless_confirmed": self.borderless_confirmed,
            "calibrated_aspect_ratio": self.calibrated_aspect_ratio,
            "coverage_verified": self.coverage_verified,
        }


@dataclass(frozen=True)
class BlindModeSnapshot:
    mode: str
    masks: tuple[NormalizedRect, ...]
    curtain: bool
    opponent_race: Optional[str]
    status: str


# Confirm the actual native gameplay view, rather than trusting displayTime
# from a potentially stale /game response. This also tolerates a single empty
# activeScreens response in the loading transition. The native API is not an
# atomic rendering signal: this confirmation is a practical bound, not a
# promise of zero exposed frames.
GAMEPLAY_CONFIRM_SECONDS = 0.15
_MENU_SCREENS = frozenset({
    "ScreenHome", "ScreenScore", "ScreenUserProfile", "ScreenMenu",
    "ScreenSingleplayer", "ScreenMultiplayer", "ScreenLogin",
})
_RACES = {
    "t": "Terran", "terr": "Terran", "terran": "Terran",
    "p": "Protoss", "prot": "Protoss", "protoss": "Protoss",
    "z": "Zerg", "zerg": "Zerg",
    "r": "Random", "rand": "Random", "random": "Random",
}


class BlindModePolicy:
    """Single-threaded shield state machine; no network or GUI dependencies.

    ``update`` is called once per detector sample with a monotonic timestamp.
    ScreenLoading outranks every /game field, including a previous game's
    timer, decided result, or replay flag. Race is accepted only from a
    zero-time, undecided two-human loading snapshot and a unique local name
    match (exact normalized name first; unambiguous BattleTag stem second).
    Its value is latched for that match, including Random.
    """

    def __init__(
        self,
        config: Optional[BlindModeConfig] = None,
        user_name_hint: Optional[str] = None,
    ) -> None:
        self.config = config or BlindModeConfig()
        self._user_name_hint = user_name_hint
        self._loading_active = False
        self._last_loading_at: Optional[float] = None
        self._gameplay_candidate_at: Optional[float] = None
        self._gameplay_confirmed = False
        self._race: Optional[str] = None
        self._race_capture_blocked = False
        self._snapshot = BlindModeSnapshot("off", (), False, None, "Blind mode off")

    @property
    def snapshot(self) -> BlindModeSnapshot:
        return self._snapshot

    def set_config(self, config: BlindModeConfig) -> None:
        if not isinstance(config, BlindModeConfig):
            raise ValueError("config must be a BlindModeConfig")
        if config.enabled != self.config.enabled:
            self._reset_match()
        self.config = config
        if not config.enabled:
            self._snapshot = BlindModeSnapshot("off", (), False, None, "Blind mode off")

    def set_user_name_hint(self, name: Optional[str]) -> None:
        if name != self._user_name_hint:
            # A previously resolved race must not survive changing accounts.
            if self._loading_active and self._race is not None:
                self._race_capture_blocked = True
            self._race = None
        self._user_name_hint = name

    def update(
        self,
        ui: Optional[Mapping[str, Any]],
        game: Optional[Mapping[str, Any]],
        now: float,
    ) -> BlindModeSnapshot:
        timestamp = _finite_number(now)
        if timestamp is None:
            raise ValueError("now must be a finite monotonic timestamp")
        now = timestamp
        if not self.config.enabled:
            self._reset_match()
            return self._publish("off", (), False, "Blind mode off")

        screens = normalized_ui_screens(ui)
        if screens is None:
            return self._unavailable(now)

        if "ScreenLoading" in screens:
            if not self._loading_active:
                self._race = None
                self._race_capture_blocked = False
            self._loading_active = True
            self._last_loading_at = now
            self._gameplay_candidate_at = None
            self._gameplay_confirmed = False
            if self._race is None and not self._race_capture_blocked:
                self._race = _loading_opponent_race(game, self._user_name_hint)
            return self._publish(
                "loading", self.config.loading_masks,
                self.config.loading_style == "curtain", "Loading screen protected",
            )

        if any(screen in _MENU_SCREENS for screen in screens):
            self._reset_match()
            score = "ScreenScore" in screens
            masks = _combine(self.config.loading_masks, self.config.score_masks) if score \
                else self.config.loading_masks
            return self._publish(
                "armed", masks, False,
                "Score screen protected" if score else "Armed — loading panels active",
            )

        # An empty activeScreens list is the game's native gameplay view.
        # ForegroundScreen can sit over an already-confirmed game (options,
        # alerts). Unknown screens never become evidence for removing a mask.
        gameplay_view = not screens or (
            self._gameplay_confirmed and all(s == "ForegroundScreen" for s in screens)
        )
        if not gameplay_view:
            return self._unavailable(now)

        if not self._gameplay_confirmed:
            if self._gameplay_candidate_at is None:
                self._gameplay_candidate_at = now
            if now - self._gameplay_candidate_at < GAMEPLAY_CONFIRM_SECONDS:
                return self._publish(
                    "loading" if self._loading_active else "armed",
                    self.config.loading_masks,
                    self._loading_active and self.config.loading_style == "curtain"
                    and self._last_loading_at is not None
                    and now - self._last_loading_at < self.config.max_curtain_seconds,
                    "Confirming game view",
                )
            self._gameplay_confirmed = True
            self._loading_active = False
            self._last_loading_at = None

        if isinstance(game, Mapping) and game.get("isReplay") is True:
            self._race = None
            return self._publish("replay", (), False, "Replay — shield released")
        return self._publish("playing", self.config.chat_masks, False, "Game view — chat protected")

    def _unavailable(self, now: float) -> BlindModeSnapshot:
        self._gameplay_candidate_at = None
        if self._gameplay_confirmed:
            # Losing the API during gameplay must not cover the battlefield
            # with pre-queue or result panels. Keep the known chat cover and
            # disclose the loading-protection limitation until /ui recovers.
            return self._publish(
                "unavailable", self.config.chat_masks, False,
                "SC2 state unavailable — chat protected; loading protection unavailable",
            )
        curtain = (
            self._loading_active
            and self.config.loading_style == "curtain"
            and self._last_loading_at is not None
            and now - self._last_loading_at < self.config.max_curtain_seconds
        )
        if self._last_loading_at is not None and now - self._last_loading_at >= self.config.max_curtain_seconds:
            # The client may have closed and reopened into a different match.
            # Retain protection, but never reuse the previous loading's race.
            self._race = None
            # Nor can a later response during this uncertain loading episode
            # replace Random with its now-resolved actual race. Wait for a
            # definite boundary before collecting another loading race.
            self._race_capture_blocked = True
        return self._publish(
            "unavailable",
            _combine(self.config.loading_masks, self.config.chat_masks),
            curtain,
            "SC2 state unavailable — curtain active" if curtain
            else "SC2 state unavailable — loading and chat panels only",
        )

    def _reset_match(self) -> None:
        self._loading_active = False
        self._last_loading_at = None
        self._gameplay_candidate_at = None
        self._gameplay_confirmed = False
        self._race = None
        self._race_capture_blocked = False

    def _publish(
        self, mode: str, masks: tuple[NormalizedRect, ...], curtain: bool, status: str,
    ) -> BlindModeSnapshot:
        self._snapshot = BlindModeSnapshot(mode, masks, curtain, self._race, status)
        return self._snapshot


def _combine(*groups: tuple[NormalizedRect, ...]) -> tuple[NormalizedRect, ...]:
    return tuple(dict.fromkeys(rect for group in groups for rect in group))


def normalized_ui_screens(ui: Optional[Mapping[str, Any]]) -> Optional[tuple[str, ...]]:
    """Read raw /ui, accepting known terminal components in native paths.

    SC2 consumers have observed ``ScreenLoading/ScreenLoading`` in addition
    to ``ScreenLoading``. Normalize only a known final component; an unknown
    child under ScreenLoading is not proof that loading itself is visible.
    Missing/malformed data stays None, distinct from the empty gameplay list.
    """
    if not isinstance(ui, Mapping):
        return None
    screens = ui.get("activeScreens")
    if not isinstance(screens, list) or not all(isinstance(screen, str) for screen in screens):
        return None
    known = _MENU_SCREENS | {"ScreenLoading", "ForegroundScreen"}
    normalized = []
    for screen in screens:
        terminal = screen.rstrip("/").rsplit("/", 1)[-1]
        normalized.append(terminal if terminal in known else screen)
    return tuple(normalized)


def _loading_opponent_race(
    game: Optional[Mapping[str, Any]], user_name_hint: Optional[str],
) -> Optional[str]:
    if not isinstance(game, Mapping) or not isinstance(user_name_hint, str) or not user_name_hint.strip() \
            or game.get("isReplay") is not False:
        return None
    if _finite_number(game.get("displayTime")) != 0:
        return None
    players = game.get("players")
    if not isinstance(players, list) or len(players) != 2:
        return None
    if not all(
        isinstance(player, Mapping)
        and player.get("type") == "user"
        and player.get("result") == "Undecided"
        and isinstance(player.get("name"), str)
        for player in players
    ):
        return None
    local_name = _normalise_player_name(user_name_hint)
    matches = [
        index for index, player in enumerate(players)
        if _normalise_player_name(player["name"]) == local_name
    ]
    if not matches:
        local_stem = _battle_tag_stem(user_name_hint)
        matches = [
            index for index, player in enumerate(players)
            if _battle_tag_stem(player["name"]) == local_stem
        ]
    if len(matches) != 1:
        return None
    race = players[1 - matches[0]].get("race")
    return _RACES.get(race.strip().casefold()) if isinstance(race, str) else None


def _normalise_player_name(value: str) -> str:
    """Match existing live-client name rules without a first-player fallback."""
    normalized = value.strip()
    if normalized.startswith("[") and "]" in normalized:
        without_clan = normalized.split("]", 1)[1].strip()
        if without_clan:
            normalized = without_clan
    return normalized.casefold()


def _battle_tag_stem(value: str) -> str:
    normalized = _normalise_player_name(value)
    stem, separator, suffix = normalized.rpartition("#")
    return stem if separator and stem and suffix.isdigit() else normalized


__all__ = [
    "BlindModeConfig", "BlindModePolicy", "BlindModeSnapshot", "NormalizedRect",
    "DEFAULT_LOADING_MASKS", "DEFAULT_CHAT_MASKS", "DEFAULT_SCORE_MASKS",
    "GAMEPLAY_CONFIRM_SECONDS",
    "MAX_MASKS_PER_GROUP",
    "normalized_ui_screens",
]
