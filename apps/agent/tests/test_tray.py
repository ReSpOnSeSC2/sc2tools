"""Tests for sc2tools_agent.ui.tray — the pystray-free surface.

``TrayUI``'s constructor and runner-facing callbacks never import
pystray (only ``start()`` does), so the synced-counter seeding, the
tooltip lines, and the show-window plumbing are all unit-testable in
a bare environment.
"""

from __future__ import annotations

from sc2tools_agent.health import HealthSnapshot
from sc2tools_agent.ui.tray import TrayUI


def test_synced_counter_seeds_from_provider() -> None:
    """Until the health monitor first reports, the tooltip's "N synced"
    starts from the authoritative state-backed count, not 0, so a
    restart doesn't zero the stat."""
    tray = TrayUI(
        dashboard_url="https://example.test",
        synced_count_provider=lambda: 437,
    )
    assert tray._uploaded == 437
    assert "437 synced" in tray._title(None)


def test_title_is_the_windows_headline_once_health_reports() -> None:
    """Once health reports, the title is the status card's headline,
    so the tray and the window never disagree. The pause marker and
    the upload counts no longer change it."""
    tray = TrayUI(
        dashboard_url="https://example.test",
        synced_count_provider=lambda: 437,
        initial_paused=True,
    )
    tray.on_health(HealthSnapshot("1 thing needs attention", 1, "warn", "grey"))
    tray.on_upload_success("game.SC2Replay")
    assert tray._title(None) == "1 thing needs attention"
    assert tray._tooltip() == "SC2 Tools - 1 thing needs attention"


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


def test_build_checkin_callback_fires_and_errors_are_contained() -> None:
    fired = {"n": 0}

    def reopen() -> None:
        fired["n"] += 1
        if fired["n"] == 2:
            raise RuntimeError("controller stopped")

    tray = TrayUI(dashboard_url="https://example.test", on_build_checkin=reopen)
    tray._build_checkin_clicked(None, None)
    tray._build_checkin_clicked(None, None)  # must not raise
    assert fired["n"] == 2
    TrayUI(dashboard_url="https://example.test")._build_checkin_clicked(None, None)


class _FakeMenu:
    SEPARATOR = object()

    def __init__(self, *items) -> None:
        self.items = items


class _FakeItem:
    def __init__(self, text, action, **kwargs) -> None:
        self.text = text
        self.action = action


class _FakePystray:
    Menu = _FakeMenu
    MenuItem = _FakeItem


def _labels(tray: TrayUI) -> list:
    menu = tray._build_menu(_FakePystray)
    return [item.text for item in menu.items if isinstance(item, _FakeItem) and isinstance(item.text, str)]


def test_build_checkin_menu_item_only_when_wired() -> None:
    wired = TrayUI(
        dashboard_url="https://example.test",
        on_show_window=lambda: None,
        on_build_checkin=lambda: None,
    )
    labels = _labels(wired)
    assert labels.index("Build check-in…") == labels.index("Open dashboard") + 1
    assert "Build check-in…" not in _labels(TrayUI(dashboard_url="https://example.test"))
