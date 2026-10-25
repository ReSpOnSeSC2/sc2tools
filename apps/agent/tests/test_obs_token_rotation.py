"""Disposable OBS/API doubles only: owned receipts cannot redirect custom sources."""
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from sc2tools_agent.api_client import ApiClient
from sc2tools_agent.heartbeat import Heartbeat
from sc2tools_agent.live.obs_layout import SCENE_BETWEEN_GAMES, SCENE_IN_GAME
from sc2tools_agent.live.obs_token_rotation import (
    ObsTokenRotation, owned_replacements, repair_generated_token_urls,
)
from sc2tools_agent.state import AgentState
from tests.test_obs_game_overlay import Obs

BASE = "https://example.invalid/prefix"


def inventory(*rows):
    return {"items": list(rows)}


CONFIG = inventory({"token": "old", "revokedAt": "past", "replacedBy": "middle"},
                   {"token": "middle", "revokedAt": "past", "replacedBy": "ready"},
                   {"token": "ready", "revokedAt": None}, {"token": "unrelated"})


def scene_obs():
    specs = [
        (SCENE_BETWEEN_GAMES, "SC2 Tools Backdrop", "/scene/between-games"),
        (SCENE_BETWEEN_GAMES, "SC2 Tools Session Stats", "/widget/session"),
        (SCENE_BETWEEN_GAMES, "SC2 Tools Chat", "/widget/multichat"),
        (SCENE_IN_GAME, "SC2 Tools Game Overlay", ""),
        (SCENE_IN_GAME, "SC2 Tools Ghost Build 2", "/widget/ghost-build"),
        (SCENE_IN_GAME, "SC2 Tools Build Randomizer", "/widget/randomizer"),
        (SCENE_IN_GAME, "SC2 Tools Stats Ticker", "/widget/stats-ticker"),
        (SCENE_IN_GAME, "SC2 Tools Manual Override", "/scene/manual"),
        (SCENE_IN_GAME, "SC2 Tools Chat Alerts", "/widget/chat-alerts"),
        (SCENE_IN_GAME, "My private browser", "/widget/session"),
    ]
    obs = Obs(scenes=[SCENE_BETWEEN_GAMES, SCENE_IN_GAME, "Custom scene"], inputs=[])
    for i, (scene, name, route) in enumerate(specs):
        obs.input_settings[name] = {"url": f"{BASE}/overlay/old{route}?theme=dark&audio=1&credit=0#ghost=opaque%3Dvalue", "width": 517, "height": 211, "customCSS": "body {}"}
        obs.rows.setdefault(scene, []).append({"source_name": name, "input_kind": "browser_source", "index": i, "enabled": i % 2 == 0, "transform": {"positionX": i * 17}})
    obs.input_settings["SC2 Tools Session Stats 7"] = {"url": BASE + "/overlay/old/widget/session"}
    obs.rows["Custom scene"] = [{"source_name": "SC2 Tools Session Stats 7", "input_kind": "browser_source"}]
    return obs


def test_owned_complete_chains_never_choose_unrelated_default():
    result = owned_replacements(CONFIG)
    assert result.replacements == {"old": "ready", "middle": "ready"}
    assert result.ready == {"ready", "unrelated"}


@pytest.mark.parametrize("rows", [
    [{"token": "old", "replacedBy": "missing"}, {"token": "other"}],
    [{"token": "old", "replacedBy": "ready", "rotationPending": True}, {"token": "ready"}],
    [{"token": "old", "replacedBy": "ready"}, {"token": "ready", "rotationPending": True}],
    [{"token": "old", "replacedBy": "ready"}, {"token": "ready", "revokedAt": "past"}],
    [{"token": "old", "replacedBy": "other"}, {"token": "other", "replacedBy": "old"}],
    [{"token": "old", "replacedBy": 9}, {"token": "ready"}],
])
def test_incomplete_pending_missing_revoked_or_cyclic_chains_are_not_repaired(rows):
    assert owned_replacements(inventory(*rows)).replacements == {}


