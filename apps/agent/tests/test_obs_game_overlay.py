from copy import deepcopy
import json
import pytest

from sc2tools_agent.live.obs_game_overlay import add_missing_game_sources
from sc2tools_agent.live.obs_layout import plan_scenes, build_scenes, _manual_override_url_from_overlay_url, _strict_browser_url_key
from sc2tools_agent.live.obs_scene import SCENE_IN_GAME
from sc2tools_agent.live.obs_website_add import ObsWebsiteAdd
from sc2tools_agent.state import AgentState, load_state, save_state
from tests.test_live_obs_layout import FakeObs


class Obs(FakeObs):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.rows = {}
        self.current = "Live custom scene"
        self.connections = 0
    def connect_now(self):
        self.connections += 1
    def shutdown(self):
        pass
    def current_program_scene(self):
        return self.current
    def get_scene_item_list(self, scene_name):
        return deepcopy(self.rows.get(scene_name, []))
    def create_input(self, **kwargs):
        result = super().create_input(**kwargs)
        self.created_inputs[-1]["enabled_at_create"] = kwargs.get("enabled", True)
        self.rows.setdefault(kwargs["scene_name"], []).append({"source_name": kwargs["input_name"], "input_kind": "browser_source", "index": 0})
        return result
    def create_scene_item(self, **kwargs):
        result = super().create_scene_item(**kwargs)
        self.rows.setdefault(kwargs["scene_name"], []).append({"source_name": kwargs["source_name"], "input_kind": "browser_source", "index": 0})
        return result


def plan(obs, **kwargs):
    return plan_scenes(obs, overlay_base_url="https://sc2tools.com/prefix", overlay_token="synthetic", **kwargs)


def test_default_full_canvas_layer_and_credit():
    items = plan(Obs(canvas=(1280, 720)), webcam_source="Logitech Brio", show_overlay_credit=False).scenes[1].items
    overlay = next(item for item in items if item.share_key == "during_game:overlay")
    assert (overlay.rect.w, overlay.rect.h, overlay.z) == (1280, 720, 2)
    assert overlay.browser_path == "https://sc2tools.com/prefix/overlay/synthetic?credit=0"
    assert next(item.z for item in items if item.label == "Webcam") < overlay.z
    assert next(item.z for item in items if item.label == "Chat alerts") > overlay.z
    assert _manual_override_url_from_overlay_url(overlay.browser_path, expected_route=("overlay", "")) == "https://sc2tools.com/prefix/overlay/synthetic/scene/manual"
    assert _strict_browser_url_key(overlay.browser_path) != _strict_browser_url_key(overlay.browser_path.replace("credit=0", "credit=1"))


def test_explicit_choices_and_fixed_scaled_ticker():
    items = plan(Obs(canvas=(960, 540)), during_game_widgets=["ghost-build", "randomizer", "stats-ticker"]).scenes[1].items
    chosen = [item for item in items if (item.share_key or "").startswith("during_game:")]
    assert [item.share_key for item in chosen] == ["during_game:ghost-build", "during_game:randomizer", "during_game:stats-ticker"]
    assert (chosen[-1].rect.y, chosen[-1].rect.w, chosen[-1].rect.h) == (512, 960, 28)
    assert not any((item.share_key or "") == "during_game:overlay" for item in items)
    assert any("Ghost Build uses your account assignments" in warning for warning in plan(Obs(), during_game_widgets=["ghost-build"]).warnings)
    with pytest.raises(ValueError):
        plan(Obs(), during_game_widgets=["../untrusted"])


def test_additive_update_reuses_renderer_and_preserves_cover_and_all_existing_settings():
    url = "https://sc2tools.com/prefix/overlay/synthetic"
    obs = Obs(scenes=[SCENE_IN_GAME], inputs=[{"name": "Renamed overlay", "kind": "browser_source", "settings": {"url": url, "width": 1920, "height": 1080}}, {"name": "Renamed cover", "kind": "browser_source", "settings": {"url": url + "/scene/manual"}}])
    obs.rows[SCENE_IN_GAME] = [{"source_name": "Renamed cover", "input_kind": "browser_source", "index": 7}]
    before = deepcopy(obs.input_settings)
    assert add_missing_game_sources(obs, plan(obs), [SCENE_IN_GAME]) == ["All-in-one overlay"]
    assert obs.created_items[0]["source"] == "Renamed overlay"
    assert obs.created_items[0]["enabled"] is False
    assert obs.enabled_updates[-1]["enabled"] is True
    assert obs.indexes[0]["index"] == 7
    assert obs.input_settings == before
    assert obs.created_inputs == obs.removed_items == obs.input_setting_updates == []
    assert add_missing_game_sources(obs, plan(obs), [SCENE_IN_GAME]) == []
    assert len(obs.created_items) == 1
    assert add_missing_game_sources(obs, plan(obs), ["My private scene"]) == []


