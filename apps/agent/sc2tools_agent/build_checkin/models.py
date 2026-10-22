"""Build check-in data: API parsers and the immutable card view models.

Two kinds of shapes live here:

* **API shapes** (``CheckinPrefs``, ``BuildRef``, ``BuildOption``,
  ``BuildOptions``, ``LiveState``, ``GameIntentState``) parsed from the
  ``/v1/build-intents`` and ``/v1/me/preferences/buildCheckin`` JSON by
  the ``parse_*`` helpers. Every parser is defensive: a malformed field
  falls back to its empty value and a malformed document returns
  ``None``, so a server bug can never crash the controller thread.
* **View models** (``LoadingCardModel``, ``PostgameCardModel`` and their
  parts). Frozen dataclasses that carry every string and flag the Qt
  layer needs to paint a card, so the window code stays a dumb renderer
  and all policy remains testable without Qt.

The copy below is the single source for card text. Server- and
user-authored strings (build names, opponent names, notes) must be
rendered as plain text, never as rich text.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

from ..live.types import normalise_live_race

NOTES_MAX_LENGTH = 1000
"""Same cap as the API's ``sanitizeNotes``."""

FEATURED_OPTIONS = 6
"""How many "Your builds" rows a card shows before **More builds…**."""

# ---------------------------------------------------------------- copy

LOADING_HEADING = "What's the plan?"
POSTGAME_HEADING = "Which build were you going for?"
NOTES_FIRST_HEADING = "What happened?"
INTRO_TEXT = (
    "New: tell us your plan — it counts toward that build's record "
    "even if the game goes sideways."
)
WAITING_FOR_MATCHUP = "Waiting for matchup…"
RANDOMIZER_WILL_ROLL = "🎲 Randomizer will roll — pick a build to skip it"
RANDOMIZER_ROLLING = "🎲 Rolling the randomizer…"
RANDOMIZER_ROLLED = "🎲 Randomizer: {name}"
LOCKED_IN = "Locked in: {name}"
PICKED_ON_WEB = "Picked on sc2tools.com: {name}"
CHECKING_REPLAY = "Checking your replay…"
DETECTED_LABEL = "Replay classified as: {name}"
NOTES_PLACEHOLDER = "What threw the build off? (optional)"
NOTES_FIRST_PROMPT = "You planned {planned} · replay looked like {detected}. What happened?"

STATUS_OPTIONS_FAILED = "Couldn't load your builds. We'll ask after the game."
STATUS_DECLARE_OFFLINE = (
    "Couldn't reach sc2tools.com. We'll confirm your pick after the game."
)
STATUS_DECLARE_UNAVAILABLE = "That build isn't available for this matchup."
STATUS_REPLAY_UNAVAILABLE = (
    "Couldn't check your replay. You can still pick a build."
)
STATUS_SAVE_FAILED = "Couldn't save. Check your connection and try again."
STATUS_SAVE_UNKNOWN_BUILD = "That build isn't available for this game. Pick another."

REASON_LABELS: Mapping[str, str] = {
    "declared": "Your pick at loading",
    "randomizer": "Randomizer roll",
    "detected": "Detected in your replay",
    "rules": "Closest rule match",
    "usual": "Your usual build",
}

RESULT_TONES: Mapping[str, str] = {
    "Victory": "success",
    "Defeat": "danger",
}

# --------------------------------------------------------------- helpers

_RACE_LETTER = {"Protoss": "P", "Terran": "T", "Zerg": "Z"}
_CONCRETE_RACES = tuple(_RACE_LETTER)
_LEADING_CLAN_TAG_RE = re.compile(r"^\s*\[[^\]]*\]\s*")
_TRAILING_DISCRIMINATOR_RE = re.compile(r"#\d+$")
_MATCHUP_RE = re.compile(r"^[PTZ]v[PTZ]$")
_STATUSES = frozenset({"none", "pending", "confirmed", "skipped"})


def canonical_race(value: Any) -> Optional[str]:
    """``Protoss`` | ``Terran`` | ``Zerg`` | ``Random`` | ``None``."""
    return normalise_live_race(value) if isinstance(value, str) else None


def is_concrete_race(race: Optional[str]) -> bool:
    return race in _CONCRETE_RACES


