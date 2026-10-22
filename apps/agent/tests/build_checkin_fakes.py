"""Deterministic doubles for the build check-in controller tests.

``FakeCheckinApi`` mimics the contract's server semantics closely enough
for policy tests: live records keyed by gameKey (register / declare /
undeclare / release / postgame, ``already_bound`` once a gameId is set),
per-game states, options per matchup and the ``buildCheckin`` pref.
Failures are injected per method with :meth:`FakeCheckinApi.fail_next`.
"""

from __future__ import annotations

import json
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

from sc2tools_agent.api_client import ApiError
from sc2tools_agent.build_checkin.controller import BuildCheckinController
from sc2tools_agent.build_checkin.models import CheckinPrefs
from sc2tools_agent.replay_pipeline import CloudGame

WALL_START = 1_790_000_000.0
OPP = "Foo"
ME = "Me#123"


def api_error(status: int, code: str, **extra: Any) -> ApiError:
    return ApiError(status, json.dumps({"error": {"code": code, "message": code, **extra}}))


def option(
    key: str,
    name: Optional[str] = None,
    *,
    group: str = "yours",
    games: int = 0,
    wins: int = 0,
    losses: int = 0,
    in_randomizer: bool = False,
    source: str = "catalog",
) -> Dict[str, Any]:
    return {
        "key": key,
        "name": name or key.upper(),
        "slug": key.split(":", 1)[1] if key.startswith("custom:") else None,
        "source": source,
        "games": games,
        "wins": wins,
        "losses": losses,
        "checkins": 0,
        "lastPlayedAt": None,
        "inRandomizer": in_randomizer,
        "group": group,
    }


def options_payload(matchup: str, *builds: Dict[str, Any], usual: Optional[str] = None,
                    randomizer: bool = False) -> Dict[str, Any]:
    return {
        "matchup": matchup,
        "randomizerEnabled": randomizer,
        "usualKey": usual,
        "builds": list(builds),
    }


DEFAULT_OPTIONS = {
    "PvZ": options_payload(
        "PvZ",
        option("custom:dt-3-gate", "DT into 3 Gate", games=12, wins=7, losses=5,
               source="custom", in_randomizer=True),
        option("pvz-2-stargate-phoenix", "PvZ - 2 Stargate Phoenix", games=4, wins=3, losses=1),
        option("pvz-chargelot-all-in", "PvZ - Chargelot All-in", group="catalog"),
        usual="pvz-2-stargate-phoenix",
        randomizer=True,
    ),
}


OPP_OPTIONS = [
    option("zerg-12-pool", "Zerg - 12 Pool", games=3, wins=2, losses=1),
    option("custom:ling-flood", "Ling flood", source="custom"),
    option("zvp-roach-rush", "ZvP - Roach Rush", group="catalog"),
    option("zvp-ling-bane-bust", "ZvP - Ling Bane Bust", group="catalog"),
]


