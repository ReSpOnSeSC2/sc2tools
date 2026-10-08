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


def obs_details_service(tmp_path):
    service = make_service(tmp_path, cloud_client=object())
    service.backend.connected = True
    service.backend.config.update(runtime_enabled=True, expected_channel_id="saved-channel", streams={
        "horizontal": {"reusable_stream_id": "saved-horizontal"},
        "portrait": {"reusable_stream_id": "saved-portrait"},
    })
    calls = []

    def connection(channel, stream_id):
        calls.append((channel, stream_id))
        return {"stream_id": stream_id, "server_url": "rtmps://a.rtmps.youtube.com/live2",
                "stream_key": "fake-private-" + stream_id}

    service.backend.api = SimpleNamespace(obs_connection=connection)
    service._publish()
    return service, calls


@pytest.mark.parametrize("scope", ["horizontal", "portrait"])
def test_obs_details_are_explicit_ephemeral_and_never_status_or_disk(tmp_path, caplog, scope):
    service, calls = obs_details_service(tmp_path)
    before = service.status()
    assert calls == []
    stream_id = "saved-" + scope
    result = service.action({"action": "fetch_obs_connection", "scope": scope,
                             "expected_channel_id": "saved-channel", "stream_id": stream_id})
    assert calls == [("saved-channel", stream_id)]
    assert set(result) == {"obs_connection"}
    private_key = result["obs_connection"]["stream_key"]
    assert result["obs_connection"]["scope"] == scope
    assert service.status() == before
    assert private_key not in str(service.status())
    assert private_key not in str(service.backend.config)
    assert private_key not in str(service.backend.state)
    assert private_key not in caplog.text
    assert not any(private_key.encode() in file.read_bytes() for file in tmp_path.rglob("*") if file.is_file())
    assert service.reader.calls == 0


@pytest.mark.parametrize("changes", [
    {"scope": "unknown"}, {"scope": {}}, {"expected_channel_id": "other-channel"},
    {"stream_id": "saved-portrait"}, {"stream_id": "foreign-id"},
])
def test_obs_details_reject_wrong_destination_before_request(tmp_path, changes):
    service, calls = obs_details_service(tmp_path)
    payload = {"action": "fetch_obs_connection", "scope": "horizontal",
               "expected_channel_id": "saved-channel", "stream_id": "saved-horizontal", **changes}
    with pytest.raises(ValueError):
        service.action(payload)
    assert calls == []


def test_obs_details_disconnected_or_unconfigured_never_fetch(tmp_path):
    service, calls = obs_details_service(tmp_path)
    payload = {"action": "fetch_obs_connection", "scope": "horizontal",
               "expected_channel_id": "saved-channel", "stream_id": "saved-horizontal"}
    service.backend.connected = False
    with pytest.raises(ValueError):
        service.action(payload)
    service.backend.connected = True
    service.backend.config["runtime_enabled"] = False
    with pytest.raises(ValueError):
        service.action(payload)
    assert calls == []


def test_obs_details_errors_never_expose_or_publish_secret(tmp_path, caplog):
    service, calls = obs_details_service(tmp_path)
    before = service.status()

    def fail(*args):
        raise ValueError("fake-private-stream-key-provider-response")

    service.backend.api.obs_connection = fail
    with pytest.raises(ValueError, match="could not be verified") as error:
        service.action({"action": "fetch_obs_connection", "scope": "horizontal",
                        "expected_channel_id": "saved-channel", "stream_id": "saved-horizontal"})
    assert "fake-private" not in str(error.value)
    assert "fake-private" not in caplog.text
    assert service.status() == before


def test_local_obs_details_verify_channel_and_reusable_stream_before_cdn_read(tmp_path):
    service, calls = obs_details_service(tmp_path)
    service.account_mode = "local"
    service.backend.api = SimpleNamespace(
        owned_channel=lambda: {"id": "saved-channel"},
        paginated=lambda resource, params: [{"id": "saved-horizontal", "snippet": {"channelId": "saved-channel"}}],
        streams_by_ids=lambda ids: [{"id": ids[0], "snippet": {"channelId": "saved-channel"},
                                    "cdn": {"ingestionInfo": {"rtmpsIngestionAddress": "rtmps://a.rtmps.youtube.com/live2", "streamName": "fake-private-local-key"}}}],
    )
    result = service.action({"action": "fetch_obs_connection", "scope": "horizontal",
                             "expected_channel_id": "saved-channel", "stream_id": "saved-horizontal"})
    assert result["obs_connection"]["stream_key"] == "fake-private-local-key"
    assert "fake-private" not in str(service.status())
    service.backend.api.owned_channel = lambda: {"id": "different-channel"}
    service.backend.api.streams_by_ids = lambda ids: pytest.fail("foreign channel must never read ingestion details")
    with pytest.raises(ValueError, match="could not be verified"):
        service.action({"action": "fetch_obs_connection", "scope": "horizontal",
                        "expected_channel_id": "saved-channel", "stream_id": "saved-horizontal"})