def matchup_for(my_race: Optional[str], opp_race: Optional[str]) -> Optional[str]:
    """``PvZ`` when both races are concrete, else ``None`` (Random counts
    as unknown: the replay decides the real matchup)."""
    mine = _RACE_LETTER.get(my_race or "")
    theirs = _RACE_LETTER.get(opp_race or "")
    return f"{mine}v{theirs}" if mine and theirs else None


def matchups_for_race(race: Optional[str]) -> Tuple[str, ...]:
    """Every matchup a concrete race can play (prefetch targets)."""
    mine = _RACE_LETTER.get(race or "")
    if not mine:
        return ()
    return tuple(f"{mine}v{other}" for other in "PTZ")


def normalize_player_name(value: Any) -> str:
    """The API's ``normalizePlayerName``: NFC, one leading ``[TAG]`` and a
    trailing ``#1234`` stripped, trimmed, lowercased. ``""`` if blank."""
    if not isinstance(value, str):
        return ""
    name = unicodedata.normalize("NFC", value)
    name = _LEADING_CLAN_TAG_RE.sub("", name, count=1).strip()
    return _TRAILING_DISCRIMINATOR_RE.sub("", name).strip().lower()


def iso_to_ms(value: Any) -> Optional[int]:
    """Epoch milliseconds of an ISO-8601 timestamp (``Z`` allowed)."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def game_key_ms(game_key: str) -> Optional[int]:
    """The wall-clock ms the agent stamped on a live ``gameKey``."""
    tail = game_key.rsplit("|", 1)[-1] if "|" in game_key else ""
    return int(tail) if tail.isdigit() else None


def sanitize_notes(value: Any) -> str:
    """Bound a notes draft locally; the API applies the full sanitiser."""
    return value[:NOTES_MAX_LENGTH] if isinstance(value, str) else ""


def format_record(wins: int, losses: int, games: int) -> str:
    """``7–5`` (en dash) for a played build, ``""`` for an unplayed one."""
    return f"{wins}–{losses}" if games > 0 else ""


def _str(raw: Mapping[str, Any], key: str) -> Optional[str]:
    value = raw.get(key)
    return value if isinstance(value, str) and value else None


def _int(raw: Mapping[str, Any], key: str) -> int:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    return max(0, int(value))


def _opt_int(raw: Mapping[str, Any], key: str) -> Optional[int]:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return int(value)


def _matchup(raw: Mapping[str, Any]) -> Optional[str]:
    value = _str(raw, "matchup")
    return value if value and _MATCHUP_RE.match(value) else None


# ------------------------------------------------------------ API shapes


@dataclass(frozen=True)
class CheckinPrefs:
    """``users.preferences.buildCheckin``; every flag defaults to on."""

    enabled: bool = True
    ask_at_loading: bool = True
    ask_after_game: bool = True

    @property
    def loading_cards(self) -> bool:
        return self.enabled and self.ask_at_loading

    @property
    def postgame_cards(self) -> bool:
        return self.enabled and self.ask_after_game

    def to_json(self) -> Dict[str, bool]:
        return {
            "enabled": self.enabled,
            "askAtLoading": self.ask_at_loading,
            "askAfterGame": self.ask_after_game,
        }


def parse_prefs(raw: Any) -> Optional[CheckinPrefs]:
    """Missing flags are on, matching the API's sanitiser."""
    if not isinstance(raw, dict):
        return None
    return CheckinPrefs(
        enabled=raw.get("enabled") is not False,
        ask_at_loading=raw.get("askAtLoading") is not False,
        ask_after_game=raw.get("askAfterGame") is not False,
    )


@dataclass(frozen=True)
class BuildRef:
    """A build as the API names it. ``key`` is the stable identity
    (catalog slug or ``custom:<slug>``)."""

    key: str
    name: str
    slug: Optional[str] = None
    source: str = "catalog"
    deleted: bool = False


def parse_build_ref(raw: Any) -> Optional[BuildRef]:
    if not isinstance(raw, dict):
        return None
    key = _str(raw, "key")
    name = _str(raw, "name")
    if not key or not name:
        return None
    return BuildRef(
        key=key,
        name=name,
        slug=_str(raw, "slug"),
        source="custom" if raw.get("source") == "custom" else "catalog",
        deleted=raw.get("deleted") is True,
    )