def opponent_state(
    *,
    label: Optional[str] = "Zerg - 12 Pool",
    detected: Optional[str] = "Zerg - 12 Pool",
    detected_key: Optional[str] = "zerg-12-pool",
    build: Optional[Dict[str, Any]] = None,
    options: Optional[List[Dict[str, Any]]] = None,
    suggestion: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """``GameIntentState.opponent``; ``build`` makes it a correction."""
    return {
        "label": build["name"] if build else label,
        "status": "confirmed" if build else "none",
        "build": build,
        "applied": build is not None,
        "detected": {"name": detected, "slug": None, "key": detected_key},
        "suggestion": suggestion,
        "executed": None,
        **({"options": options} if options is not None else {}),
    }


def game_state(
    game_id: str,
    *,
    status: str = "pending",
    eligible: bool = True,
    matchup: str = "PvZ",
    suggestion: Optional[Dict[str, Any]] = None,
    build: Optional[Dict[str, Any]] = None,
    executed: bool = False,
    origin: Optional[str] = None,
    detected: Optional[str] = "PvZ - Macro Transition (Unclassified)",
    notes: str = "",
    result: str = "Victory",
    options: Optional[List[Dict[str, Any]]] = None,
    randomizer: Optional[Dict[str, Any]] = None,
    prefs: Optional[Dict[str, Any]] = None,
    opponent: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    races = {"P": "Protoss", "T": "Terran", "Z": "Zerg"}
    return {
        "gameId": game_id,
        "matchup": matchup,
        "myRace": races[matchup[0]],
        "oppRace": races[matchup[2]],
        "result": result,
        "oppName": OPP,
        "eligible": eligible,
        "ineligibleReason": None if eligible else "too_short",
        "status": status,
        "applied": status == "confirmed",
        "build": build,
        "suggestion": suggestion,
        "randomizer": randomizer,
        "randomizerDeviated": False,
        "detected": {"name": detected, "slug": None, "key": None},
        "executed": executed,
        "notes": notes,
        "origin": origin,
        "via": None,
        "prefs": prefs or {"enabled": True, "askAtLoading": True, "askAfterGame": True},
        **({"options": options, "usualKey": None} if options is not None else {}),
        **({"opponent": opponent} if opponent is not None else {}),
    }


def suggestion(key: str, name: Optional[str] = None, reason: str = "detected") -> Dict[str, Any]:
    return {"key": key, "name": name or key.upper(), "slug": None, "source": "catalog",
            "reason": reason, "passedRules": None, "ruleCount": None}


@dataclass
class FakeCheckinApi:
    prefs: Dict[str, Any] = field(default_factory=lambda: {
        "enabled": True, "askAtLoading": True, "askAfterGame": True,
    })
    options: Dict[str, Dict[str, Any]] = field(default_factory=lambda: dict(DEFAULT_OPTIONS))
    live: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    games: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    calls: List[Tuple[str, Tuple[Any, ...], Dict[str, Any]]] = field(default_factory=list)
    failures: Dict[str, Deque[BaseException]] = field(default_factory=lambda: defaultdict(deque))
    randomizer_enabled: bool = True

    # ------------------------------------------------------------ helpers
    def fail_next(self, method: str, exc: BaseException, times: int = 1) -> None:
        for _ in range(times):
            self.failures[method].append(exc)

    def _enter(self, method: str, *args: Any, **kwargs: Any) -> None:
        self.calls.append((method, args, kwargs))
        queue = self.failures.get(method)
        if queue:
            raise queue.popleft()

    def calls_to(self, method: str) -> List[Tuple[Tuple[Any, ...], Dict[str, Any]]]:
        return [(args, kwargs) for name, args, kwargs in self.calls if name == method]

    def live_bodies(self) -> List[Dict[str, Any]]:
        return [args[1] for args, _ in self.calls_to("put_live_intent")]

    def live_actions(self) -> List[str]:
        return [body["action"] for body in self.live_bodies()]

    def _live_state(self, key: str) -> Dict[str, Any]:
        doc = self.live[key]
        return {
            "gameKey": key,
            "matchup": doc.get("matchup"),
            "myRace": doc.get("myRace"),
            "oppRace": doc.get("oppRace"),
            "oppName": doc.get("oppName"),
            "declared": doc.get("declared"),
            "randomizer": doc.get("randomizer"),
            "randomizerEnabled": self.randomizer_enabled,
            "holdRemainingMs": 0 if doc.get("released") else 6000,
            "gameId": doc.get("gameId"),
            "prefs": dict(self.prefs),
        }

    def _find(self, key: Optional[str]) -> Optional[Dict[str, Any]]:
        for payload in self.options.values():
            for build in payload["builds"]:
                if build["key"] == key:
                    return build
        return None

    # ---------------------------------------------------------------- API
    def get_checkin_prefs(self) -> Dict[str, Any]:
        self._enter("get_checkin_prefs")
        return dict(self.prefs)

    def put_checkin_prefs(self, prefs: Dict[str, Any]) -> Dict[str, Any]:
        self._enter("put_checkin_prefs", prefs)
        self.prefs = {key: prefs.get(key) is not False
                      for key in ("enabled", "askAtLoading", "askAfterGame")}
        return dict(self.prefs)

    def get_build_options(self, matchup: str) -> Dict[str, Any]:
        self._enter("get_build_options", matchup)
        return json.loads(json.dumps(self.options.get(matchup) or options_payload(matchup)))

    def put_live_intent(self, game_key: str, body: Dict[str, Any], *, attempts: int = 1) -> Dict[str, Any]:
        self._enter("put_live_intent", game_key, dict(body), attempts=attempts)
        doc = self.live.setdefault(game_key, {})
        if doc.get("gameId"):
            raise api_error(409, "already_bound", gameId=doc["gameId"])
        for field_name in ("myRace", "oppRace", "oppName"):
            if body.get(field_name) and not doc.get(field_name):
                doc[field_name] = body[field_name]
        letters = {"Protoss": "P", "Terran": "T", "Zerg": "Z"}
        if doc.get("myRace") in letters and doc.get("oppRace") in letters:
            doc["matchup"] = f"{letters[doc['myRace']]}v{letters[doc['oppRace']]}"
        action = body.get("action")
        if action == "declare":
            build = self._find(body.get("buildKey"))
            if build is None:
                raise api_error(400, "unknown_build")
            doc["declared"] = {**{k: build[k] for k in ("key", "name", "slug", "source")}, "via": "agent"}
            doc["released"] = True
        elif action == "undeclare":
            doc["declared"] = None
        elif action == "release":
            doc["released"] = True
        elif action == "postgame":
            doc["postgame"] = dict(body)
        return self._live_state(game_key)

    def get_live_intent(self, game_key: str) -> Dict[str, Any]:
        self._enter("get_live_intent", game_key)
        if game_key not in self.live:
            raise api_error(404, "not_found")
        return self._live_state(game_key)

    def get_game_intent(self, game_id: str, *, include_options: bool = False) -> Dict[str, Any]:
        self._enter("get_game_intent", game_id, include_options=include_options)
        if game_id not in self.games:
            raise api_error(404, "not_found")
        state = json.loads(json.dumps(self.games[game_id]))
        if not include_options:
            state.pop("options", None)
            if isinstance(state.get("opponent"), dict):
                state["opponent"].pop("options", None)
        return state

    def put_game_intent(self, game_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
        self._enter("put_game_intent", game_id, dict(body))
        state = self.games.setdefault(game_id, game_state(game_id))
        action = body.get("action")
        if "opponentBuildKey" in body:
            self._set_opponent(state, body["opponentBuildKey"])
        if action == "confirm":
            build = self._find(body.get("buildKey"))
            if build is None:
                raise api_error(400, "unknown_build")
            state.update(status="confirmed", build=build, origin="postgame")
        elif action == "skip":
            state.update(status="skipped", build=None)
        if "notes" in body:
            state["notes"] = body["notes"]
        return dict(state)

    def _set_opponent(self, state: Dict[str, Any], key: Optional[str]) -> None:
        opp = state.get("opponent")
        if not isinstance(opp, dict):
            raise api_error(409, "not_eligible", reason="no_matchup")
        detected = opp.get("detected") or {}
        if key is None or key == detected.get("key"):
            opp.update(build=None, applied=False, status="none", label=detected.get("name"))
            return
        build = next((b for b in opp.get("options") or OPP_OPTIONS if b["key"] == key), None)
        if build is None:
            raise api_error(400, "unknown_opponent_build")
        opp.update(build={k: build[k] for k in ("key", "name", "slug", "source")},
                   applied=True, status="confirmed", label=build["name"])


class FakeView:
    def __init__(self) -> None:
        self.calls: List[Tuple[str, Any]] = []
        self.prefs: List[Any] = []

    def show_loading(self, model): self.calls.append(("show_loading", model))
    def update_loading(self, model): self.calls.append(("update_loading", model))
    def hide_loading(self, game_key, reason): self.calls.append(("hide_loading", (game_key, reason)))
    def show_postgame(self, model): self.calls.append(("show_postgame", model))
    def update_postgame(self, model): self.calls.append(("update_postgame", model))
    def hide_postgame(self, card_id, reason): self.calls.append(("hide_postgame", (card_id, reason)))
    def update_prefs(self, prefs): self.prefs.append(prefs)

    def names(self) -> List[str]:
        return [name for name, _ in self.calls]

    def last(self, *names: str) -> Any:
        for name, payload in reversed(self.calls):
            if name in names:
                return payload
        raise AssertionError(f"no view call among {names}: {self.names()}")

    def of(self, name: str) -> List[Any]:
        return [payload for call, payload in self.calls if call == name]

    def clear(self) -> None:
        self.calls.clear()


class SyncExecutor:
    """Runs every job immediately; results still go through the inbox."""

    def submit(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
        fn(*args, **kwargs)


class ManualExecutor:
    """Holds jobs until the test releases them, in any order."""

    def __init__(self) -> None:
        self.jobs: List[Callable[[], Any]] = []

    def submit(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
        self.jobs.append(lambda: fn(*args, **kwargs))

    def run(self, index: int = 0) -> None:
        self.jobs.pop(index)()

    def run_all(self) -> None:
        while self.jobs:
            self.run(0)


class Clock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def players(
    *,
    me: Tuple[str, str] = (ME, "Prot"),
    opp: Tuple[str, str] = (OPP, "Zerg"),
    result: Tuple[str, str] = ("Undecided", "Undecided"),
) -> List[Dict[str, Any]]:
    return [
        {"name": me[0], "type": "user", "race": me[1], "result": result[0], "player_id": 1},
        {"name": opp[0], "type": "user", "race": opp[1], "result": result[1], "player_id": 2},
    ]


def envelope(
    phase: str,
    key: Optional[str],
    *,
    display_time: Optional[float] = 0.0,
    roster: Optional[List[Dict[str, Any]]] = None,
    opponent: Optional[Tuple[Optional[str], Optional[str]]] = (OPP, "Zerg"),
    user: Optional[Tuple[Optional[str], Optional[str]]] = (ME, "Protoss"),
    with_players: bool = True,
) -> Dict[str, Any]:
    env: Dict[str, Any] = {"type": "liveGameState", "phase": phase, "capturedAt": 0.0}
    if key:
        env["gameKey"] = key
    if with_players:
        env["displayTime"] = display_time
        env["isReplay"] = False
        env["players"] = players() if roster is None else roster
    if opponent is not None:
        env["opponent"] = {"name": opponent[0], "race": opponent[1]}
    if user is not None:
        env["user"] = {"name": user[0], "race": user[1]}
    return env


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def cloud_game(
    game_id: str,
    *,
    started: float,
    duration: int = 600,
    opponent: str = OPP,
    my_race: str = "Protoss",
    match_format: Optional[str] = "1v1",
    resumed: bool = False,
    with_started_at: bool = True,
) -> CloudGame:
    return CloudGame(
        game_id=game_id,
        date_iso=iso(started + duration),
        result="Victory",
        my_race=my_race,
        my_build="PvZ - Macro Transition (Unclassified)",
        map_name="Map",
        duration_sec=duration,
        macro_score=None,
        apm=None,
        spq=None,
        opponent={"displayName": opponent, "race": "Zerg"},
        build_log=[],
        early_build_log=[],
        opp_early_build_log=[],
        opp_build_log=[],
        started_at=iso(started) if with_started_at else None,
        match_format=match_format,
        is_resumed_from_replay=resumed,
    )


class Harness:
    """A controller wired to fakes, pumped synchronously."""

    def __init__(
        self,
        *,
        executor: Any = None,
        intro_seen: bool = True,
        view: Any = "fake",
        prefs: Optional[CheckinPrefs] = None,
    ) -> None:
        self.clock = Clock()
        self.wall = Clock(WALL_START)
        self.api = FakeCheckinApi()
        self.view = FakeView() if view == "fake" else view
        self.opened: List[str] = []
        self.intro_dismissed: List[bool] = []
        self.saved_prefs: List[CheckinPrefs] = []
        self.executor = executor or SyncExecutor()
        self.ctl = BuildCheckinController(
            api=self.api,
            view=self.view,
            executor=self.executor,
            clock=self.clock,
            wall_clock=self.wall,
            intro_seen=intro_seen,
            on_intro_dismissed=lambda: self.intro_dismissed.append(True),
            web_queue_url="https://sc2tools.test/app",
            dashboard_url="https://sc2tools.test",
            open_url=self.opened.append,
            prefs=prefs,
            on_prefs_changed=self.saved_prefs.append,
        )
        self._key_seq = 0

    def pump(self) -> None:
        self.ctl.run_pending()

    def boot(self) -> "Harness":
        self.ctl.refresh_prefs()
        self.pump()
        return self

    def send(self, env: Dict[str, Any]) -> None:
        self.ctl.on_envelope(env)
        self.pump()

    def new_key(self, *, names: str = f"{OPP}|{ME}") -> str:
        self._key_seq += 1
        return f"{names}|{int(self.wall() * 1000) + self._key_seq}"

    def advance(self, seconds: float) -> None:
        self.clock.advance(seconds)
        self.wall.advance(seconds)
        self.pump()

    def accept(self, game: CloudGame, *, created: bool = True, **row: Any) -> None:
        self.ctl.on_game_accepted(None, game, game.game_id, {"gameId": game.game_id, "created": created, **row})
        self.pump()

    def play(self, key: str, *, result: str = "Victory", loading: bool = True) -> None:
        """Loading → started → in progress past the cutoff → ended."""
        if loading:
            self.send(envelope("match_loading", key))
        self.send(envelope("match_started", key, display_time=1.0))
        self.send(envelope("match_in_progress", key, display_time=45.0))
        self.end(key, result=result)

    def end(self, key: str, *, result: str = "Victory") -> None:
        other = {"Victory": "Defeat", "Defeat": "Victory", "Tie": "Tie"}[result]
        self.send(envelope(
            "match_ended", key, display_time=600.0,
            roster=players(result=(result, other)),
        ))
