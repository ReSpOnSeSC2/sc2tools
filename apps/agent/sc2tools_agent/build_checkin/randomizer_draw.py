"""The loading card's still of a Randomizer draw.

The saved build comes from the server, as everywhere else. The opening
Gateway units are not saved: the OBS widget draws them in the browser
from a seed made of the matchup and the game key (``RandomizerWidget.tsx``
and ``lib/randomizer/engine.ts``). Rolling again here would show a
different pair than the stream, so this module repeats the widget's
seeded draw exactly, once per game and build. ``tests/test_randomizer_draw.py``
and the web engine tests pin both sides to the same fixture,
``apps/web/lib/randomizer/__tests__/unitDrawParity.json``.

The widget draws from the pool as the overlay serves it, not as it is
stored: ``overlay_config`` repeats that step (``overlayRandomizerConfig.js``).
Only the parts of the widget's spin that decide the units are repeated:
the build pick and the reveal style each take one value from the seeded
generator before the units, whatever they pick, so they are skipped.
"""

from __future__ import annotations

import logging
import math
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

_log = logging.getLogger(__name__)

GATEWAY_UNITS = ("zealot", "stalker", "sentry", "adept")
UNIT_NAMES = {"zealot": "Zealot", "stalker": "Stalker", "sentry": "Sentry", "adept": "Adept"}
FIRST_STEPS = 4
"""How many of the build's steps the card lists."""
CUSTOM_PREFIX = "custom:"
VALUES_BEFORE_UNITS = 2
"""The widget's build pick and reveal style, in that order."""
READ_ATTEMPTS = 2
"""A failed read is tried again on the next card update, once."""

MAX_POOL = 500
"""The overlay serves no pool from a longer stored list."""
RACES = {"P": "Protoss", "T": "Terran", "Z": "Zerg"}

_UINT32 = 0xFFFFFFFF
JS_SPACE = "\t\n\x0b\x0c\r " + "".join(map(chr, (
    0xA0, 0x1680, *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
)))
"""What JavaScript's ``\\s`` matches and ``trim()`` removes; Python's sets differ."""
# inferGatewayCount in lib/randomizer/gatewayUnits.ts. JavaScript's \b and
# case folding are ASCII; its \s is the wider JS_SPACE.
_GATE_COUNT = re.compile(
    r"(?:^|\b)([12])[{0}]*[- ]?[{0}]*gate(?:way)?s?\b".format(JS_SPACE), re.IGNORECASE | re.ASCII,
)


@dataclass(frozen=True)
class DrawKey:
    """One game's saved pick."""

    game_key: str
    matchup: str
    build_key: str

    @property
    def custom_slug(self) -> Optional[str]:
        """The custom build's slug; catalog builds have no steps to read."""
        if self.build_key.startswith(CUSTOM_PREFIX):
            return self.build_key[len(CUSTOM_PREFIX):] or None
        return None

    @property
    def can_show_more(self) -> bool:
        """Units exist for Protoss only and steps for custom builds only."""
        return self.matchup.startswith("P") or self.custom_slug is not None


@dataclass(frozen=True)
class DrawStep:
    """One build step as the build stores it; unknown parts stay unknown."""

    action: str
    time: Optional[str] = None
    supply: Optional[str] = None


@dataclass(frozen=True)
class RandomizerDraw:
    """What the card shows under one game's saved pick."""

    game_key: str
    build_key: str
    steps: Tuple[DrawStep, ...] = ()
    units: Tuple[str, ...] = ()
    """Display names, one per Gateway, in Gateway order."""

    @property
    def empty(self) -> bool:
        return not self.steps and not self.units


# ---------------------------------------------------------------- seeded draw


def seed_from_string(value: str) -> int:
    """FNV-1a over UTF-16 code units, as ``seedFromString`` hashes."""
    seed = 0x811C9DC5
    data = value.encode("utf-16-le")
    for index in range(0, len(data), 2):
        seed = ((seed ^ int.from_bytes(data[index:index + 2], "little")) * 0x01000193) & _UINT32
    return seed


def _imul(left: int, right: int) -> int:
    return (left * right) & _UINT32


def mulberry32(seed: int) -> Callable[[], float]:
    """The widget's generator, value for value."""
    state = seed & _UINT32

    def next_value() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _UINT32
        mixed = _imul(state ^ (state >> 15), 1 | state)
        mixed = ((mixed + _imul(mixed ^ (mixed >> 7), 61 | mixed)) & _UINT32) ^ mixed
        return (mixed ^ (mixed >> 14)) / 4294967296

    return next_value


def pick_index(probabilities: Sequence[float], rng: Callable[[], float]) -> int:
    roll = rng()
    cumulative = 0.0
    for index, probability in enumerate(probabilities):
        cumulative += probability
        if roll < cumulative:
            return index
    return len(probabilities) - 1