@dataclass(frozen=True)
class Suggestion:
    build: BuildRef
    reason: Optional[str]
    passed_rules: Optional[int] = None
    rule_count: Optional[int] = None


def parse_suggestion(raw: Any) -> Optional[Suggestion]:
    build = parse_build_ref(raw)
    if build is None:
        return None
    reason = raw.get("reason")
    return Suggestion(
        build=build,
        reason=reason if reason in REASON_LABELS else None,
        passed_rules=_opt_int(raw, "passedRules"),
        rule_count=_opt_int(raw, "ruleCount"),
    )


@dataclass(frozen=True)
class BuildOption:
    """One row of ``GET /v1/build-intents/options``."""

    key: str
    name: str
    slug: Optional[str] = None
    source: str = "catalog"
    games: int = 0
    wins: int = 0
    losses: int = 0
    checkins: int = 0
    last_played_at: Optional[str] = None
    in_randomizer: bool = False
    group: str = "catalog"
    rule_count: Optional[int] = None

    @property
    def ref(self) -> BuildRef:
        return BuildRef(key=self.key, name=self.name, slug=self.slug, source=self.source)


def parse_build_option(raw: Any) -> Optional[BuildOption]:
    ref = parse_build_ref(raw)
    if ref is None:
        return None
    return BuildOption(
        key=ref.key,
        name=ref.name,
        slug=ref.slug,
        source=ref.source,
        games=_int(raw, "games"),
        wins=_int(raw, "wins"),
        losses=_int(raw, "losses"),
        checkins=_int(raw, "checkins"),
        last_played_at=_str(raw, "lastPlayedAt"),
        in_randomizer=raw.get("inRandomizer") is True,
        group="yours" if raw.get("group") == "yours" else "catalog",
        rule_count=_opt_int(raw, "ruleCount"),
    )


def parse_build_options_list(raw: Any) -> Tuple[BuildOption, ...]:
    """Options in server order, first occurrence of each key kept."""
    if not isinstance(raw, list):
        return ()
    seen: set[str] = set()
    out: List[BuildOption] = []
    for item in raw:
        option = parse_build_option(item)
        if option is not None and option.key not in seen:
            seen.add(option.key)
            out.append(option)
    return tuple(out)


@dataclass(frozen=True)
class BuildOptions:
    """The pickable builds for one matchup plus the matchup's markers."""

    matchup: Optional[str]
    builds: Tuple[BuildOption, ...] = ()
    usual_key: Optional[str] = None
    randomizer_enabled: bool = False

    def find(self, key: Optional[str]) -> Optional[BuildOption]:
        if not key:
            return None
        return next((option for option in self.builds if option.key == key), None)


def parse_build_options(raw: Any) -> Optional[BuildOptions]:
    if not isinstance(raw, dict):
        return None
    return BuildOptions(
        matchup=_matchup(raw),
        builds=parse_build_options_list(raw.get("builds")),
        usual_key=_str(raw, "usualKey"),
        randomizer_enabled=raw.get("randomizerEnabled") is True,
    )


@dataclass(frozen=True)
class LiveState:
    """``LiveState`` from ``GET``/``PUT /v1/build-intents/live/:gameKey``."""

    game_key: str
    matchup: Optional[str] = None
    my_race: Optional[str] = None
    opp_race: Optional[str] = None
    declared: Optional[BuildRef] = None
    declared_via: Optional[str] = None
    randomizer: Optional[BuildRef] = None
    randomizer_enabled: bool = False
    hold_remaining_ms: int = 0
    game_id: Optional[str] = None
    prefs: Optional[CheckinPrefs] = None


def parse_live_state(raw: Any, game_key: str) -> Optional[LiveState]:
    if not isinstance(raw, dict):
        return None
    declared_raw = raw.get("declared")
    via = declared_raw.get("via") if isinstance(declared_raw, dict) else None
    return LiveState(
        game_key=game_key,
        matchup=_matchup(raw),
        my_race=canonical_race(raw.get("myRace")),
        opp_race=canonical_race(raw.get("oppRace")),
        declared=parse_build_ref(declared_raw),
        declared_via=via if via in ("agent", "web") else None,
        randomizer=parse_build_ref(raw.get("randomizer")),
        randomizer_enabled=raw.get("randomizerEnabled") is True,
        hold_remaining_ms=_int(raw, "holdRemainingMs"),
        game_id=_str(raw, "gameId"),
        prefs=parse_prefs(raw.get("prefs")),
    )


