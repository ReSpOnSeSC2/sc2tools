"""The review and later save share immutable actual bytes; no filesystem export."""
from dataclasses import FrozenInstanceError, asdict
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import threading

import pytest

from sc2tools_agent import support_export as export
from sc2tools_agent.support_diagnostics import (
    DiagnosticRow, DiagnosticSnapshot, ROW_IDS, SupportInfo, collect_diagnostics,
    diagnostic_bytes, state_summary_bytes,
)
from sc2tools_agent.support_export import (
    ExportPlan, LogSelection, ReviewedEntry, build_export_plan, collect_export_plan,
)
from sc2tools_agent.support_redaction import RedactedLog, redact_log


def snapshot():
    return collect_diagnostics(lambda: {"user_id": "synthetic-private-user", "version": "0.24.8",
        "pending": 3, "folder_count": 2}, lambda: {"api": {"status": "pass", "code": "ok", "latency_ms": 4}},
        is_current=lambda: True, is_cancelled=lambda: False,
        validate_device=lambda: "0123456789abcdef01234567")


def plan(selections=(), **guards):
    return build_export_plan(snapshot(), selections, is_current=guards.get("is_current", lambda: True),
        is_cancelled=guards.get("is_cancelled", lambda: False))


def entry(alias, data):
    return ReviewedEntry(alias, data, len(data), hashlib.sha256(data).hexdigest())


def test_exact_reviewed_bytes_generated_aliases_hashes_and_manifest():
    selections = [LogSelection("worker", 7, redact_log((b"event=worker count=2\n",))),
        LogSelection("parent", 2, redact_log((b"private-error-details\nevent=sync pending=3\n",))),
        LogSelection("parent", 0, redact_log((b"event=sync\n",)))]
    result = plan(selections)
    assert result is not None
    assert tuple(item.alias for item in result.entries) == (
        "diagnostics.txt", "state-summary.json", "logs/agent-0.log", "logs/agent-2.log", "logs/worker-7.log")
    assert result.entries[0].data == diagnostic_bytes(snapshot())
    assert result.entries[1].data == state_summary_bytes(snapshot().support)
    assert result.entries[2].data == b"event=sync\n"
    assert result.entries[3].data == b"[omitted]\nevent=sync pending=3\n"
    assert result.entries[4].data == b"event=worker count=2\n"
    assert result.entries[3].omitted_lines == 1
    assert result.total_bytes == sum(len(item.data) for item in result.entries)
    manifest = json.loads(result.manifest)
    assert manifest == {"schema_version": 1, "total_bytes": result.total_bytes, "entries": [
        {"alias": item.alias, "size": len(item.data), "sha256": hashlib.sha256(item.data).hexdigest(),
            "omitted_lines": item.omitted_lines, "truncated": item.truncated,
            "redaction_code": item.redaction_code} for item in result.entries]}
    assert result.manifest_sha256 == hashlib.sha256(result.manifest).hexdigest()
    assert all(item.size == len(item.data) and item.sha256 == hashlib.sha256(item.data).hexdigest() for item in result.entries)
    assert b"private" not in b"".join(item.data for item in result.entries) + result.manifest


@pytest.mark.parametrize("ms", [0, 1, 0.0, -0.0, 1.0, 12.345])
def test_integer_zero_and_float_latencies_roundtrip_into_actual_plan(ms):
    rows = tuple(DiagnosticRow(row_id, "pass", "ok", latency_ms=ms) for row_id in ROW_IDS)
    direct = DiagnosticSnapshot(SupportInfo(), rows)
    collected = collect_diagnostics(lambda: {}, lambda: {row_id: {"latency_ms": ms} for row_id in ROW_IDS},
        is_current=lambda: True, is_cancelled=lambda: False)
    for value in (direct, collected):
        result = build_export_plan(value, is_current=lambda: True, is_cancelled=lambda: False)
        assert result is not None
        assert result.entries[0].data == diagnostic_bytes(value)
        assert f"latency_ms={value.rows[0].latency_ms}\n".encode() in result.entries[0].data


def test_mutating_source_buffer_selection_container_or_preview_cannot_change_plan():
    buffer = bytearray(b"event=sync\n")
    document = RedactedLog(buffer)
    selections = [LogSelection("parent", 0, document)]
    result = plan(selections)
    before = (result.entries, result.manifest, result.manifest_sha256, result.total_bytes)
    buffer[:] = b"private-raw"
    selections[:] = [LogSelection("worker", 0, redact_log((b"event=worker\n",)))]
    assert (result.entries, result.manifest, result.manifest_sha256, result.total_bytes) == before
    assert result.entries[2].data == b"event=sync\n"
    preview = result.entries
    assert preview is result.entries  # A writer consumes these exact same entries.
    with pytest.raises(FrozenInstanceError):
        preview[2].data = b"private\n"
    copied_metadata = asdict(result)
    copied_metadata["entries"][2]["alias"] = "private-source-path"
    assert result.entries[2].alias == "logs/agent-0.log"


