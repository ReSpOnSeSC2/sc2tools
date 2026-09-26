"""Race-scoped interfaces for asymmetric training matches.

Protoss always uses the original paced spatial client. Terran and Zerg may
issue raw commands across their visible map; fog/debug safeguards still apply.
This class is installed only inside a local league match and never changes the
ordinary Protoss runner or its checkpoint contract.
"""
from __future__ import annotations

from contextlib import contextmanager
from functools import wraps
import time

from loguru import logger

from sc2.client import Client
from sc2.data import Race, Result

from pluto_sc2.fairplay import HumanClient
from pluto_sc2.runner import ManagedSC2Process


class LeagueClient(HumanClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._league_race = None
        self.available_ability_details = {}

    async def _execute(self, *, _fairplay_token=None, **kwargs):
        started = time.monotonic()
        request = {"kind": next(iter(kwargs), None)}
        action = kwargs.get("action")
        if action is not None:
            request["actions"] = []
            for item in action.actions:
                for field in ("action_raw", "action_feature_layer"):
                    if item.HasField(field):
                        body = getattr(item, field)
                        detail = {"interface": field, "kind": body.WhichOneof("action")}
                        if detail["kind"] == "unit_command":
                            detail["ability"] = body.unit_command.ability_id
                        request["actions"].append(detail)
        self._last_api_request = request
        try:
            response = await self._execute_checked(_fairplay_token=_fairplay_token, **kwargs)
            query = kwargs.get("query")
            if query is not None and query.abilities:
                # Burnysc2 returns only IDs from this existing query. Preserve
                # the engine's target requirement without making a new query.
                self.available_ability_details = {
                    row.unit_tag: {ability.ability_id: bool(ability.requires_point) for ability in row.abilities}
                    for row in response.query.abilities
                }
            return response
        finally:
            request["elapsed_seconds"] = round(time.monotonic() - started, 6)

    async def _execute_checked(self, *, _fairplay_token=None, **kwargs):
        if any(key in kwargs for key in ("debug", "map_command", "quick_load", "start_replay")):
            raise RuntimeError("League clients cannot modify game state or enter observer/replay mode")
        for key in ("create_game", "observation"):
            if key in kwargs and kwargs[key].disable_fog:
                raise RuntimeError("All league players obey fog of war")
        join = kwargs.get("join_game")
        if join is not None:
            race = join.race
            if race not in (Race.Protoss.value, Race.Terran.value, Race.Zerg.value):
                raise RuntimeError("League clients must join as an explicit playing race")
            if self._league_race is not None:
                raise RuntimeError("A league client's race/interface cannot change after joining")
            if join.HasField("observed_player_id"):
                raise RuntimeError("League clients cannot join as observers")
            self._league_race = race
            # These options must not inherit burnysc2's revealing defaults.
            join.options.show_cloaked = False
            join.options.show_burrowed_shadows = False
            join.options.show_placeholders = False
            join.options.raw_affects_selection = False
            if race != Race.Protoss.value:
                join.options.ClearField("feature_layer")
        if self._league_race in (None, Race.Protoss.value):
            return await HumanClient._execute(self, _fairplay_token=_fairplay_token, **kwargs)
        request = kwargs.get("action")
        if request is not None and request.actions:
            if len(request.actions) != 1:
                raise RuntimeError("Adversary inputs must be individually paced and audited")
            action = request.actions[0]
            if ({field.name for field, _ in action.ListFields()} != {"action_raw"}
                    or action.action_raw.WhichOneof("action") != "unit_command"):
                raise RuntimeError("Adversaries may issue only raw unit commands")
        return await Client._execute(self, **kwargs)


def _diagnostic_context(phase, args, kwargs):
    """Identify the failing peer without collecting gameplay/unit state."""
    player, client = None, None
    if phase == "_play_game":
        player = args[0] if args else kwargs.get("player")
        client = args[1] if len(args) > 1 else kwargs.get("client")
    else:
        index = 1 if phase == "_host_game" else 0
        players = args[index] if len(args) > index else kwargs.get("players", ())
        slot = 0 if phase == "_host_game" else 1
        if isinstance(players, (list, tuple)) and len(players) > slot:
            player = players[slot]
    race = getattr(player, "race", None)
    context = {"phase": phase, "player": getattr(player, "name", None),
               "race": getattr(race, "name", None)}
    ai = getattr(player, "ai", None)
    state = getattr(ai, "state", None)
    context.update(game_loop=getattr(state, "game_loop", None), bot_error=getattr(ai, "error", None),
                   bot_result=getattr(getattr(ai, "result", None), "name", None))
    audit = getattr(getattr(ai, "fairplay", None), "audit", None)
    if audit and isinstance(audit[-1], dict) and audit[-1].get("transport_error"):
        context["failed_input"] = audit[-1]
    if client is not None:
        context["client_status"] = getattr(getattr(client, "_status", None), "name", None)
        context["player_id"] = getattr(client, "_player_id", None)
        results = getattr(client, "_game_result", None)
        context["engine_results"] = ({str(key): getattr(value, "name", repr(value)) for key, value in results.items()}
                                     if isinstance(results, dict) else None)
        context["owned_engine"] = ManagedSC2Process.diagnostic_for_websocket(getattr(client, "_ws", None))
        context["last_api_request"] = getattr(client, "_last_api_request", None)
    return context


class _LeagueDiagnostics:
    """Keep exceptions visible before burnysc2's gather reduces them to assert.

    No outcome is inferred from a peer's result. Hooks return successful enums
    unchanged and re-raise failures; the owning match remains rejected.
    """

    def __init__(self):
        self.errors = []
        self.invalid_results = []

    def wrap(self, phase, original):
        @wraps(original)
        async def diagnosed(*args, **kwargs):
            try:
                result = await original(*args, **kwargs)
            except Exception as error:
                if not any(captured is error for _context, captured in self.errors):
                    context = _diagnostic_context(phase, args, kwargs)
                    self.errors.append((context, error))
                    logger.opt(exception=error).error("League engine exception before result collection: {}", context)
                raise
            if not isinstance(result, Result):
                context = _diagnostic_context(phase, args, kwargs)
                detail = f"{type(result).__name__}: {result!r}"
                self.invalid_results.append((context, detail))
                logger.error("League engine returned an invalid result: {}; result={}", context, detail)
            return result
        return diagnosed

    def raise_masked_failure(self):
        if self.errors:
            context, original = self.errors[0]
            raise RuntimeError(
                f"League engine failure in {context['phase']} for {context['player']!r} "
                f"({context['race']}): {type(original).__name__}: {original}; "
                "match rejected, original traceback logged"
            ) from original
        if self.invalid_results:
            context, detail = self.invalid_results[0]
            raise RuntimeError(
                f"League engine returned invalid result in {context['phase']} for "
                f"{context['player']!r} ({context['race']}): {detail}; match rejected"
            )


@contextmanager
def league_clients():
    """Scope interfaces and diagnostic hooks; restore every injection on exit."""
    import sc2.main
    names = ("Client", "SC2Process", "_play_game", "_host_game", "_join_game")
    previous = {name: getattr(sc2.main, name) for name in names}
    diagnostics = _LeagueDiagnostics()
    sc2.main.Client, sc2.main.SC2Process = LeagueClient, ManagedSC2Process
    for name in names[2:]:
        setattr(sc2.main, name, diagnostics.wrap(name, previous[name]))
    try:
        try:
            yield
        except AssertionError as error:
            # run_game gathers peer exceptions as values, then asserts that
            # every value is a Result. Preserve a real assertion raised inside
            # the game, while replacing only the assertion hiding that cause.
            if not any(captured is error for _context, captured in diagnostics.errors):
                diagnostics.raise_masked_failure()
            raise
        else:
            # Also reject a caller that swallowed a recorded peer failure.
            diagnostics.raise_masked_failure()
    finally:
        for name, original in previous.items():
            setattr(sc2.main, name, original)