@dataclass(frozen=True)
class GameIntentState:
    """``GameIntentState`` from ``/v1/games/:gameId/build-intent``."""

    game_id: str
    status: str = "none"
    eligible: bool = False
    ineligible_reason: Optional[str] = None
    matchup: Optional[str] = None
    my_race: Optional[str] = None
    opp_race: Optional[str] = None
    opp_name: Optional[str] = None
    result: Optional[str] = None
    applied: bool = False
    build: Optional[BuildRef] = None
    suggestion: Optional[Suggestion] = None
    randomizer: Optional[BuildRef] = None
    randomizer_deviated: bool = False
    detected_name: Optional[str] = None
    detected_key: Optional[str] = None
    executed: bool = False
    notes: str = ""
    origin: Optional[str] = None
    via: Optional[str] = None
    prefs: Optional[CheckinPrefs] = None
    options: Optional[BuildOptions] = None


def parse_game_intent(raw: Any, game_id: str) -> Optional[GameIntentState]:
    if not isinstance(raw, dict):
        return None
    status = raw.get("status")
    detected = raw.get("detected") if isinstance(raw.get("detected"), dict) else {}
    matchup = _matchup(raw)
    options: Optional[BuildOptions] = None
    if isinstance(raw.get("options"), list):
        options = BuildOptions(
            matchup=matchup,
            builds=parse_build_options_list(raw.get("options")),
            usual_key=_str(raw, "usualKey"),
        )
    return GameIntentState(
        game_id=game_id,
        status=status if status in _STATUSES else "none",
        eligible=raw.get("eligible") is True,
        ineligible_reason=_str(raw, "ineligibleReason"),
        matchup=matchup,
        my_race=canonical_race(raw.get("myRace")),
        opp_race=canonical_race(raw.get("oppRace")),
        opp_name=_str(raw, "oppName"),
        result=_str(raw, "result"),
        applied=raw.get("applied") is True,
        build=parse_build_ref(raw.get("build")),
        suggestion=parse_suggestion(raw.get("suggestion")),
        randomizer=parse_build_ref(raw.get("randomizer")),
        randomizer_deviated=raw.get("randomizerDeviated") is True,
        detected_name=_str(detected, "name"),
        detected_key=_str(detected, "key"),
        executed=raw.get("executed") is True,
        notes=sanitize_notes(raw.get("notes")),
        origin=_str(raw, "origin"),
        via=_str(raw, "via"),
        prefs=parse_prefs(raw.get("prefs")),
        options=options,
    )


# ----------------------------------------------------------- view models


@dataclass(frozen=True)
class BuildOptionModel:
    """One pickable row, identical on the loading and the end card."""

    key: str
    name: str
    source: str
    group: str
    record: str
    """``7–5`` or ``""`` for a build without games in this matchup."""
    games: int = 0
    wins: int = 0
    losses: int = 0
    checkins: int = 0
    in_randomizer: bool = False
    rolled: bool = False
    """Show the "Rolled" chip: the randomizer picked this build."""
    usual: bool = False
    """Show the "Usual" mark: the most-played build of the matchup."""
    suggested: bool = False
    """The server's suggestion for this game (end card)."""

    @property
    def accessible_name(self) -> str:
        """Row text for assistive technology."""
        parts = [self.name]
        if self.games:
            parts.append(f"{self.wins} wins, {self.losses} losses")
        if self.rolled:
            parts.append("rolled by the randomizer")
        if self.usual:
            parts.append("your usual build")
        return ", ".join(parts)


@dataclass(frozen=True)
class RandomizerStripModel:
    label: str
    rolled_key: Optional[str] = None
    rolled_name: Optional[str] = None
    can_roll_now: bool = False
    """Show **Roll now** (releases the hold so the widget spins)."""


