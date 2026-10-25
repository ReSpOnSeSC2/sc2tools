"""Real atomic cache, scoped parse and heartbeat failure isolation."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from sc2tools_agent.api_client import ApiClient
from sc2tools_agent.heartbeat import Heartbeat
from sc2tools_agent.preset_policy import CACHE_NAME, PresetPolicyRefresh, load_cached_policy
from sc2tools_agent.replay_pipeline import _parse_with_preset_policy, bootstrap_analyzer_path

bootstrap_analyzer_path()
from core.preset_policy import policy_snapshot, validate_policy

FIXTURE = Path(__file__).resolve().parents[2] / "replay-engine/tests/fixtures/preset_policy.json"


def policy(revision=1):
    value = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"][0]["policy"]
    value["revision"] = revision
    return validate_policy(value, verify_hash=False)


def test_atomic_refresh_and_process_independent_read_retain_last_compatible_value(tmp_path):
    assert load_cached_policy(tmp_path)["revision"] == 0
    api = SimpleNamespace(get_preset_policy=Mock(return_value=policy()))
    refresh = PresetPolicyRefresh(api, tmp_path)
    assert refresh.refresh() == policy()["hash"]
    assert json.loads((tmp_path / CACHE_NAME).read_text(encoding="utf-8")) == policy()
    snapshot = load_cached_policy(tmp_path)
    snapshot["entries"][0]["enabled"] = False
    assert load_cached_policy(tmp_path) == policy()
    # An invalid download cannot replace the only compatible durable file.
    previous_bytes = (tmp_path / CACHE_NAME).read_bytes()
    invalid = policy(2); invalid["evaluatorVersion"] = 999
    api.get_preset_policy.return_value = invalid
    assert refresh.refresh() is None
    assert (tmp_path / CACHE_NAME).read_bytes() == previous_bytes
    # A malformed/torn user-edited cache cannot clear a process's good copy.
    (tmp_path / CACHE_NAME).write_text("{", encoding="utf-8")
    assert load_cached_policy(tmp_path) == policy()
    api.get_preset_policy.return_value = policy()
    assert refresh.refresh() == policy()["hash"]
    assert json.loads((tmp_path / CACHE_NAME).read_text(encoding="utf-8")) == policy()
    api.get_preset_policy.side_effect = OSError("offline")
    assert refresh.refresh() is None
    assert load_cached_policy(tmp_path) == policy()


def test_new_worker_rejects_oversized_and_bad_hash_cache_without_installing(tmp_path):
    baseline = policy_snapshot()
    (tmp_path / CACHE_NAME).write_bytes(b"x" * (1024 * 1024 + 1))
    assert load_cached_policy(tmp_path) == baseline
    invalid = policy(); invalid["entries"][0]["enabled"] = False
    (tmp_path / CACHE_NAME).write_text(json.dumps(invalid), encoding="utf-8")
    assert load_cached_policy(tmp_path) == baseline
    (tmp_path / CACHE_NAME).write_text("[" * 10000 + "]" * 10000, encoding="utf-8")
    assert load_cached_policy(tmp_path) == baseline


def test_scoped_parse_uses_one_cached_policy_and_does_not_leak_across_threads(tmp_path):
    dirs = [tmp_path / "one", tmp_path / "two"]
    for index, directory in enumerate(dirs):
        directory.mkdir()
        (directory / CACHE_NAME).write_text(json.dumps(policy(index + 1)), encoding="utf-8")
    baseline = policy_snapshot()
    def parse_for(directory):
        def fake_parse(path, handle):
            assert path == "example.SC2Replay" and handle == "Player"
            first = policy_snapshot()
            first["entries"].clear()
            return policy_snapshot()["revision"]
        return _parse_with_preset_policy(fake_parse, Path("example.SC2Replay"), "Player", directory)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(parse_for, dirs)) == [1, 2]
    assert policy_snapshot() == baseline


def test_browser_parse_path_keeps_installed_interpreter_snapshot_and_no_state_io():
    parser = Mock(return_value="context")
    assert _parse_with_preset_policy(parser, Path("example.SC2Replay"), "Player", None) == "context"
    parser.assert_called_once_with("example.SC2Replay", "Player")


def test_heartbeat_refresh_failure_never_turns_a_successful_device_ping_into_failure(tmp_path):
    api = SimpleNamespace(_post=Mock(return_value={}), get_preset_policy=Mock(side_effect=OSError("policy unavailable")))
    success, failure = Mock(), Mock()
    heartbeat = Heartbeat(api, state_dir=tmp_path, on_success=success, on_failure=failure)
    heartbeat._send_one()
    success.assert_called_once_with(); failure.assert_not_called()
    api.get_preset_policy.assert_called_once_with()
    api._post.side_effect = OSError("device offline")
    heartbeat._send_one()
    failure.assert_called_once(); assert api.get_preset_policy.call_count == 1


def test_policy_http_call_is_public_single_attempt_with_short_read_deadline(monkeypatch):
    request = Mock(return_value=policy())
    monkeypatch.setattr(ApiClient, "_request", request)
    ApiClient("https://api.example.test", "PRIVATE-DEVICE-TOKEN").get_preset_policy()
    request.assert_called_once_with("GET", "/v1/build-policy?evaluator=1", auth=False, attempts=1, interactive=True, read_timeout=2.0)
