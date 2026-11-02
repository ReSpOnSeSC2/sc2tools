"""Adversarial bounded synthetic log snapshots; assert the actual output bytes."""
from dataclasses import FrozenInstanceError

import pytest

from sc2tools_agent import support_redaction as redaction
from sc2tools_agent.support_redaction import (
    MAX_BINDINGS, MAX_BINDING_BYTES, MAX_LINE_BYTES, MAX_LOG_BYTES, MAX_RAW_BYTES,
    OMITTED, REDACTED, RedactedLog, redact_log, redact_record,
)


SENTINELS = (
    "device_token=private-device-secret", "ObS_PassWord: private-obs-secret",
    "OAuth_Refresh_Token=private-oauth-secret", "Authorization: Bearer private-bearer-secret",
    "eyJhbGciOiJIUzI1NiJ9.privateJWTpayload.privateJWTsignature",
    "\u73a9\u5bb6\u540d#12345", "privateperson@example.test", "1-S2-1-987654321",
    r"D:\private-volume\private-player\Secret.SC2Replay",
    r"\\private-server\private-share\private-player\Secret.SC2Replay",
    "/srv/private-user/private-replays/Secret.SC2Replay", "SecretOnly.SC2Replay",
    "https://private-user:private-password@api.example.test/private-route?token=private-query#private-fragment",
    "ordinary-unclassified-private-name",
)


@pytest.mark.parametrize("sentinel", SENTINELS)
def test_sensitive_and_uncertain_free_text_never_survives(sentinel, caplog):
    raw = ("2026-11-02T12:00:00Z ERROR " + sentinel + "\n" + "traceback: " + sentinel + "\n").encode()
    result = redact_log((raw,))
    assert sentinel.encode() not in result.data
    assert result.data in {(OMITTED + "\n" + OMITTED + "\n").encode(), (REDACTED + "\n" + OMITTED + "\n").encode()}
    assert all(line in {OMITTED.encode(), REDACTED.encode()} for line in result.data.splitlines())
    assert sentinel not in caplog.text
    assert len(result.data) <= MAX_LOG_BYTES


def test_projected_log_and_structured_records_keep_only_closed_values():
    raw = b"2026-11-02T12:00:00Z INFO event=sync pending=3 error=offline\ncount=7 latency_ms=12.25\n"
    assert redact_log((raw,)).data == b"event=sync pending=3 error=offline\ncount=7 latency_ms=12.25\n"
    record = {"event": "sync", "pending": 3, "latency_ms": 12.25, "error": "offline",
        "DEVICE_TOKEN": "private-device", "oBsPaSsWoRd": "private-obs", "user": "private-player",
        "detail": "private-exception", "nested": {"email": "privateperson@example.test"}}
    result = redact_record(record)
    assert result.data == b"event=sync pending=3 latency_ms=12.25 error=offline\n"
    assert record["DEVICE_TOKEN"] == "private-device"
    assert result.omitted_lines == 0 and result.code == "ok"


def test_sensitive_binding_can_remove_otherwise_safe_literal():
    result = redact_log((b"event=sync error=offline\n",), sensitive_values=("offline",))
    assert b"offline" not in result.data
    assert result.data == b"[omitted]\n"
    assert result.omitted_lines == 1
    # Exact sensitive lines become a fixed redacted marker, not an empty line.
    assert redact_log((b"private-secret\n",), sensitive_values=("private-secret",)).data == b"[redacted]\n"


def test_every_sensitive_boundary_is_joined_before_redaction():
    value = "split-device-secret-12345"
    raw = ("event=sync pending=3\nAuthorization: Bearer " + value + "\n").encode()
    for boundary in range(len(raw) + 1):
        result = redact_log((raw[:boundary], raw[boundary:]), sensitive_values=(value,))
        assert result.data == b"event=sync pending=3\n[omitted]\n"
        assert value.encode() not in result.data
    unicode_raw = "\u73a9\u5bb6#1234\n".encode()
    for boundary in range(len(unicode_raw) + 1):
        result = redact_log((unicode_raw[:boundary], unicode_raw[boundary:]))
        assert unicode_raw[:-1] not in result.data and result.code != "invalid_utf8"