def normalize(weights: Sequence[float]) -> List[float]:
    """Sums left to right like the engine's ``reduce``; ``sum`` would compensate."""
    total = 0.0
    for weight in weights:
        total += max(weight, 0.0)
    if total <= 0:
        return [1 / len(weights)] * len(weights)
    return [max(weight, 0.0) / total for weight in weights]


# ------------------------------------------- the saved config, as the widget reads it


def _number(raw: Dict[str, Any], key: str) -> float:
    """``Number(raw[key])`` for the JSON values a saved weight holds.

    The web settings always save numbers; any string counts as not a number.
    """
    if key not in raw:
        return math.nan
    value = raw[key]
    if value is None:
        return 0.0
    return float(value) if isinstance(value, (bool, int, float)) else math.nan


def _is_protoss(race: Any) -> bool:
    """``coerceRace(race) === "Protoss"``."""
    text = race.strip(JS_SPACE) if isinstance(race, str) else ""
    return bool(text) and text[0].upper() == "P"


def infer_gate_count(matchup: str, build_name: str) -> int:
    explicit = _GATE_COUNT.search(build_name)
    if explicit is not None:
        return int(explicit.group(1))
    return 2 if matchup == "PvP" else 1


def _selected_units(raw_units: Any) -> List[Tuple[str, float]]:
    """Selected units in canonical order; a later duplicate wins."""
    if not isinstance(raw_units, list):
        return [(unit, 1.0) for unit in GATEWAY_UNITS]
    weights: Dict[str, float] = {}
    for unit in raw_units:
        if not isinstance(unit, dict) or not isinstance(unit.get("id"), str):
            continue
        unit_id = unit["id"].lower()
        if unit_id in GATEWAY_UNITS:
            weight = _number(unit, "weight")
            weights[unit_id] = weight if math.isfinite(weight) and weight >= 0 else 1.0
    return [(unit, weights[unit]) for unit in GATEWAY_UNITS if unit in weights]


def _pool_entry(matchup_config: Dict[str, Any], build_key: str) -> Optional[Dict[str, Any]]:
    """The pool entry the widget keeps for ``build_key``: the last named one."""
    builds = matchup_config.get("builds")
    entry = None
    for build in builds if isinstance(builds, list) else ():
        named = isinstance(build, dict) and isinstance(build.get("name"), str) and build["name"].strip(JS_SPACE)
        if named and build.get("id") == build_key:
            entry = build
    return entry


def _gate_count(opening: Dict[str, Any], matchup: str, build_name: str) -> int:
    gates = opening.get("gateCount")
    if type(gates) in (int, float) and gates in (1, 2):
        return int(gates)
    return infer_gate_count(matchup, build_name)


def _field(value: Any, key: str) -> Any:
    """``value[key]`` when ``value`` is an object, else nothing."""
    return value.get(key) if isinstance(value, dict) else None


def _offered_builds(options: Any) -> Dict[str, Dict[str, Any]]:
    """The account's builds by key (``GET /v1/build-intents/options``); a later duplicate wins."""
    rows = _field(options, "builds")
    return {
        row["key"]: row for row in (rows if isinstance(rows, list) else ())
        if isinstance(row, dict) and isinstance(row.get("key"), str)
    }


def overlay_config(config: Any, matchup: str, options: Any) -> Any:
    """``config`` as the overlay serves it to the widget (``overlayRandomizerConfig.js``).

    In an enabled matchup each pool entry the account still offers takes the
    build's current name and source and the matchup's race; an entry no
    longer offered is dropped.
    """
    matchups = _field(config, "matchups")
    pool = _field(matchups, matchup)
    if not isinstance(pool, dict) or pool.get("enabled") is not True:
        return config
    offered = _offered_builds(options)
    builds = pool.get("builds")
    served = [
        {**build, "name": offered[build["id"]].get("name"), "source": offered[build["id"]].get("source"),
         "race": RACES[matchup[0]]}
        for build in (builds if isinstance(builds, list) and len(builds) <= MAX_POOL else ())
        if isinstance(build, dict) and isinstance(build.get("id"), str) and build["id"] in offered
    ]
    return {**config, "matchups": {**matchups, matchup: {**pool, "builds": served}}}


def _drawn_entry(config: Any, key: DrawKey) -> Optional[Dict[str, Any]]:
    """The pool entry whose units the widget draws for ``key``, if it draws any."""
    matchup_config = _field(_field(config, "matchups"), key.matchup)
    if not key.matchup.startswith("P") or not isinstance(matchup_config, dict):
        return None
    if matchup_config.get("enabled") is not True or matchup_config.get("unitRandomizerEnabled") is False:
        return None
    entry = _pool_entry(matchup_config, key.build_key)
    return entry if entry is not None and _is_protoss(entry.get("race")) else None


