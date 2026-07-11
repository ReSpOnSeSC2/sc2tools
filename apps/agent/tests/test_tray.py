"""Tests for sc2tools_agent.ui.tray — the pystray-free surface.

``TrayUI``'s constructor and runner-facing callbacks never import
pystray (only ``start()`` does), so the synced-counter seeding, the
tooltip lines, and the show-window plumbing are all unit-testable in
a bare environment.
"""

from __future__ import annotations

from sc2tools_agent.ui.tray import TrayUI


def test_synced_counter_seeds_from_provider() -> None:
    """The tooltip's "N synced" must start from the authoritative
    state-backed count, not 0, so a restart doesn't zero the stat."""
    tray = TrayUI(
        dashboard_url="https://example.test",
        synced_count_provider=lambda: 437,
    )
    assert tray._uploaded == 437
    assert "437 synced" in tray._title(None)


def test_synced_counter_requeries_on_upload_success() -> None:
    counts = iter([10, 11])
    tray = TrayUI(
        dashboard_url="https://example.test",
        synced_count_provider=lambda: next(counts),
    )
    assert tray._uploaded == 10
    tray.on_upload_success("game.SC2Replay")
    assert tray._uploaded == 11


def test_synced_counter_falls_back_without_provider() -> None:
    """Legacy behaviour when no provider is wired (headless installs
    constructed by older call sites): session-local increment."""
    tray = TrayUI(dashboard_url="https://example.test")
    assert tray._uploaded == 0
    tray.on_upload_success("game.SC2Replay")
    assert tray._uploaded == 1


def test_synced_counter_survives_provider_errors() -> None:
    """A provider that raises must never break an upload callback —
    fall back to the legacy increment for that tick."""
    calls = {"n": 0}

    def flaky() -> int:
        calls["n"] += 1
        if calls["n"] == 1:
            return 5
        raise RuntimeError("state file busy")

    tray = TrayUI(
        dashboard_url="https://example.test",
        synced_count_provider=flaky,
    )
    assert tray._uploaded == 5
    tray.on_upload_success("game.SC2Replay")
    assert tray._uploaded == 6  # 5 + legacy fallback increment


def test_show_window_callback_fires() -> None:
    fired = {"n": 0}

    def show() -> None:
        fired["n"] += 1

    tray = TrayUI(
        dashboard_url="https://example.test",
        on_show_window=show,
    )
    tray._show_window_clicked(None, None)
    assert fired["n"] == 1


def test_show_window_click_is_safe_without_callback() -> None:
    """No-GUI installs construct the tray without the callback; the
    handler must be a silent no-op, and the menu builder must omit
    the item (guarded by the same attribute)."""
    tray = TrayUI(dashboard_url="https://example.test")
    tray._show_window_clicked(None, None)  # must not raise
    assert tray._on_show_window_cb is None