@pytest.mark.parametrize("raw", [None, {}, {"items": "bad"}, inventory({"token": "same"}, {"token": "same"}), inventory({"token": "../path"}), inventory(*[{"token": str(i)} for i in range(513)])])
def test_invalid_or_oversized_inventory_is_rejected(raw):
    with pytest.raises(ValueError):
        owned_replacements(raw)


def test_long_chains_stop_at_a_bounded_hop_count():
    rows = [{"token": str(i), "replacedBy": str(i + 1)} for i in range(40)] + [{"token": "40"}]
    assert "0" not in owned_replacements(inventory(*rows)).replacements


def test_strict_generated_fingerprint_only_rewrites_url_token_preserving_everything_else():
    obs = scene_obs()
    before, rows = deepcopy(obs.input_settings), deepcopy(obs.rows)
    assert repair_generated_token_urls(obs, owned_replacements(CONFIG), BASE) == 9
    for name, settings in obs.input_settings.items():
        expected = before[name].copy()
        if name not in {"My private browser", "SC2 Tools Session Stats 7"}:
            expected["url"] = expected["url"].replace("/overlay/old", "/overlay/ready")
        assert settings == expected
    assert obs.rows == rows
    assert not obs.transforms and not obs.indexes and not obs.enabled_updates and not obs.created_inputs
    assert all(set(write["settings"]) == {"url"} for write in obs.input_setting_updates)
    assert repair_generated_token_urls(obs, owned_replacements(CONFIG), BASE) == 0


@pytest.mark.parametrize("change", [
    lambda o: o._scenes.remove(SCENE_BETWEEN_GAMES),
    lambda o: o.rows[SCENE_BETWEEN_GAMES].pop(),
    lambda o: o.rows[SCENE_BETWEEN_GAMES].append(deepcopy(o.rows[SCENE_BETWEEN_GAMES][0])),
    lambda o: o.input_settings["SC2 Tools Backdrop"].update(url="https://foreign.invalid/overlay/old/scene/between-games"),
    lambda o: o.input_settings["SC2 Tools Backdrop"].update(url=BASE + "/overlay/unrelated/scene/between-games"),
])
def test_missing_ambiguous_foreign_or_mixed_fingerprint_does_not_write(change):
    obs = scene_obs()
    change(obs)
    assert repair_generated_token_urls(obs, owned_replacements(CONFIG), BASE) == 0
    assert obs.input_setting_updates == []


def test_partial_failure_is_retryable_even_after_fingerprint_is_half_rewritten():
    obs = scene_obs()
    original = obs.set_input_settings
    def fail_once(name, settings):
        if len(obs.input_setting_updates) == 2:
            raise OSError("synthetic disconnected")
        original(name, settings)
    obs.set_input_settings = fail_once
    with pytest.raises(OSError):
        repair_generated_token_urls(obs, owned_replacements(CONFIG), BASE)
    obs.set_input_settings = original
    assert repair_generated_token_urls(obs, owned_replacements(CONFIG), BASE) == 7


def test_operator_edit_after_inventory_is_preserved():
    obs = scene_obs()
    original = obs.get_input_settings
    reads = {}
    def read(name):
        reads[name] = reads.get(name, 0) + 1
        if name == "SC2 Tools Game Overlay" and reads[name] == 2:
            obs.input_settings[name]["url"] = "https://custom.invalid/keep"
        return original(name)
    obs.get_input_settings = read
    assert repair_generated_token_urls(obs, owned_replacements(CONFIG), BASE) == 8
    assert obs.input_settings["SC2 Tools Game Overlay"]["url"] == "https://custom.invalid/keep"


@pytest.mark.parametrize("url", [
    "https://foreign.invalid/prefix/overlay/old/widget/ghost-build",
    BASE + "/overlay/old/widget/ghost-build/extra",
    BASE + "/overlay/%6Fld/widget/ghost-build",
    BASE + "/overlay/unrelated/widget/ghost-build",
    BASE + "/overlay/old/widget/session",
    BASE + "/dock/old",
])
def test_known_input_name_does_not_authorize_other_route_origin_or_token(url):
    obs = scene_obs()
    obs.input_settings["SC2 Tools Ghost Build 2"]["url"] = url
    repair_generated_token_urls(obs, owned_replacements(CONFIG), BASE)
    assert obs.input_settings["SC2 Tools Ghost Build 2"]["url"] == url