def test_builder_reuses_existing_same_token_route_instead_of_another_audio_renderer():
    obs = Obs(inputs=[{"name": "Existing game overlay", "kind": "browser_source", "settings": {"url": "https://sc2tools.com/prefix/overlay/synthetic?credit=0"}}])
    build_scenes(obs, plan(obs))
    assert any(item["source"] == "Existing game overlay" for item in obs.created_items)
    assert not any(item["settings"]["url"].split("?")[0].endswith("/overlay/synthetic") for item in obs.created_inputs)


def fixture(confirm=lambda _payload: True, scope=None, token_provider=None):
    obs = Obs()
    active = [scope or ("api", "paired-A")]
    tokens = []
    def token():
        tokens.append(True)
        return token_provider() if token_provider else "synthetic"
    controller = ObsWebsiteAdd(scope=lambda: active[0], client_factory=lambda: obs, token_provider=token,
                               confirm=confirm, base_url=lambda: "https://sc2tools.com", clock=lambda: 100)
    raw = {"requestId": "a" * 32, "deviceId": "b" * 24, "widget": "stats-ticker", "expiresAt": 140000}
    return controller, obs, raw, active, tokens


def test_remote_requires_opt_in_and_current_authenticated_pairing_before_even_connecting():
    controller, obs, raw, active, _ = fixture()
    active[0] = None
    assert controller.handle(raw, "paired-A")["code"] == "disabled"
    active[0] = ("api", "paired-B")
    assert controller.handle(raw, "paired-A")["code"] == "disabled"
    assert obs.connections == 0


@pytest.mark.parametrize("extra", [{"url": "https://elsewhere"}, {"widget": "unknown"}, {"widget": "ghost-build"}, {"expiresAt": 99000}, {"expiresAt": 200000}])
def test_remote_rejects_untrusted_or_expired_requests_without_writes(extra):
    controller, obs, raw, _, _ = fixture()
    assert controller.handle({**raw, **extra}, "paired-A")["code"] in {"invalid_request", "expired"}
    assert not obs.created_inputs


def test_decline_has_no_token_lookup_or_obs_mutation():
    controller, obs, raw, _, tokens = fixture(confirm=lambda payload: False)
    assert controller.handle(raw, "paired-A")["code"] == "declined"
    assert tokens == obs.created_inputs == []


def test_local_confirmation_deadline_is_not_reported_as_user_acceptance_or_cancel():
    controller, obs, raw, _, tokens = fixture(confirm=lambda _payload: "expired")
    assert controller.handle(raw, "paired-A")["code"] == "expired"
    assert tokens == obs.created_inputs == []


def test_owner_change_while_confirmation_or_token_lookup_is_pending_never_writes():
    controller, obs, raw, active, _ = fixture()
    controller.confirm = lambda payload: active.__setitem__(0, ("api", "paired-B")) or True
    assert controller.handle(raw, "paired-A")["code"] == "owner_changed"
    active[0] = ("api", "paired-A")
    controller.confirm = lambda payload: True
    controller.token_provider = lambda: active.__setitem__(0, None) or "synthetic"
    assert controller.handle(raw, "paired-A")["code"] == "owner_changed"
    assert not obs.created_inputs


def test_changed_program_scene_after_confirmation_does_not_write_somewhere_else():
    controller, obs, raw, _, _ = fixture()
    controller.confirm = lambda payload: setattr(obs, "current", "Different scene") or True
    assert controller.handle(raw, "paired-A")["code"] == "scene_changed"
    assert not obs.created_inputs


def test_confirmed_remote_add_uses_shared_standalone_size_and_idempotent_url_membership():
    prompts = []
    controller, obs, raw, _, _ = fixture(confirm=lambda payload: prompts.append(payload) or True)
    reply = controller.handle(raw, "paired-A")
    assert reply == {"requestId": raw["requestId"], "deviceId": raw["deviceId"], "code": "added"}
    assert prompts[0]["scene"] == "Live custom scene"
    settings = obs.created_inputs[0]["settings"]
    assert (settings["width"], settings["height"]) == (1920, 180)
    assert settings["shutdown"] is settings["restart_when_active"] is False
    assert obs.created_inputs[0]["enabled_at_create"] is False
    assert obs.enabled_updates[-1]["enabled"] is True
    assert controller.handle(raw, "paired-A")["code"] == "already_present"
    assert len(obs.created_inputs) == 1


