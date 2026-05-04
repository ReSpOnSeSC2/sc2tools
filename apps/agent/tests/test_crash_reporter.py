"""Tests for sc2tools_agent.crash_reporter."""

from __future__ import annotations

import logging

from sc2tools_agent import crash_reporter
from sc2tools_agent.crash_reporter import (
    _before_breadcrumb,
    _before_send,
    _is_pii_key,
    _redact_string,
    _redact_value,
    init_crash_reporter,
)


def test_init_crash_reporter_no_dsn_returns_false(monkeypatch) -> None:
    monkeypatch.delenv("SC2TOOLS_SENTRY_DSN", raising=False)
    monkeypatch.delenv("SENTRY_DSN", raising=False)
    crash_reporter._SENTRY = None
    assert init_crash_reporter() is False


def test_init_crash_reporter_invalid_dsn_returns_false(caplog) -> None:
    caplog.set_level(logging.WARNING)
    crash_reporter._SENTRY = None
    assert init_crash_reporter(dsn="not-a-dsn") is False
    assert any("invalid_dsn" in record.message for record in caplog.records)


def test_is_pii_key_recognises_known_fragments() -> None:
    assert _is_pii_key("battle_tag")
    assert _is_pii_key("BattleTag")
    assert _is_pii_key("user_email")
    assert _is_pii_key("device_token")
    assert not _is_pii_key("favourite_colour")
    assert not _is_pii_key(123)


def test_redact_string_strips_home_paths_and_keeps_replay_basenames() -> None:
    out = _redact_string(
        r"C:\Users\jay\Replays\Multiplayer\Game (10).SC2Replay",
    )
    assert "C:\\Users\\jay" not in out
    assert "<user-home>" in out
    # The replay basename survives so debug breadcrumbs are still useful.
    assert "Game (10).SC2Replay" in out


def test_redact_string_caps_long_strings() -> None:
    big = "x" * 5000
    out = _redact_string(big)
    assert "[…truncated]" in out
    assert len(out) < 5000


def test_redact_value_walks_nested_structures() -> None:
    event = {
        "user": {"battleTag": "Foo#1234", "race": "Protoss"},
        "extra": [
            {"display_name": "Bar"},
            "C:\\Users\\jay\\Documents\\file.txt",
        ],
        "tags": {"safe": "ok"},
    }
    redacted = _redact_value(event, depth=0)
    assert redacted["user"]["battleTag"] == "[redacted]"
    assert redacted["user"]["race"] == "Protoss"
    assert redacted["extra"][0]["display_name"] == "[redacted]"
    assert "<user-home>" in redacted["extra"][1]
    # Sentry's "tags" envelope key is intentionally NOT considered PII.
    assert redacted["tags"]["safe"] == "ok"


def test_before_send_returns_redacted_dict() -> None:
    event = {"contexts": {"app": {"battleTag": "X"}}}
    out = _before_send(event, {})
    assert out["contexts"]["app"]["battleTag"] == "[redacted]"


def test_before_breadcrumb_redacts_pii_path() -> None:
    crumb = {"data": {"battle_tag": "Foo#1234", "filename": "foo.SC2Replay"}}
    out = _before_breadcrumb(crumb, {})
    assert out["data"]["battle_tag"] == "[redacted]"
    # Replay filenames stay so debug breadcrumbs remain useful.
    assert out["data"]["filename"] == "foo.SC2Replay"


def test_before_breadcrumb_strips_home_paths() -> None:
    crumb = {"data": {"path": r"C:\Users\jay\Documents\foo.SC2Replay"}}
    out = _before_breadcrumb(crumb, {})
    assert "<user-home>" in out["data"]["path"]
    assert "foo.SC2Replay" in out["data"]["path"]
