"""SC2 UI semantics accept qualified panel names without changing diagnostics."""
import pytest

from sc2tools_agent.live.types import (
    LiveLifecycleEvent,
    LiveLifecyclePhase,
    LiveUIState,
    envelope_for,
)


SC2_SHELL = [
    "ScreenBackgroundSC2/ScreenBackgroundSC2",
    "ScreenNavigationSC2/ScreenNavigationSC2",
    "ScreenForegroundSC2/ScreenForegroundSC2",
]


@pytest.mark.parametrize("screens,loading,score,in_match", [
    ([], False, False, True),
    (["ForegroundScreen"], False, False, True),
    (SC2_SHELL, False, False, True),
    (["ScreenLoading"], True, False, False),
    (["ScreenLoading/ScreenLoading"], True, False, False),
    (["ScreenScore"], False, True, False),
    (SC2_SHELL + ["ScreenScore/ScreenScore"], False, True, False),
    (["ScreenHome"], False, False, False),
    (SC2_SHELL + ["ScreenHome/ScreenHome"], False, False, False),
    (["ScreenMenu"], False, False, False),
    (["ScreenMenu/ScreenMenu"], False, False, False),
    (["ScreenLoading/ScreenLoading", "ScreenScore/ScreenScore"], True, True, False),
    (["ScreenForegroundSC2/ScreenScore"], False, False, True),
])
def test_screen_semantics_preserve_raw_panel_paths(screens, loading, score, in_match):
    raw = list(screens)
    state = LiveUIState(active_screens=list(raw))
    assert state.is_loading is loading
    assert state.is_score_screen is score
    assert state.is_in_match is in_match
    assert state.active_screens == raw
    event = LiveLifecycleEvent(phase=LiveLifecyclePhase.MENU, ui_state=state)
    assert envelope_for(event)["uiScreens"] == raw
