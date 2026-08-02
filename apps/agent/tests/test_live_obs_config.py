"""Config-surface tests for OBS scene switching.

Two things get pinned down here:

  * ``AgentState``'s new ``obs_*`` fields round-trip through
    ``save_state`` / ``load_state`` and survive hostile hand edits.
    The state file is user-writable, so every coercion has to fail
    safe rather than propagate junk into a socket call.
  * ``runner._build_obs_switcher`` refuses to construct anything
    unless the user actually asked for it. This is the guard that
    keeps an agent update from silently starting to drive somebody's
    OBS.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from sc2tools_agent.crash_reporter import _is_pii_key
from sc2tools_agent.live.obs_scene import (
    DEFAULT_SCENE_MAP,
    SCENE_BETWEEN_GAMES,
    SCENE_IN_GAME,
)
from sc2tools_agent.runner import _build_obs_switcher
from sc2tools_agent.state import AgentState, load_state, save_state

_LOG = logging.getLogger("test_live_obs_config")


class FakeBridge:
    """Just the ``bus.subscribe`` surface ``_build_obs_switcher`` uses."""

    def __init__(self) -> None:
        self.subscribed: list = []
        bridge = self

        class _Bus:
            def subscribe(self, cb: Any) -> None:
                bridge.subscribed.append(cb)

        self.bus = _Bus()


# ---------------- state round-trip ----------------


def test_obs_fields_round_trip(tmp_path: Path) -> None:
    state = AgentState(
        obs_scene_switch_enabled=True,
        obs_host="192.168.1.50",
        obs_port=4460,
        obs_password="hunter2",
        obs_scene_map={"menu": SCENE_BETWEEN_GAMES, "idle": ""},
        obs_switch_debounce_sec=1.5,
        obs_switch_on_replays=True,
        obs_transition_name="Fade",
        obs_transition_duration_ms=250,
    )
    save_state(tmp_path, state)
    loaded = load_state(tmp_path)

    assert loaded.obs_scene_switch_enabled is True
    assert loaded.obs_host == "192.168.1.50"
    assert loaded.obs_port == 4460
    assert loaded.obs_password == "hunter2"
    assert loaded.obs_scene_map == {"menu": SCENE_BETWEEN_GAMES, "idle": ""}
    assert loaded.obs_switch_debounce_sec == 1.5
    assert loaded.obs_switch_on_replays is True
    assert loaded.obs_transition_name == "Fade"
    assert loaded.obs_transition_duration_ms == 250


def test_state_file_without_obs_keys_gets_safe_defaults(tmp_path: Path) -> None:
    """Every existing install upgrades into this path — an agent.json
    written before the feature existed must not enable it."""
    (tmp_path / "agent.json").write_text(
        json.dumps({"device_token": "tok", "uploaded": {}}),
        encoding="utf-8",
    )
    loaded = load_state(tmp_path)

    assert loaded.obs_scene_switch_enabled is False
    assert loaded.obs_host == "127.0.0.1"
    assert loaded.obs_port == 4455
    assert loaded.obs_password is None
    assert loaded.obs_scene_map == {}
    assert loaded.obs_switch_debounce_sec == 3.0


def _load_with(tmp_path: Path, raw: Dict[str, Any]) -> AgentState:
    (tmp_path / "agent.json").write_text(json.dumps(raw), encoding="utf-8")
    return load_state(tmp_path)


def test_out_of_range_port_falls_back(tmp_path: Path) -> None:
    for bad in (0, -1, 70000, "nope", None, True):
        loaded = _load_with(tmp_path, {"obs_port": bad})
        assert loaded.obs_port == 4455, f"port {bad!r} should not survive"


def test_negative_debounce_falls_back(tmp_path: Path) -> None:
    """A negative deadline is already expired, which would silently
    defeat the very guard the debounce exists to provide."""
    for bad in (-1, -0.5, "abc", None):
        loaded = _load_with(tmp_path, {"obs_switch_debounce_sec": bad})
        assert loaded.obs_switch_debounce_sec == 3.0

    # Zero is a legitimate choice: "switch out immediately".
    assert _load_with(
        tmp_path, {"obs_switch_debounce_sec": 0},
    ).obs_switch_debounce_sec == 0.0


def test_scene_map_drops_junk_but_keeps_blank_values(tmp_path: Path) -> None:
    loaded = _load_with(
        tmp_path,
        {
            "obs_scene_map": {
                "menu": SCENE_BETWEEN_GAMES,
                "idle": "",          # meaningful: "don't switch"
                "match_loading": 42,  # junk
                "": "Orphan",         # junk
            },
        },
    )
    assert loaded.obs_scene_map == {"menu": SCENE_BETWEEN_GAMES, "idle": ""}


def test_scene_map_of_wrong_type_is_ignored(tmp_path: Path) -> None:
    assert _load_with(tmp_path, {"obs_scene_map": ["a", "b"]}).obs_scene_map == {}
    assert _load_with(tmp_path, {"obs_scene_map": "nope"}).obs_scene_map == {}


# ---------------- credential redaction ----------------


def test_obs_password_is_treated_as_pii() -> None:
    """The password lands in agent.json next to device_token; it must
    never ride along in a Sentry event."""
    assert _is_pii_key("obs_password")
    assert _is_pii_key("obs_PASSWORD")
    assert _is_pii_key("password")
    # Sanity: the check is still specific enough to be useful.
    assert not _is_pii_key("obs_host")
    assert not _is_pii_key("obs_port")


# ---------------- builder gating ----------------


def _state(**kw: Any) -> AgentState:
    base: Dict[str, Any] = {"obs_scene_switch_enabled": True}
    base.update(kw)
    return AgentState(**base)


def test_builder_returns_nothing_when_feature_disabled() -> None:
    bridge = FakeBridge()
    client, ctrl = _build_obs_switcher(
        state=AgentState(), bridge=bridge, log=_LOG,
    )
    assert (client, ctrl) == (None, None)
    assert bridge.subscribed == []


def test_builder_returns_nothing_with_no_obs_flag() -> None:
    bridge = FakeBridge()
    client, ctrl = _build_obs_switcher(
        state=_state(), bridge=bridge, log=_LOG, no_obs=True,
    )
    assert (client, ctrl) == (None, None)
    assert bridge.subscribed == []


def test_builder_returns_nothing_without_a_bridge() -> None:
    """--no-live means no phase events, so there is nothing to react
    to and starting an OBS connection would be pure overhead."""
    client, ctrl = _build_obs_switcher(state=_state(), bridge=None, log=_LOG)
    assert (client, ctrl) == (None, None)


def test_builder_subscribes_to_the_bridge_bus() -> None:
    bridge = FakeBridge()
    client, ctrl = _build_obs_switcher(
        state=_state(), bridge=bridge, log=_LOG,
    )
    try:
        assert client is not None and ctrl is not None
        assert bridge.subscribed == [ctrl.listener]
    finally:
        if ctrl:
            ctrl.shutdown()


def test_builder_uses_the_default_map_when_none_configured() -> None:
    bridge = FakeBridge()
    _, ctrl = _build_obs_switcher(state=_state(), bridge=bridge, log=_LOG)
    try:
        assert ctrl is not None
        assert ctrl._scene_map == DEFAULT_SCENE_MAP
    finally:
        if ctrl:
            ctrl.shutdown()


def test_builder_prefers_a_configured_map() -> None:
    bridge = FakeBridge()
    _, ctrl = _build_obs_switcher(
        state=_state(obs_scene_map={"menu": "Mine"}),
        bridge=bridge,
        log=_LOG,
    )
    try:
        assert ctrl is not None
        assert ctrl._scene_map == {"menu": "Mine"}
    finally:
        if ctrl:
            ctrl.shutdown()


def test_env_overrides_beat_the_state_file(monkeypatch) -> None:
    """Matches the precedence the rest of the agent uses, so a power
    user can point one install at a different OBS without the GUI."""
    monkeypatch.setenv("SC2TOOLS_OBS_HOST", "10.0.0.9")
    monkeypatch.setenv("SC2TOOLS_OBS_PORT", "4499")
    monkeypatch.setenv("SC2TOOLS_OBS_PASSWORD", "from-env")

    bridge = FakeBridge()
    client, ctrl = _build_obs_switcher(
        state=_state(
            obs_host="127.0.0.1", obs_port=4455, obs_password="from-state",
        ),
        bridge=bridge,
        log=_LOG,
    )
    try:
        assert client is not None
        assert client._host == "10.0.0.9"
        assert client._port == 4499
        assert client._password == "from-env"
    finally:
        if ctrl:
            ctrl.shutdown()


def test_unparseable_env_port_falls_back_without_raising(monkeypatch) -> None:
    monkeypatch.setenv("SC2TOOLS_OBS_PORT", "not-a-port")
    bridge = FakeBridge()
    client, ctrl = _build_obs_switcher(
        state=_state(obs_port=4470), bridge=bridge, log=_LOG,
    )
    try:
        assert client is not None
        assert client._port == 4455
    finally:
        if ctrl:
            ctrl.shutdown()


def test_builder_does_not_connect_on_construction() -> None:
    """Constructing must be inert — the connection only opens on
    ``start()``, which the runner calls after the rest of boot."""
    bridge = FakeBridge()
    client, ctrl = _build_obs_switcher(
        state=_state(), bridge=bridge, log=_LOG,
    )
    try:
        assert client is not None
        assert client.is_connected is False
    finally:
        if ctrl:
            ctrl.shutdown()


def test_default_map_targets_the_two_builder_scenes() -> None:
    assert set(DEFAULT_SCENE_MAP.values()) == {
        SCENE_IN_GAME,
        SCENE_BETWEEN_GAMES,
    }
    assert DEFAULT_SCENE_MAP["match_ended"] == SCENE_IN_GAME, (
        "match_ended must hold the score screen; the cut happens on menu"
    )