def controller_fixture():
    obs = scene_obs()
    active = [("https://api.invalid", "paired-A", "host", 4455, "password")]
    api = SimpleNamespace(base_url=active[0][0], device_token="paired-A", get_overlay_tokens=Mock(return_value=CONFIG))
    ctl = ObsTokenRotation(scope=lambda: active[0], api_factory=lambda base, token: api,
        client_factory=lambda scope: obs, base_url=lambda base: BASE, dispatch=lambda callback: callback())
    return ctl, obs, api, active


def test_unavailable_obs_retries_cached_mapping_but_revalidates_before_actual_write():
    ctl, obs, api, _ = controller_fixture()
    original = obs.connect_now
    obs.connect_now = Mock(side_effect=OSError("bearer URL must not be logged"))
    receipts = [{"from": "old", "to": "ready"}]
    assert ctl.heartbeat(receipts, api)
    assert api.get_overlay_tokens.call_count == 1
    obs.connect_now = original
    assert ctl.heartbeat(receipts, api)
    assert api.get_overlay_tokens.call_count == 2
    assert len(obs.input_setting_updates) == 9
    assert ctl.heartbeat(receipts, api)
    assert api.get_overlay_tokens.call_count == 2  # An ordinary no-op needs no HTTP.


@pytest.mark.parametrize("rotated", [False, True])
def test_unchanged_bounded_receipts_cannot_authorize_stale_target_after_obs_recovers(rotated):
    ctl, obs, api, _ = controller_fixture()
    original = obs.connect_now
    obs.connect_now = Mock(side_effect=OSError("synthetic unavailable"))
    receipts = [{"from": "old", "to": "ready"}]
    ctl.heartbeat(receipts, api)
    rows = deepcopy(CONFIG)
    ready = rows["items"][2]
    ready["revokedAt"] = "later"
    if rotated:
        ready["replacedBy"] = "new-terminal"
        rows["items"].append({"token": "new-terminal"})
    api.get_overlay_tokens.return_value = rows
    obs.connect_now = original
    ctl.heartbeat(receipts, api)
    assert api.get_overlay_tokens.call_count == 2
    if rotated:
        assert len(obs.input_setting_updates) == 9
        assert all("/overlay/new-terminal" in write["settings"]["url"] for write in obs.input_setting_updates)
    else:
        assert not obs.input_setting_updates


@pytest.mark.parametrize("at", ["api", "inventory", "reread"])
def test_current_owner_fence_after_each_io_prevents_old_account_writes(at):
    ctl, obs, api, active = controller_fixture()
    def revoke():
        active[0] = ("https://api.invalid", "paired-B", "host", 4455, "password")
    if at == "api":
        api.get_overlay_tokens.side_effect = lambda **kwargs: (revoke(), CONFIG)[1]
    elif at == "inventory":
        original = obs.refresh_scenes
        obs.refresh_scenes = lambda: (revoke(), original())[1]
    else:
        original = obs.get_input_settings
        count = [0]
        def read(name):
            count[0] += 1
            if count[0] > 9:
                revoke()
            return original(name)
        obs.get_input_settings = read
    ctl.changed("paired-A")
    assert obs.input_setting_updates == []


def test_disabled_stale_token_foreign_api_and_invalid_receipts_never_fetch_or_connect():
    ctl, obs, api, active = controller_fixture()
    assert not ctl.changed("paired-B")
    assert not ctl.heartbeat([{"from": "old", "to": "ready", "url": "secret"}], api)
    assert not ctl.heartbeat([], SimpleNamespace(base_url="https://foreign.invalid", device_token="paired-A"))
    active[0] = None
    assert not ctl.changed("paired-A")
    assert api.get_overlay_tokens.call_count == obs.connections == 0