def test_truncated_tail_and_unfinished_final_line_are_omitted_whole():
    result = redact_log((b"pending=123\nevent=sync\npending=99",), starts_mid_line=True)
    assert result.data == b"[omitted]\nevent=sync\n[omitted]\n"
    assert result.omitted_lines == 2 and result.truncated is True
    for part in (b"pending=123", b"token=private", b"private-remainder"):
        result = redact_log((part,), starts_mid_line=True)
        assert result.data == b"[omitted]\n" and part not in result.data


@pytest.mark.parametrize("raw", [b"private\xff\n", b"\xc3\n", b"\xed\xa0\x80\n"])
def test_invalid_utf8_fails_closed_without_partial_decode(raw):
    result = redact_log((raw,))
    assert result.code == "invalid_utf8" and result.data == b"[omitted]\n"


@pytest.mark.parametrize("raw", [b"event=sync\x1b[31m\n", b"event=sync\rpending=4\n", b"event=sync\x00\n",
    "event=sync\u202e\n".encode(), b"event=sync\tprivate-name\n"])
def test_controls_ansi_and_bare_cr_never_create_trusted_records(raw):
    result = redact_log((raw,))
    assert result.data == b"[omitted]\n" and result.omitted_lines == 1


def test_crlf_physical_lines_remain_safe():
    # CR is stripped only when it is the physical CRLF terminator.
    result = redact_log((b"event=sync\r\n",))
    assert result.data == b"event=sync\n"


def test_huge_lines_and_raw_input_reject_without_partial_token_truncation():
    line = b"private-sensitive-" + b"x" * MAX_LINE_BYTES + b"\nevent=sync\n"
    result = redact_log((line,))
    assert result.data == b"[omitted]\nevent=sync\n" and result.truncated
    assert result.omitted_lines == 1
    result = redact_log((b"x" * (MAX_RAW_BYTES + 1),))
    assert result.data == b"[omitted]\n" and result.code == "input_too_large" and result.truncated
    assert redact_log((b"x" * MAX_RAW_BYTES,)).code == "omitted"


def test_log_output_cap_retains_complete_projected_lines_with_metadata(monkeypatch):
    # Small injected policy makes the exact boundary cheap to exercise.
    monkeypatch.setattr(redaction, "MAX_LOG_BYTES", 22)
    result = redact_log((b"event=sync\nevent=sync\nevent=sync\n",))
    assert result.data == b"event=sync\nevent=sync\n"
    assert len(result.data) == 22 and result.truncated and result.omitted_lines == 1


def test_log_output_cap_counts_rejected_unknown_current_line_once(monkeypatch):
    monkeypatch.setattr(redaction, "MAX_LOG_BYTES", 22)
    result = redact_log((b"event=sync\nevent=sync\nprivate\n",))
    assert result.data == b"event=sync\nevent=sync\n"
    assert result.omitted_lines == 1 and result.truncated and result.code == "omitted"