@dataclass(frozen=True)
class LoadingCardModel:
    """The "What's the plan?" card shown during the loading screen.

    The window never takes focus and has no text input. Rows in
    ``featured`` / ``more`` never reorder for one ``game_key``.

    Actions: a row → ``declare(game_key, key)``; **Change** →
    ``undeclare``; **Roll now** → ``roll_now``; **Not now** →
    ``not_now``; "Don't ask at loading" → ``disable("loading")``; the
    intro's close → ``dismiss_intro()``.
    """

    game_key: str
    heading: str = LOADING_HEADING
    title: str = ""
    """``PvZ · vs Foo`` (``vs Foo`` while the matchup is unknown)."""
    matchup: Optional[str] = None
    opponent_name: Optional[str] = None
    waiting_for_matchup: bool = True
    waiting_label: str = WAITING_FOR_MATCHUP
    options_loading: bool = False
    featured: Tuple[BuildOptionModel, ...] = ()
    more: Tuple[BuildOptionModel, ...] = ()
    randomizer: Optional[RandomizerStripModel] = None
    collapsed: bool = False
    """Slim bar: ``locked_label`` (+ **Change** when ``can_change``)."""
    locked_label: Optional[str] = None
    locked_key: Optional[str] = None
    declared_elsewhere: bool = False
    can_change: bool = False
    show_intro: bool = False
    intro_text: str = INTRO_TEXT
    status: str = ""
    saving: bool = False


@dataclass(frozen=True)
class PostgameCardModel:
    """The end-of-game card.

    ``variant == "full"``: "Which build were you going for?" with the
    build list, search, notes, **Confirm** / **No set build** / **Later**.
    ``variant == "notes_first"``: the build was declared at loading but
    the replay looked different; ``planned_name`` / ``detected_name``
    fill the prompt, with notes, **Change build** and **Done**.

    When ``touched`` is true the player has interacted with the card:
    the view keeps the selection and notes text its widgets hold and only
    refreshes the other fields.

    Actions: **Confirm** → ``confirm(card_id, key, notes)``; **Done**
    (notes-first) → ``confirm(card_id, selection, notes)``; **No set
    build** → ``no_set_build``; **Later** / Esc → ``later``; any click or
    keystroke → ``interacted``, and selection/notes edits →
    ``update_draft`` so a pre-empted card keeps them; "Turn off
    check-ins after games" → ``disable("postgame")``. Disable the
    buttons while ``busy``.
    """

    card_id: str
    game_key: Optional[str] = None
    game_id: Optional[str] = None
    variant: str = "full"
    heading: str = POSTGAME_HEADING
    title: str = ""
    """``Victory · PvZ · vs Foo``; the matchup is omitted until known."""
    result: Optional[str] = None
    result_tone: str = "neutral"
    """``success`` | ``danger`` | ``neutral``."""
    matchup: Optional[str] = None
    opponent_name: Optional[str] = None
    options_loading: bool = False
    featured: Tuple[BuildOptionModel, ...] = ()
    more: Tuple[BuildOptionModel, ...] = ()
    selection: Optional[str] = None
    reason: Optional[str] = None
    reason_label: Optional[str] = None
    detected_label: Optional[str] = None
    prompt: Optional[str] = None
    """Notes-first sentence (plain text; names are not marked up)."""
    planned_name: Optional[str] = None
    detected_name: Optional[str] = None
    randomizer_name: Optional[str] = None
    notes: str = ""
    notes_placeholder: str = NOTES_PLACEHOLDER
    notes_max: int = NOTES_MAX_LENGTH
    status: str = ""
    busy: bool = False
    touched: bool = False
    show_intro: bool = False
    intro_text: str = INTRO_TEXT


