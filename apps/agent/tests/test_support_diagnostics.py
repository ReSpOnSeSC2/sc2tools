"""Synthetic support facts only: no agent, private state or probes."""
import ast
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError, asdict
import hashlib
import inspect
import json
import threading

import pytest

from sc2tools_agent import support_diagnostics as diagnostics
from sc2tools_agent.support_diagnostics import (
    DiagnosticRow, ROW_IDS, SupportInfo, collect_diagnostics,
    diagnostic_bytes, project_support, state_summary_bytes,
)


def snapshot(raw=None, checks=None, **guards):
    return collect_diagnostics(lambda: raw or {}, lambda: checks or {},
        is_current=guards.get("is_current", lambda: True),
        is_cancelled=guards.get("is_cancelled", lambda: False),
        validate_device=guards.get("validate_device"))


def test_pure_modules_have_only_pure_imports():
    from sc2tools_agent import support_export, support_redaction
    allowed = {"__future__", "dataclasses", "hashlib", "ipaddress", "json", "math", "re", "urllib.parse",
        "datetime", "support_diagnostics", "support_redaction"}
    for module in (diagnostics, support_redaction, support_export):
        tree = ast.parse(inspect.getsource(module))
        imports = {node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
        imports.update(alias.name for node in ast.walk(tree) if isinstance(node, ast.Import) for alias in node.names)
        assert imports <= allowed
        assert not any(isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id in {"open", "eval", "exec", "print"} for node in ast.walk(tree))


def test_all_support_fields_deterministic_and_identity_minimized():
    user = "synthetic-owner-identity"
    device = "0123456789abcdef0123cdef"
    raw = {"version": "0.24.8", "os_name": "Windows", "os_version": "10.0.22631", "channel": "stable",
        "api_url": "https://private-login:private-password@API.example.test/private-path?token=private-query#private-fragment",
        "pool_mode": "process", "workers": 4, "folder_count": 2, "regions": ["kr", "us", "us", "private-name"],
        "sync_filter": "season:67", "sync_since": "2026-10-01", "sync_until": "2026-11-02",
        "pending": 3, "archive_pending": 7, "paused": False, "user_id": user, "device_id": device,
        "device_token": "private-device-token", "errors": [{"kind": "offline", "detail": "private-exception"}],
        "live_metrics": {"counters": {"obs.connect.ok": {"count": 9}},
            "latencies": {"obs.connect.latency": {"ewma_ms": 12.345}}}}
    before = json.dumps(raw, sort_keys=True)
    result = snapshot(raw, {"api": {"status": "pass", "code": "ok", "action": "retry", "latency_ms": 3}},
        validate_device=lambda: device)
    info = result.support
    assert info == SupportInfo("0.24.8", "Windows", "10.0.22631", "stable", "api.example.test", "process", 4, 2,
        ("kr", "us"), "season:67", "2026-10-01", "2026-11-02", 3, 7, False, ("offline",),
        hashlib.sha256(user.encode("utf-8")).hexdigest()[:8], "23cdef", (("obs.connect.ok", 9),), (("obs.connect.latency", 12.35),))
    assert result.rows[4] == DiagnosticRow("api", "pass", "ok", "retry", None, 3)
    output = diagnostic_bytes(result) + state_summary_bytes(info)
    assert output == diagnostic_bytes(result) + state_summary_bytes(info)
    assert json.dumps(raw, sort_keys=True) == before
    for private in (user, device, "private-login", "private-password", "private-path", "private-query", "private-fragment", "private-device-token", "private-exception", "private-name"):
        assert private.encode() not in output
    assert info.user_hash8.encode() in output and b"23cdef" in output
    assert diagnostics.approved_document("diagnostics.txt", diagnostic_bytes(result))
    assert diagnostics.approved_document("state-summary.json", state_summary_bytes(info))


@pytest.mark.parametrize("device", [None, "", "device-a", "0123456789ABCDEF01234567", "0123456789abcdef0123456", "0" * 25])
def test_unbound_or_noncanonical_device_never_has_suffix(device):
    assert snapshot({"device_id": "0123456789abcdef01234567"}).support.device_suffix6 is None
    assert snapshot(validate_device=lambda: device).support.device_suffix6 is None


def test_missing_values_are_unavailable_and_fixed_rows_are_frozen():
    result = snapshot()
    assert result.support.pending is None and result.support.folder_count is None
    assert result.support.regions is None and result.support.errors is None
    assert result.support.counters is None and result.support.latencies is None
    assert tuple(row.id for row in result.rows) == ROW_IDS
    assert all(row.status == row.code == "unavailable" and row.count is None for row in result.rows)
    assert b"pending=unavailable\n" in diagnostic_bytes(result)
    assert b"errors=unavailable\n" in diagnostic_bytes(result)
    with pytest.raises(FrozenInstanceError):
        result.support.pending = 0


class Hostile:
    def __str__(self):
        raise AssertionError("stringified private object")

    def __bool__(self):
        raise AssertionError("coerced private object")

    def __eq__(self, other):
        raise AssertionError("compared private object")

    def __hash__(self):
        raise AssertionError("hashed private object")


class StringSubclass(str):
    def __str__(self):
        raise AssertionError("coerced string subclass")


class DictSubclass(dict):
    def get(self, *args):
        raise AssertionError("read dict subclass")


def test_colliding_nonprimitive_dict_keys_never_execute_equality_callbacks():
    invoked = []

    class Key:
        def __init__(self, target):
            self.target = target

        def __hash__(self):
            return hash(self.target)

        def __eq__(self, other):
            invoked.append(other)
            raise AssertionError("private key callback")

    def bad(target):
        return {Key(target): "private-value"}

    cases = [bad("user_id"), {"errors": [bad("kind")]}, {"live_metrics": bad("counters")},
        {"live_metrics": {"counters": bad("obs.connect.ok")}},
        {"live_metrics": {"counters": {"obs.connect.ok": bad("count")}}}]
    for raw in cases:
        result = snapshot(raw)
        assert result is not None and b"private-value" not in diagnostic_bytes(result)
    for checks in (bad("api"), {"api": bad("status")}):
        assert snapshot(checks=checks) is not None
    assert invoked == []


def test_unknown_fields_metrics_error_details_and_raw_objects_cannot_escape():
    poison = Hostile()
    raw = {name: poison for name in ("version", "os_name", "os_version", "channel", "api_url", "pool_mode", "workers",
        "folder_count", "regions", "sync_filter", "sync_since", "sync_until", "pending", "archive_pending", "paused", "user_id")}
    raw.update({"unknown": "private-unknown", "profile": poison, "boot": poison, "device_id": "f" * 24,
        "errors": [{"kind": "offline", "detail": "private-detail"}, poison],
        "live_metrics": {"counters": {"private-metric": {"count": 4}, "obs.connect.ok": {"count": poison}},
            "latencies": {"private-latency": {"ewma_ms": 5}}}})
    result = snapshot(raw, {"api": {"status": poison, "code": poison, "action": poison, "detail": "private-check", "count": poison}})
    assert result is not None
    assert result.support.errors == ("offline", "unknown")
    assert not result.support.counters and not result.support.latencies
    output = diagnostic_bytes(result)
    assert b"private-" not in output
    assert snapshot(DictSubclass()).support == SupportInfo()
    assert project_support(DictSubclass(version="0.24.8")) == SupportInfo()
    assert project_support(poison) == SupportInfo()
    assert project_support({"version": StringSubclass("0.24.8")}).version is None
    with pytest.raises(ValueError, match="invalid_support_info"):
        SupportInfo(version=poison)


@pytest.mark.parametrize("value", [True, False, -1, float("nan"), float("inf"), 10**100, "3", None])
def test_invalid_numbers_are_unavailable_without_coercion(value):
    info = project_support({"workers": value, "pending": value, "folder_count": value,
        "live_metrics": {"counters": {"obs.connect.ok": {"count": value}}, "latencies": {"obs.connect.latency": {"ewma_ms": value}}}})
    assert info.workers is None and info.pending is None and info.folder_count is None
    assert info.counters == info.latencies == ()


@pytest.mark.parametrize("field,value", [("version", "0.24.8-private"), ("version", "x/0.24.8"),
    ("channel", "private-channel"), ("os_name", "private-pc"), ("os_version", "Windows private-pc"),
    ("sync_filter", "C:/private"), ("sync_filter", "season:-3"), ("sync_since", "2026-02-30"),
    ("api_url", "https://bad host.test/path"), ("api_url", "file:///private"), ("api_url", "https://host.test:99999"),
    ("api_url", "https://host.test\nprivate"), ("api_url", "privatepc")])
def test_strict_strings_drop_arbitrary_labels(field, value):
    output_name = "api_host" if field == "api_url" else field
    assert getattr(project_support({field: value}), output_name) is None


def test_last_ten_closed_error_kinds_only():
    errors = [{"kind": "offline", "detail": f"private-{i}"} for i in range(12)]
    errors[-1] = {"kind": "invented_private_error", "detail": "private-end"}
    info = project_support({"errors": errors})
    assert info.errors == ("offline",) * 9 + ("unknown",)
    assert b"private" not in state_summary_bytes(info)


@pytest.mark.parametrize("user", ["synthetic-user", "\u5408\u6210-owner"])
def test_user_hash_is_exact_utf8_sha256_prefix(user):
    info = project_support({"user_id": user})
    assert info.user_hash8 == hashlib.sha256(user.encode("utf-8")).hexdigest()[:8]
    assert user.encode() not in state_summary_bytes(info)


@pytest.mark.parametrize("user", ["", "x" * 4097, "\ud800", StringSubclass("synthetic-user")])
def test_invalid_user_identity_is_unavailable_without_partial_hash(user):
    assert project_support({"user_id": user}).user_hash8 is None


@pytest.mark.parametrize("url,host", [("https://[::1]:443/private?token=private", "::1"),
    ("https://192.0.2.1/private", "192.0.2.1"), ("http://localhost:6119/private", "localhost")])
def test_valid_ip_and_local_api_hosts_roundtrip(url, host):
    result = snapshot({"api_url": url})
    assert result.support.api_host == host
    assert diagnostics.approved_document("diagnostics.txt", diagnostic_bytes(result))


def test_guard_contract_rejects_nonboolean_and_throwing_guards():
    called = []
    for guard in (lambda: Hostile(), lambda: 1, lambda: (_ for _ in ()).throw(RuntimeError("private-guard"))):
        assert collect_diagnostics(lambda: called.append(True), lambda: {}, is_current=guard, is_cancelled=lambda: False) is None
    assert called == []


@pytest.mark.parametrize("stage", ["support", "device", "checks"])
@pytest.mark.parametrize("retirement", ["cancel", "owner_aba", "connection", "new_run"])
def test_held_callbacks_retire_actual_private_result(stage, retirement):
    # Model a held callback completing after a runtime generation change. The
    # owner can return to A; monotonic identity still retires its old work.
    current = {"owner": "A", "epoch": 10, "connection": 1, "run": 4, "cancel": False}
    captured = ("A", 10, 1, 4)
    called = []

    def retire():
        if retirement == "cancel":
            current["cancel"] = True
        elif retirement == "owner_aba":
            current.update(owner="B", epoch=11)
            current.update(owner="A", epoch=12)
        elif retirement == "connection":
            current["connection"] += 1
        else:
            current["run"] += 1

    def held(name, result):
        called.append(name)
        if name == stage:
            retire()
        return result

    result = collect_diagnostics(lambda: held("support", {"user_id": "held-private-owner"}),
        lambda: held("checks", {"api": {"status": "pass", "code": "ok"}}),
        validate_device=lambda: held("device", "0123456789abcdef01234567"),
        is_current=lambda: (current["owner"], current["epoch"], current["connection"], current["run"]) == captured,
        is_cancelled=lambda: current["cancel"])
    assert result is None
    assert called == {"support": ["support"], "device": ["support", "device"], "checks": ["support", "device", "checks"]}[stage]


def test_guards_checked_at_final_publication_and_values_contain_no_callback_ticket():
    calls = []

    def current():
        calls.append(True)
        return len(calls) < 5

    assert snapshot({"user_id": "private-owner"}, is_current=current) is None
    result = snapshot({"user_id": "private-owner"}, validate_device=lambda: "0123456789abcdef01234567")
    safe = repr(result) + json.dumps(asdict(result))
    assert "private-owner" not in safe and "validate_device" not in safe and "token" not in safe
    assert not any(callable(value) for value in asdict(result).values())


def test_actual_held_support_callback_cannot_publish_after_owner_aba():
    entered, release = threading.Event(), threading.Event()
    state = {"owner": "A", "epoch": 1}

    def held():
        entered.set()
        assert release.wait(5)
        return {"user_id": "held-private-identity", "device_token": "held-private-token"}

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(collect_diagnostics, held, lambda: {},
            is_current=lambda: (state["owner"], state["epoch"]) == ("A", 1), is_cancelled=lambda: False)
        try:
            assert entered.wait(5)
            state.update(owner="B", epoch=2)
            state.update(owner="A", epoch=3)
        finally:
            release.set()
        assert future.result(timeout=5) is None