def test_remote_new_full_canvas_widget_stays_below_existing_same_token_cover_and_alerts():
    controller, obs, raw, _, _ = fixture()
    raw["widget"] = "stream-scene"
    obs._inputs.extend([{"name": "Renamed cover", "kind": "browser_source"}, {"name": "Renamed alerts", "kind": "browser_source"}])
    obs.input_settings.update({"Renamed cover": {"url": "https://sc2tools.com/overlay/synthetic/scene/manual"}, "Renamed alerts": {"url": "https://sc2tools.com/overlay/synthetic/widget/chat-alerts"}})
    obs.rows[obs.current] = [{"source_name": "Renamed cover", "input_kind": "browser_source", "index": 5}, {"source_name": "Renamed alerts", "input_kind": "browser_source", "index": 6}]
    before = deepcopy(obs.input_settings)
    assert controller.handle(raw, "paired-A")["code"] == "added"
    assert obs.indexes[-1]["index"] == 5
    assert all(obs.input_settings[name] == value for name, value in before.items())
    assert obs.removed_items == obs.input_setting_updates == []


@pytest.mark.parametrize("boundary", ["owner_changed", "expired", "scene_changed"])
@pytest.mark.parametrize("target_row", [False, True])
def test_slow_inventory_rechecks_scope_deadline_and_program_scene_before_write_or_noop_ack(boundary, target_row):
    controller, obs, raw, active, _ = fixture()
    obs._inputs.append({"name": "Unrelated browser", "kind": "browser_source"})
    if target_row:
        obs.rows[obs.current] = [{"source_name": "Unrelated browser", "input_kind": "browser_source"}]
    def read(_name):
        if boundary == "owner_changed":
            active[0] = ("api", "paired-B")
        elif boundary == "expired":
            controller.clock = lambda: 141
        else:
            obs.current = "New program scene"
        return {"url": "https://sc2tools.com/overlay/synthetic/widget/stats-ticker" if target_row else "https://example.invalid/unrelated"}
    obs.get_input_settings = read
    assert controller.handle(raw, "paired-A")["code"] == boundary
    assert obs.created_inputs == obs.created_items == []


def test_slow_input_name_discovery_cannot_send_a_write_under_a_changed_pairing():
    controller, obs, raw, active, _ = fixture()
    original = obs.get_input_list
    def inventory(kind=None):
        if kind is None:  # The collision-name read happens after renderer lookup.
            active[0] = ("api", "paired-B")
        return original(kind)
    obs.get_input_list = inventory
    assert controller.handle(raw, "paired-A")["code"] == "owner_changed"
    assert obs.created_inputs == obs.created_items == []


@pytest.mark.parametrize("boundary", ["owner_changed", "expired", "scene_changed"])
def test_new_source_stays_disabled_if_scope_changes_during_geometry_setup(boundary):
    controller, obs, raw, active, _ = fixture()
    original = obs.set_scene_item_transform
    def transform(**kwargs):
        original(**kwargs)
        if boundary == "owner_changed":
            active[0] = ("api", "paired-B")
        elif boundary == "expired":
            controller.clock = lambda: 141
        else:
            obs.current = "Other program scene"
    obs.set_scene_item_transform = transform
    assert controller.handle(raw, "paired-A")["code"] == boundary
    assert len(obs.created_inputs) == 1 and obs.created_inputs[0]["enabled_at_create"] is False
    assert obs.enabled_updates == []


def test_opt_in_state_is_strict_and_default_off(tmp_path):
    assert AgentState().obs_website_add_enabled is False
    (tmp_path / "agent.json").write_text(json.dumps({"obs_website_add_enabled": "true"}))
    assert load_state(tmp_path).obs_website_add_enabled is False
    save_state(tmp_path, AgentState(obs_website_add_enabled=True))
    assert load_state(tmp_path).obs_website_add_enabled is True


def test_website_add_uses_the_same_environment_connection_precedence_as_switching(monkeypatch):
    from types import SimpleNamespace
    from sc2tools_agent import runner
    state = AgentState(device_token="paired-A", obs_website_add_enabled=True, obs_host="saved-host", obs_port=4455, obs_password="saved-password")
    cfg, cell = SimpleNamespace(api_base="https://api.example.test"), SimpleNamespace(gui=object(), no_obs=False)
    monkeypatch.setenv("SC2TOOLS_OBS_HOST", " synthetic-stream-pc ")
    monkeypatch.setenv("SC2TOOLS_OBS_PORT", "4456")
    monkeypatch.setenv("SC2TOOLS_OBS_PASSWORD", "synthetic-env-password")
    assert runner._obs_website_scope(cfg, state, cell)[2:] == ("synthetic-stream-pc", 4456, "synthetic-env-password")
    calls = []
    monkeypatch.setattr(runner, "ObsClient", lambda **kwargs: calls.append(kwargs))
    runner._obs_website_controller(cfg, state, cell).client_factory()
    assert calls == [{"host": "synthetic-stream-pc", "port": 4456, "password": "synthetic-env-password", "subscribe_events": False}]
    monkeypatch.setenv("SC2TOOLS_OBS_PORT", "invalid")
    assert runner._effective_obs_connection(state)[1] == 4455