def option_models(
    options: Sequence[BuildOption],
    featured_keys: Iterable[str],
    *,
    rolled_key: Optional[str] = None,
    usual_key: Optional[str] = None,
    suggested_key: Optional[str] = None,
) -> Tuple[Tuple[BuildOptionModel, ...], Tuple[BuildOptionModel, ...]]:
    """Split ``options`` (already in display order) into featured/more."""
    featured_set = set(featured_keys)
    featured: List[BuildOptionModel] = []
    more: List[BuildOptionModel] = []
    for option in options:
        model = BuildOptionModel(
            key=option.key,
            name=option.name,
            source=option.source,
            group=option.group,
            record=format_record(option.wins, option.losses, option.games),
            games=option.games,
            wins=option.wins,
            losses=option.losses,
            checkins=option.checkins,
            in_randomizer=option.in_randomizer,
            rolled=option.key == rolled_key,
            usual=option.key == usual_key,
            suggested=option.key == suggested_key,
        )
        (featured if option.key in featured_set else more).append(model)
    return tuple(featured), tuple(more)


def default_featured_keys(options: Sequence[BuildOption]) -> Tuple[str, ...]:
    """The top "Your builds" rows, in server order."""
    return tuple(
        option.key for option in options if option.group == "yours"
    )[:FEATURED_OPTIONS]


@dataclass
class FrozenOptionRows:
    """Option rows whose order is fixed at first paint.

    Later option payloads refresh each row's record in place, append new
    keys at the end and keep rows that disappeared, so nothing moves
    under the player's cursor.
    """

    order: List[str] = field(default_factory=list)
    featured: Tuple[str, ...] = ()
    rows: Dict[str, BuildOption] = field(default_factory=dict)

    @property
    def painted(self) -> bool:
        return bool(self.order)

    def merge(self, options: Sequence[BuildOption]) -> None:
        if not self.order:
            self.featured = default_featured_keys(options)
        for option in options:
            if option.key not in self.rows:
                self.order.append(option.key)
            self.rows[option.key] = option

    def ordered(self) -> List[BuildOption]:
        return [self.rows[key] for key in self.order]

    def find(self, key: Optional[str]) -> Optional[BuildOption]:
        return self.rows.get(key) if key else None


def result_tone(result: Optional[str]) -> str:
    return RESULT_TONES.get(result or "", "neutral")


def reason_label(
    reason: Optional[str],
    *,
    passed_rules: Optional[int] = None,
    rule_count: Optional[int] = None,
) -> Optional[str]:
    if reason == "rules" and passed_rules is not None and rule_count:
        return f"Matched {passed_rules} of {rule_count} rules"
    return REASON_LABELS.get(reason or "")


def card_title(*parts: Optional[str]) -> str:
    """Join the present header parts with `` · ``."""
    return " · ".join(part for part in parts if part)


__all__ = [
    "BuildOption",
    "BuildOptionModel",
    "BuildOptions",
    "BuildRef",
    "CHECKING_REPLAY",
    "CheckinPrefs",
    "DETECTED_LABEL",
    "FEATURED_OPTIONS",
    "FrozenOptionRows",
    "GameIntentState",
    "INTRO_TEXT",
    "LOADING_HEADING",
    "LOCKED_IN",
    "NOTES_FIRST_PROMPT",
    "RANDOMIZER_ROLLED",
    "RANDOMIZER_ROLLING",
    "RANDOMIZER_WILL_ROLL",
    "REASON_LABELS",
    "STATUS_DECLARE_OFFLINE",
    "STATUS_DECLARE_UNAVAILABLE",
    "STATUS_OPTIONS_FAILED",
    "STATUS_REPLAY_UNAVAILABLE",
    "STATUS_SAVE_FAILED",
    "STATUS_SAVE_UNKNOWN_BUILD",
    "LiveState",
    "LoadingCardModel",
    "NOTES_FIRST_HEADING",
    "NOTES_MAX_LENGTH",
    "NOTES_PLACEHOLDER",
    "PICKED_ON_WEB",
    "POSTGAME_HEADING",
    "PostgameCardModel",
    "RandomizerStripModel",
    "Suggestion",
    "WAITING_FOR_MATCHUP",
    "canonical_race",
    "card_title",
    "default_featured_keys",
    "format_record",
    "game_key_ms",
    "is_concrete_race",
    "iso_to_ms",
    "matchup_for",
    "matchups_for_race",
    "normalize_player_name",
    "option_models",
    "parse_build_option",
    "parse_build_options",
    "parse_build_ref",
    "parse_game_intent",
    "parse_live_state",
    "parse_prefs",
    "parse_suggestion",
    "reason_label",
    "result_tone",
    "sanitize_notes",
]