@pytest.mark.parametrize("alias", ["", ".", "..", "/diagnostics.txt", "C:/diagnostics.txt", "C:diagnostics.txt",
    r"\\host\share\agent.log", r"logs\agent-0.log", "logs/../agent-0.log", "logs/./agent-0.log",
    "logs//agent-0.log", "logs/agent-0.log\x00", "logs/agent-0.log\n", "agent.json", "player_handle.json",
    "cache/state.json", "dpapi.bin", "provider.json", "capture.png", "private.SC2Replay", "environment.txt",
    "logs/agent-3.log", "logs/worker-8.log", "logs/private.log"])
def test_archive_alias_whitelist_rejects_paths_raw_state_and_unknown_files(alias):
    with pytest.raises(ValueError, match="invalid_reviewed_entry"):
        entry(alias, b"event=sync\n")


@pytest.mark.parametrize("kind,slot", [("parent", -1), ("parent", 3), ("worker", 8), ("worker", True),
    ("agent.json", 0), ("logs/agent-0.log", 0), ("parent", "0")])
def test_selection_is_only_bounded_generated_slots(kind, slot):
    with pytest.raises(ValueError, match="invalid_log_selection"):
        LogSelection(kind, slot, redact_log((b"event=sync\n",)))


def test_duplicate_or_raw_source_selections_cannot_make_a_plan():
    selected = LogSelection("parent", 0, redact_log((b"event=sync\n",)))
    assert plan((selected, selected)) is None
    for raw in ("agent.json", {"path": "agent.json"}, lambda: b"private", selected.document, object()):
        assert plan((raw,)) is None
    assert build_export_plan({"user_id": "private"}, (), is_current=lambda: True, is_cancelled=lambda: False) is None


def test_even_direct_value_construction_cannot_publish_arbitrary_bytes():
    for alias in ("diagnostics.txt", "state-summary.json", "logs/agent-0.log"):
        with pytest.raises(ValueError):
            entry(alias, b"private-device-token\n")
    original = diagnostic_bytes(snapshot())
    for data in (original + b"private-secret\n", original.replace(b"pending=3", b"pending=\"private\""),
        original.replace(b"user_hash8=", b"raw_user_id=")):
        with pytest.raises(ValueError, match="invalid_reviewed_document"):
            entry("diagnostics.txt", data)
    summary = state_summary_bytes(snapshot().support)
    values = json.loads(summary)
    values["device_token"] = "private-device-token"
    with pytest.raises(ValueError, match="invalid_reviewed_document"):
        entry("state-summary.json", json.dumps(values).encode())


@pytest.mark.parametrize("alias", ["diagnostics.txt", "state-summary.json"])
@pytest.mark.parametrize("omitted,truncated,code", [(1, False, "omitted"), (0, True, "ok"), (0, False, "invalid_utf8")])
def test_generated_documents_reject_nondefault_redaction_metadata(alias, omitted, truncated, code):
    data = diagnostic_bytes(snapshot()) if alias == "diagnostics.txt" else state_summary_bytes(snapshot().support)
    with pytest.raises(ValueError, match="invalid_reviewed_document"):
        ReviewedEntry(alias, data, len(data), hashlib.sha256(data).hexdigest(), omitted, truncated, code)


def test_reviewed_log_rejects_false_marker_metadata_and_preserves_valid_codes_in_manifest():
    data = b"[omitted]\n"
    with pytest.raises(ValueError, match="invalid_redacted_log"):
        entry("logs/agent-0.log", data)
    omitted = RedactedLog(data, 1, False, "omitted")
    invalid_utf8 = redact_log((b"\xff\n",))
    dropped = RedactedLog(b"event=sync\n", 2, True, "omitted")
    result = plan((LogSelection("parent", 0, omitted), LogSelection("parent", 1, invalid_utf8),
        LogSelection("worker", 0, dropped)))
    assert result is not None
    assert tuple(item.data for item in result.entries[2:]) == (b"[omitted]\n", b"[omitted]\n", b"event=sync\n")
    assert tuple(item.redaction_code for item in result.entries[2:]) == ("omitted", "invalid_utf8", "omitted")
    metadata = json.loads(result.manifest)["entries"]
    assert [(item["omitted_lines"], item["truncated"], item["redaction_code"]) for item in metadata] == [
        (0, False, "ok"), (0, False, "ok"), (1, False, "omitted"), (1, False, "invalid_utf8"), (2, True, "omitted")]
    # The same validated fixed codes survive direct reviewed reconstruction.
    for document, reviewed in zip((omitted, invalid_utf8, dropped), result.entries[2:]):
        reconstructed = ReviewedEntry(reviewed.alias, reviewed.data, reviewed.size, reviewed.sha256,
            reviewed.omitted_lines, reviewed.truncated, reviewed.redaction_code)
        assert reconstructed.data == document.data and reconstructed.redaction_code == document.code