def test_busy_worker_drops_duplicate_advisory_then_uses_next_heartbeat():
    ctl, obs, api, _ = controller_fixture()
    queued = []
    ctl.dispatch = queued.append
    assert ctl.changed("paired-A")
    assert not ctl.changed("paired-A")
    queued.pop()()
    assert ctl.heartbeat([], api)
    queued.pop()()
    assert len(obs.input_setting_updates) == 9


def test_deadline_expiring_during_read_never_writes_and_can_retry():
    ctl, obs, api, _ = controller_fixture()
    now = [0]
    ctl.clock = lambda: now[0]
    original = obs.get_input_settings
    def read(name):
        now[0] = 16
        return original(name)
    obs.get_input_settings = read
    ctl.changed("paired-A")
    assert obs.input_setting_updates == []
    obs.get_input_settings = original
    ctl.changed("paired-A")
    assert len(obs.input_setting_updates) == 9


def test_lock_wait_is_bounded_and_leaves_cached_mapping_retryable(monkeypatch):
    from sc2tools_agent.live import obs_token_rotation
    ctl, obs, api, _ = controller_fixture()
    lock = Mock()
    lock.acquire.return_value = False
    monkeypatch.setattr(obs_token_rotation, "OBS_GAME_WRITE_LOCK", lock)
    ctl.changed("paired-A")
    assert 0 < lock.acquire.call_args.kwargs["timeout"] <= 15
    assert not lock.release.called and obs.input_setting_updates == []
    lock.acquire.return_value = True
    ctl.changed("paired-A")
    assert len(obs.input_setting_updates) == 9 and lock.release.called


def test_changed_inventory_clears_cached_replacements_after_revocation():
    ctl, obs, api, _ = controller_fixture()
    ctl.heartbeat([{"from": "old", "to": "ready"}], api)
    api.get_overlay_tokens.return_value = inventory({"token": "old", "revokedAt": "past"})
    ctl.heartbeat([], api)
    assert api.get_overlay_tokens.call_count == 2
    assert ctl._cache[2].replacements == {}


def test_worker_logs_exception_type_without_secret_url(caplog):
    ctl, obs, api, _ = controller_fixture()
    api.get_overlay_tokens.side_effect = OSError("https://private.invalid/overlay/secret")
    with caplog.at_level("DEBUG"):
        ctl.changed("paired-A")
    assert "OSError" in caplog.text
    assert "private.invalid" not in caplog.text and "secret" not in caplog.text


def test_heartbeat_advisory_uses_the_api_that_completed_before_hot_relink_and_cannot_fail_health():
    callbacks, failures, successes = [], [], []
    api = SimpleNamespace(_post=Mock(), device_token="A")
    heartbeat = Heartbeat(api, on_overlay_tokens=lambda rows, captured: callbacks.append((rows, captured)),
        on_success=lambda: successes.append(True), on_failure=failures.append)
    def post(*args, **kwargs):
        heartbeat._api = SimpleNamespace(device_token="B")
        return {"overlayTokenReplacements": [{"from": "old", "to": "ready"}]}
    api._post.side_effect = post
    heartbeat._send_one()
    assert callbacks == [([{"from": "old", "to": "ready"}], api)]
    assert successes == [True] and not failures
    heartbeat._api = api
    heartbeat._on_overlay_tokens = Mock(side_effect=RuntimeError("advisory"))
    heartbeat._send_one()
    assert successes == [True, True] and not failures


def test_default_token_getter_excludes_pending_or_replaced_rows_but_inventory_keeps_exact_map(monkeypatch):
    api = ApiClient(base_url="https://api.invalid", device_token="paired-A")
    rows = inventory({"token": "pending", "rotationPending": True}, {"token": "old", "replacedBy": "ready"}, {"token": "ready"})
    monkeypatch.setattr(ApiClient, "_get", Mock(return_value=rows))
    assert api.get_overlay_token() == "ready"
    assert api.get_overlay_tokens() == rows
    monkeypatch.setattr(ApiClient, "_interactive", Mock(return_value=rows))
    assert api.get_overlay_tokens(interactive=True) == rows
    api._interactive.assert_called_once_with("GET", "/v1/overlay-tokens")


