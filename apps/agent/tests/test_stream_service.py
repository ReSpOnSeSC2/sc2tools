from types import SimpleNamespace

import pytest

from sc2tools_agent.streaming.obs_reader import OutputReader, DEFAULT_OUTPUTS
from sc2tools_agent.streaming.service import StreamService
from sc2tools_agent.streaming.youtube_pair_backend import PairBackend


class Reader:
    def __init__(self, values=None):
        self.values = values or {"horizontal": False, "portrait": False}
        self.calls = 0

    def __call__(self, names):
        self.calls += 1
        return dict(self.values)

    def close(self):
        pass


class TitlePlatform:
    def __init__(self, fail=False):
        self.title = None
        self.fail = fail

    def update_title(self, title):
        if self.fail:
            raise RuntimeError("secret token must not appear")
        self.title = title
        return self.public_status()

    def public_status(self):
        return {"connected": True, "title": self.title}


def make_service(tmp_path, **kwargs):
    backend = PairBackend(tmp_path, memory=True, config={"metadata": {
        "title": "Previous title", "description": "Links", "vertical_suffix": " | Vertical",
    }})
    return StreamService(tmp_path, lambda: {}, backend=backend, output_reader=Reader(), **kwargs)


def test_construct_status_and_local_title_never_contact_obs_or_auth(tmp_path):
    service = make_service(tmp_path)
    assert service.status()["youtube"]["connected"] is False
    result = service.action({"action": "set_metadata", "title": "New title"})
    assert result["metadata"]["title"] == "New title"
    assert service.reader.calls == 0
    assert result["platform_results"]["twitch"]["ok"] is False
    assert result["platform_results"]["tiktok"]["ok"] is False


def test_platform_save_reports_partial_failure_and_redacts_error(tmp_path):
    service = make_service(tmp_path, adapters={"twitch": TitlePlatform(), "kick": TitlePlatform(fail=True)})
    result = service.action({"action": "set_metadata", "title": "The session title"})
    assert result["platform_results"]["twitch"]["ok"] is True
    assert result["platform_results"]["kick"]["ok"] is False
    assert "secret token" not in str(result)


@pytest.mark.parametrize("title", ["", "x" * 71, "Line\nbreak", "<script>"])
def test_invalid_shared_title_preserves_template(tmp_path, title):
    service = make_service(tmp_path)
    with pytest.raises(ValueError):
        service.action({"action": "set_metadata", "title": title})
    assert service.status()["metadata"]["title"] == "Previous title"


def test_disconnected_prepare_does_not_claim_ready(tmp_path):
    service = make_service(tmp_path)
    result = service.action({"action": "prepare"})
    assert result["youtube"]["pair_ready"] is False
    assert result["youtube"]["code"] == "authorization_required"


def test_status_snapshot_is_detached_and_does_not_wait_on_operations(tmp_path):
    service = make_service(tmp_path)
    result = service.status()
    result["metadata"]["title"] = "Tampered"
    assert service.status()["metadata"]["title"] == "Previous title"


def test_configure_fails_before_cloud_call_when_obs_unknown(tmp_path):
    service = make_service(tmp_path)
    service.backend.connected = True
    service.reader.values = {"horizontal": None, "portrait": False}
    with pytest.raises(ValueError, match="stop both"):
        service.action({"action": "configure_youtube"})
    assert not service.config_path.exists()


def test_output_reader_inventory_failure_is_unknown():
    class Raw:
        def get_output_list(self):
            raise OSError("disconnected")
        def disconnect(self):
            pass
    reader = OutputReader(lambda: {}, factory=lambda **kwargs: Raw())
    assert reader() == {"horizontal": None, "portrait": None}


def test_output_reader_reads_exact_names_using_separate_client():
    calls = []
    class Raw:
        def get_output_list(self):
            return SimpleNamespace(outputs=[{"outputName": DEFAULT_OUTPUTS["horizontal"]}])
        def get_output_status(self, name):
            calls.append(name)
            return SimpleNamespace(output_active=True)
    reader = OutputReader(lambda: {}, factory=lambda **kwargs: Raw())
    assert reader() == {"horizontal": True, "portrait": False}
    assert calls == [DEFAULT_OUTPUTS["horizontal"]]


def test_no_obs_gate_never_instantiates_client():
    def forbidden(**kwargs):
        raise AssertionError("OBS connection must stay disabled")
    reader = OutputReader(lambda: {}, disabled=True, factory=forbidden)
    assert reader() == {"horizontal": None, "portrait": None}


@pytest.mark.parametrize("inventory", [[{}], [{"outputName": ""}], ["invalid"], [{"outputName": "same"}, {"outputName": "same"}]])
def test_malformed_inventory_never_means_stopped(inventory):
    class Raw:
        def get_output_list(self):
            return SimpleNamespace(outputs=inventory)
        def disconnect(self):
            pass
    reader = OutputReader(lambda: {}, factory=lambda **kwargs: Raw())
    assert reader() == {"horizontal": None, "portrait": None}


def test_failed_template_save_does_not_send_other_platform_titles(tmp_path, monkeypatch):
    platform = TitlePlatform()
    service = make_service(tmp_path, adapters={"twitch": platform})
    monkeypatch.setattr(service.backend, "dispatch", lambda *args, **kwargs: {
        "ok": False, "code": "metadata_save_failed", "future_template_saved": False,
    })
    with pytest.raises(ValueError, match="could not be saved"):
        service.action({"action": "set_metadata", "title": "New title"})
    assert platform.title is None


def test_completed_pair_switch_requires_fresh_read_only_proof_then_allows_return(tmp_path, monkeypatch):
    service = make_service(tmp_path, cloud_client=object())
    service.backend.state["pair"] = {"phase": "complete"}
    calls = []
    monkeypatch.setattr(service.backend, "verify_future_configuration", lambda config, outputs: calls.append(outputs))
    result = service.action({"action": "use_local_connections"})
    assert result["account_mode"] == "local"
    assert service.backend.state["pair"]["phase"] == "complete"
    assert calls == [{"horizontal": False, "portrait": False}]
    result = service.action({"action": "use_sc2tools_connections"})
    assert result["account_mode"] == "sc2tools"
    assert service.backend.connected is False


def test_account_mode_change_preserves_config_when_pair_cannot_be_verified(tmp_path, monkeypatch):
    service = make_service(tmp_path, cloud_client=object())
    service.backend.state["pair"] = {"phase": "live"}
    def blocked(*args):
        raise RuntimeError("private provider error")
    monkeypatch.setattr(service.backend, "verify_future_configuration", blocked)
    with pytest.raises(ValueError, match="Finish both broadcasts") as failure:
        service.action({"action": "use_local_connections"})
    assert "private provider" not in str(failure.value)
    assert service.account_mode == "sc2tools"
    assert not service.config_path.exists()