def test_exact_entry_count_order_and_total_cap(monkeypatch):
    selections = tuple(LogSelection(kind, slot, redact_log((b"event=sync\n",)))
        for kind, maximum in (("parent", 3), ("worker", 8)) for slot in range(maximum))
    result = plan(selections)
    assert result is not None and len(result.entries) == 13
    assert result.entries[-1].alias == "logs/worker-7.log"
    assert plan(selections + (selections[0],)) is None
    assert plan(tuple(reversed(selections))).entries == result.entries
    monkeypatch.setattr(export, "MAX_PLAN_BYTES", result.total_bytes)
    assert plan(selections).total_bytes == result.total_bytes
    monkeypatch.setattr(export, "MAX_PLAN_BYTES", result.total_bytes - 1)
    assert plan(selections) is None


def test_entry_caps_and_exact_hash_length_are_enforced(monkeypatch):
    data = b"event=sync\n"
    assert entry("logs/agent-0.log", data).data == data
    with pytest.raises(ValueError, match="invalid_reviewed_entry"):
        ReviewedEntry("logs/agent-0.log", data, len(data) + 1, hashlib.sha256(data).hexdigest())
    with pytest.raises(ValueError, match="invalid_reviewed_entry"):
        ReviewedEntry("logs/agent-0.log", data, len(data), "0" * 64)
    monkeypatch.setattr(export, "MAX_LOG_BYTES", len(data) - 1)
    with pytest.raises(ValueError, match="entry_too_large"):
        entry("logs/agent-0.log", data)
    monkeypatch.setattr(export, "MAX_DOCUMENT_BYTES", 1)
    assert plan() is None


@pytest.mark.parametrize("stage", ["snapshot", "selections"])
@pytest.mark.parametrize("retirement", ["cancel", "owner_aba", "binding", "new_run"])
def test_held_export_callbacks_suppress_actual_old_bytes(stage, retirement):
    state = {"owner": "A", "epoch": 7, "binding": 3, "run": 2, "cancelled": False}
    captured = ("A", 7, 3, 2)
    calls = []
    private_ticket = {"owner": "A", "token": "credential-bearing-ticket"}

    def held(name, value):
        assert private_ticket["token"] == "credential-bearing-ticket"
        calls.append(name)
        if name == stage:
            if retirement == "cancel":
                state["cancelled"] = True
            elif retirement == "owner_aba":
                state.update(owner="B", epoch=8)
                state.update(owner="A", epoch=9)
            else:
                key = "binding" if retirement == "binding" else "run"
                state[key] += 1
        return value

    result = collect_export_plan(lambda: held("snapshot", snapshot()),
        lambda: held("selections", (LogSelection("parent", 0, redact_log((b"event=sync\n",))),)),
        is_current=lambda: (state["owner"], state["epoch"], state["binding"], state["run"]) == captured,
        is_cancelled=lambda: state["cancelled"])
    assert result is None
    assert calls == (["snapshot"] if stage == "snapshot" else ["snapshot", "selections"])


def test_guard_exception_finalization_and_callback_exception_suppress_plans(caplog):
    calls = []

    def current():
        calls.append(True)
        if len(calls) >= 3:
            raise RuntimeError("private-current-guard")
        return True

    assert plan(is_current=current) is None
    assert len(calls) == 3
    assert collect_export_plan(lambda: (_ for _ in ()).throw(RuntimeError("private-read")), lambda: (),
        is_current=lambda: True, is_cancelled=lambda: False) is None
    assert "private-current-guard" not in caplog.text and "private-read" not in caplog.text
    safe = repr(plan()) + repr(asdict(plan()))
    assert "credential-bearing-ticket" not in safe and "is_current" not in safe and "read_snapshot" not in safe


def test_forged_manifest_order_or_total_is_rejected():
    result = plan((LogSelection("parent", 0, redact_log((b"event=sync\n",))),))
    for entries, total, manifest, digest in (
        (tuple(reversed(result.entries)), result.total_bytes, result.manifest, result.manifest_sha256),
        (result.entries, result.total_bytes + 1, result.manifest, result.manifest_sha256),
        (result.entries, result.total_bytes, b"private-manifest", result.manifest_sha256),
        (result.entries, result.total_bytes, result.manifest, "0" * 64),
    ):
        with pytest.raises(ValueError, match="invalid_export_plan"):
            ExportPlan(entries, total, manifest, digest)


def test_actual_held_selection_callback_cannot_finalize_after_newer_run():
    entered, release = threading.Event(), threading.Event()
    state = {"run": 1}

    def held():
        entered.set()
        assert release.wait(5)
        return (LogSelection("parent", 0, redact_log((b"event=sync\n",))),)

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(collect_export_plan, snapshot, held,
            is_current=lambda: state["run"] == 1, is_cancelled=lambda: False)
        try:
            assert entered.wait(5)
            state["run"] = 2
            newer = plan((LogSelection("worker", 0, redact_log((b"event=worker\n",))),))
            assert newer is not None and newer.entries[2].data == b"event=worker\n"
        finally:
            release.set()
        assert future.result(timeout=5) is None