def test_runner_gate_is_independent_from_website_consent_and_honors_current_env_connection(monkeypatch):
    from sc2tools_agent.runner import _RuntimeCell, _obs_token_rotation_controller
    cfg = SimpleNamespace(api_base="https://api.invalid")
    state = AgentState(device_token="paired-A", obs_scene_switch_enabled=True, obs_website_add_enabled=False)
    cell = _RuntimeCell()
    monkeypatch.setenv("SC2TOOLS_OBS_HOST", "separate-pc")
    monkeypatch.setenv("SC2TOOLS_OBS_PORT", "4456")
    monkeypatch.setenv("SC2TOOLS_OBS_PASSWORD", "synthetic")
    ctl = _obs_token_rotation_controller(cfg, state, cell)
    assert ctl is _obs_token_rotation_controller(cfg, state, cell)
    assert ctl.scope() == (cfg.api_base, "paired-A", "separate-pc", 4456, "synthetic")
    cell.no_obs = True
    assert ctl.scope() is None
    cell.no_obs = False
    state.obs_scene_switch_enabled = False
    assert ctl.scope() is None
    state.obs_scene_switch_enabled = True
    state.device_token = None
    assert ctl.scope() is None


def test_legacy_startup_repair_shares_the_same_write_lock(monkeypatch):
    from sc2tools_agent import runner
    from sc2tools_agent.live import obs_game_overlay
    lock, clients = Mock(), []
    held = [False]
    def acquire(**kwargs):
        held[0] = True
        return True
    lock.acquire.side_effect = acquire
    lock.release.side_effect = lambda: held.__setitem__(0, False)
    monkeypatch.setattr(obs_game_overlay, "OBS_GAME_WRITE_LOCK", lock)
    def client_factory(**kwargs):
        def connect():
            assert held[0]  # Inventory/repair cannot precede this lock.
            raise OSError("synthetic unavailable")
        client = SimpleNamespace(kwargs=kwargs, connection_settings=("host", 4455, None),
            connect_now=connect, shutdown=Mock())
        clients.append(client)
        return client
    monkeypatch.setattr(runner, "ObsClient", client_factory)
    client, controller = runner._build_obs_switcher(state=AgentState(obs_scene_switch_enabled=True),
        bridge=SimpleNamespace(bus=SimpleNamespace(subscribe=lambda callback: None)), log=Mock())
    try:
        client.kwargs["on_connected"]()
        lock.acquire.assert_called_once_with(timeout=2.0)
        assert lock.release.call_count == 1 and not held[0] and len(clients) == 2
        lock.acquire.side_effect = None
        lock.acquire.return_value = False
        client.kwargs["on_connected"]()
        assert len(clients) == 2 and lock.release.call_count == 1
    finally:
        controller.shutdown()


def test_socket_hot_relink_preserves_advisory_callback_and_current_device():
    import asyncio
    from sc2tools_agent.socket_client import SocketClient
    from tests.test_socket_client import _RecordingSio
    callback = Mock()
    original = SocketClient(base_url="https://api.invalid", device_token="old-device",
        on_recompute_games=lambda ids: None, on_recompute_opp_build=lambda token: None,
        on_overlay_tokens_changed=callback)
    replacement = original.with_device_token("new-device")
    assert replacement._on_overlay_tokens_changed is callback
    assert replacement._device_token == "new-device"
    replacement._sio = _RecordingSio()
    replacement._wire_handlers()
    handler = replacement._sio.handlers["overlay:tokens-changed"]
    for payload in (None, {}, {"replaced": False}, {"replaced": 1}, {"replaced": True, "token": "must-not-travel"}):
        asyncio.run(handler(payload))
    assert not callback.called
    asyncio.run(handler({"replaced": True}))
    callback.assert_called_once_with("new-device")
    replacement._stop.set()
    asyncio.run(handler({"replaced": True}))
    assert callback.call_count == 1