def test_real_log_output_cap_bounds_expanded_omission_lines():
    # Short raw lines expand to markers: this reaches the production output
    # policy without changing the constant that the assertion must protect.
    result = redact_log((b"x\n" * 60_000,))
    assert len(result.data) <= 512 * 1024
    assert result.data == b"[omitted]\n" * (len(result.data) // len(b"[omitted]\n"))
    assert result.data and result.data.endswith(b"[omitted]\n")
    assert result.truncated is True and result.omitted_lines == 60_000
    assert result.code == "omitted"


@pytest.mark.parametrize("values", [("x" * 4097,), ("secret",) * (MAX_BINDINGS + 1), ("\ud800",), ("",), "private-secret",
    ("event=sync\npending=3",), ("private\rsecret",), ("private\tsecret",)])
def test_invalid_bindings_are_rejected_whole(values):
    result = redact_log((b"event=sync\n",), sensitive_values=values)
    assert result.data == b"[omitted]\n" and result.code == "invalid_bindings"


def test_binding_total_bytes_cap_and_exact_count():
    exact = tuple(str(i).zfill(4) + "x" * 1020 for i in range(64))
    assert sum(len(value.encode()) for value in exact) == MAX_BINDING_BYTES
    assert redact_log((b"event=sync\n",), sensitive_values=exact).data == b"event=sync\n"
    too_big = exact[:-1] + (exact[-1] + "x",)
    assert redact_log((b"event=sync\n",), sensitive_values=too_big).code == "invalid_bindings"


class Hostile:
    def __str__(self):
        raise AssertionError("stringified secret")

    def __bool__(self):
        raise AssertionError("coerced secret")


def test_unknown_nested_records_and_nonprimitive_values_are_not_serialized():
    result = redact_record({"event": Hostile(), "pending": Hostile(), "error": Hostile(), "details": [Hostile()]})
    assert result.data == b"[omitted]\n" and result.omitted_lines == 1 and result.code == "omitted"
    assert redact_log((Hostile(),)).code == "invalid_input"
    assert redact_log((b"event=sync\n",), sensitive_values=(Hostile(),)).code == "invalid_bindings"
    assert redact_log((b"event=sync\n",), starts_mid_line=Hostile()).code == "invalid_input"
    nested = {}
    nested["recursive"] = nested
    assert redact_record(nested).data == b"[omitted]\n"


def test_mutable_chunk_and_binding_containers_leave_only_frozen_safe_output():
    raw = bytearray(b"event=sync\n")
    chunks, bindings = [raw], ["sync"]
    result = redact_log(chunks, sensitive_values=bindings)
    raw[:] = b"private-secret\n"
    chunks[:] = [b"private-new-chunk\n"]
    bindings[:] = ["different-secret"]
    assert result.data == b"[omitted]\n" and result.omitted_lines == 1
    assert redact_log([bytearray(b"x" * (MAX_RAW_BYTES + 1))]).code == "input_too_large"
    assert redact_log([b"event=sync\n"] * 1025).code == "invalid_input"
    unknown = redact_record({"private_key": "private-value"})
    assert unknown.data == b"[omitted]\n" and unknown.omitted_lines == 1 and unknown.code == "omitted"


def test_colliding_custom_structured_key_does_not_invoke_equality():
    invoked = []

    class Key:
        def __hash__(self):
            return hash("event")

        def __eq__(self, other):
            invoked.append(other)
            raise AssertionError("private equality callback")

    result = redact_record({Key(): "private-name"})
    assert result.data == b"[omitted]\n" and invoked == []


def test_redacted_value_defensively_copies_and_rejects_forged_raw_payload():
    buffer = bytearray(b"event=sync\n")
    result = RedactedLog(buffer)
    buffer[:] = b"private!!!!"
    assert result.data == b"event=sync\n" and type(result.data) is bytes
    with pytest.raises(FrozenInstanceError):
        result.data = b"private\n"
    for raw in (b"private-secret\n", b"event=private\n", b"event=sync", b"event=sync\nprivate\n",
        b"event=sync\x1cevent=sync\n", b"event=sync\r\n"):
        with pytest.raises(ValueError, match="invalid_redacted_log"):
            RedactedLog(raw)


@pytest.mark.parametrize("data,omitted,truncated,code", [
    (b"[omitted]\n", 0, False, "ok"),
    (b"[omitted]\n[omitted]\n", 1, False, "omitted"),
    (b"event=sync\n", 1, False, "ok"),
    (b"event=sync\n", 0, True, "ok"),
    (b"event=sync\n", 0, False, "omitted"),
    (b"event=sync\n", 1, False, "omitted"),
    (b"event=sync\n", 1, False, "invalid_utf8"),
    (b"[omitted]\n", 1, True, "invalid_utf8"),
    (b"[omitted]\n", 1, False, "input_too_large"),
])
def test_direct_redacted_values_reject_incoherent_omission_metadata(data, omitted, truncated, code):
    with pytest.raises(ValueError, match="invalid_redacted_log"):
        RedactedLog(data, omitted, truncated, code)


def test_direct_redacted_values_allow_truthful_markers_and_additional_cap_drops():
    visible = RedactedLog(b"[omitted]\n", 1, False, "omitted")
    dropped = RedactedLog(b"event=sync\n", 2, True, "omitted")
    assert visible.data == b"[omitted]\n" and visible.omitted_lines == 1
    assert dropped.data == b"event=sync\n" and dropped.omitted_lines == 2 and dropped.truncated
