"""Per-game causal observations for the restricted learned Protoss policy.

The host passes the current native Observation from its normal observation
cycle. This adapter makes no game request and reads no global unit collection.
It shares the replay encoder's camera/fog rules and remembers only permitted
own sightings and static neutral identities. Instantiate once per game.
"""
from __future__ import annotations

from copy import deepcopy

from .replays import ReplayError
from .rich_replays import encode_frame


class LivePolicyObservation:
    """Build detached frames without expert actions or fresh offscreen state.

    ``observe(bot.state.observation)`` is the intended native-host boundary.
    The host must supply its new per-game session ID, native participant ID,
    public map dimensions and public unit names. This class does not establish
    starting-worker count, game result, or action legality; those remain the
    runner's and paid controller's responsibilities.
    """

    def __init__(self, *, session_id, player_id, map_size, unit_names):
        if not isinstance(session_id, str) or not session_id.strip():
            raise ReplayError("A new nonempty game session ID is required")
        if type(player_id) is not int or player_id not in (1, 2):
            raise ReplayError("An explicit native 1v1 participant ID is required")
        if (not isinstance(map_size, (tuple, list)) or len(map_size) != 2
                or any(type(n) is not int or not 0 < n <= 4096 for n in map_size)):
            raise ReplayError("Positive public map dimensions are required")
        if (not isinstance(unit_names, dict) or not unit_names
                or any(type(k) is not int or k <= 0 or not isinstance(v, str) or not v
                       for k, v in unit_names.items())):
            raise ReplayError("Public unit ID/name metadata is required")
        self.session_id = session_id
        self.player_id = player_id
        self.map_size = tuple(map_size)
        self._unit_names = dict(unit_names)
        self._known_own = {}
        self._known_neutral = {}
        self._last_loop = -1

    def observe(self, observation):
        """Commit memory only after a valid strictly newer same-player frame."""
        loop = int(observation.game_loop)
        if observation.player_common.player_id != self.player_id:
            raise ReplayError("Policy observation participant changed")
        if loop <= self._last_loop:
            raise ReplayError("Policy observation loops must strictly increase")
        known_own = deepcopy(self._known_own)
        frame = encode_frame(observation, known_own, self._unit_names, map_size=self.map_size)
        known_neutral = deepcopy(self._known_neutral)
        for entity in frame["entities"]:
            if entity["type_name"] == "UNKNOWN":
                raise ReplayError("Observed unit has no public type metadata")
            if entity["owner"] == 3:
                known_neutral[entity["tag"]] = {
                    name: deepcopy(entity[name])
                    for name in ("tag", "owner", "type_id", "type_name", "position")}
                known_neutral[entity["tag"]]["last_seen_loop"] = loop
        frame["known_neutral"] = list(known_neutral.values())
        frame["intervening_selection_input"] = False
        # The caller may annotate/use its frame without corrupting later memory.
        self._known_own = deepcopy(known_own)
        self._known_neutral = deepcopy(known_neutral)
        self._last_loop = loop
        return frame