def opening_units(config: Any, key: DrawKey) -> Tuple[str, ...]:
    """The unit ids the widget reveals for ``key``, one per Gateway."""
    entry = _drawn_entry(config, key)
    opening = entry.get("openingUnits") if entry is not None else None
    opening = opening if isinstance(opening, dict) else {}
    pool = _selected_units(opening.get("units")) if entry is not None else []
    if not pool:
        return ()
    custom = opening.get("useCustomWeights") is True
    probabilities = normalize([weight if custom else 1.0 for _unit, weight in pool])
    rng = mulberry32(seed_from_string(f"{key.matchup}:{key.game_key}"))
    for _ in range(VALUES_BEFORE_UNITS):
        rng()
    gates = _gate_count(opening, key.matchup, entry["name"].strip(JS_SPACE))
    return tuple(pool[pick_index(probabilities, rng)][0] for _ in range(gates))


# ----------------------------------------------------------------- build steps


def _clock(value: Any) -> Optional[str]:
    if isinstance(value, str):
        return value.strip() or None
    if type(value) in (int, float) and math.isfinite(value) and value >= 0:
        seconds = int(value)
        return f"{seconds // 60}:{seconds % 60:02d}"
    return None


def _supply(value: Any, approximate: bool) -> Optional[str]:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return None
    return ("\N{ALMOST EQUAL TO}" if approximate else "") + f"{value:g}"


def _step(row: Any) -> Optional[DrawStep]:
    action = row.get("action") if isinstance(row, dict) else None
    if not isinstance(action, str) or not action.strip():
        return None
    return DrawStep(
        action=action.strip(),
        time=_clock(row["t"] if "t" in row else row.get("time")),
        supply=_supply(row.get("supply"), row.get("supplyApprox") is True),
    )


def first_steps(build: Any) -> Tuple[DrawStep, ...]:
    """A custom build's first steps: its reference build order, else its
    older step list (``GET /v1/custom-builds/:slug``)."""
    if not isinstance(build, dict):
        return ()
    order = build.get("buildOrder")
    rows = order.get("steps") if isinstance(order, dict) else None
    if not isinstance(rows, list) or not rows:
        rows = build.get("steps")
    steps: List[DrawStep] = []
    for row in rows if isinstance(rows, list) else ():
        step = _step(row)
        if step is not None:
            steps.append(step)
        if len(steps) == FIRST_STEPS:
            break
    return tuple(steps)


def draw_for(key: DrawKey, answer: Dict[str, Any]) -> RandomizerDraw:
    """The still for ``key`` from a ``randomizer_draw`` Companion answer."""
    served = overlay_config(answer.get("config"), key.matchup, answer.get("options"))
    return RandomizerDraw(
        game_key=key.game_key,
        build_key=key.build_key,
        steps=first_steps(answer.get("build")),
        units=tuple(UNIT_NAMES[unit] for unit in opening_units(served, key)),
    )


def draw_key(model: Any) -> Optional[DrawKey]:
    """The saved pick a loading card model shows, if it shows one."""
    strip = getattr(model, "randomizer", None)
    rolled = getattr(strip, "rolled_key", None)
    if not rolled or not getattr(model, "matchup", None):
        return None
    return DrawKey(game_key=model.game_key, matchup=model.matchup, build_key=rolled)


# ---------------------------------------------------------------------- reading


def _start_daemon(work: Callable[[], None]) -> None:
    threading.Thread(target=work, name="checkin-randomizer-draw", daemon=True).start()


class RandomizerDrawSource:
    """Reads what one game's draw needs, once, off the caller's thread.

    ``fetch`` is ``CompanionClient.action``. Only the newest saved pick is
    kept: a card shows one game at a time, and a reroll is a new pick.
    """

    def __init__(self, fetch: Callable[[Dict[str, Any]], Any], *,
                 start: Callable[[Callable[[], None]], None] = _start_daemon) -> None:
        self._fetch = fetch
        self._start = start
        self._lock = threading.Lock()
        self._key: Optional[DrawKey] = None
        self._attempts = 0
        self._reading = False
        self._read = False

    def request(self, model: Any, deliver: Callable[[RandomizerDraw], None]) -> None:
        """Start the read for ``model``'s saved pick unless it ran already."""
        key = draw_key(model)
        if key is None or not key.can_show_more:
            return
        with self._lock:
            if key != self._key:
                self._key, self._attempts, self._reading, self._read = key, 0, False, False
            if self._reading or self._read or self._attempts >= READ_ATTEMPTS:
                return
            self._reading = True
            self._attempts += 1
        self._start(lambda: self._resolve(key, deliver))

    def _resolve(self, key: DrawKey, deliver: Callable[[RandomizerDraw], None]) -> None:
        try:
            answer = self._fetch({"action": "randomizer_draw", "matchup": key.matchup, "customSlug": key.custom_slug})
        except Exception as error:  # noqa: BLE001 - the card keeps its build name
            _log.info("randomizer_draw_read_failed matchup=%s reason=%s", key.matchup, error)
            answer = None
        draw = draw_for(key, answer) if isinstance(answer, dict) else None
        with self._lock:
            current = key == self._key
            if current:
                self._reading = False
                self._read = draw is not None
        if current and draw is not None and not draw.empty:
            deliver(draw)
