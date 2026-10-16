"""SC2 UI semantics accept qualified panel names without changing diagnostics."""
import pytest

from sc2tools_agent.live.types import (
    LiveGameState,
    LiveLifecycleEvent,
    LiveLifecyclePhase,
    LiveUIState,
    LivePlayer,
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


@pytest.mark.parametrize("hint", [None, "", "OldBattleTag#1234", "123456"])
@pytest.mark.parametrize("reverse", [False, True])
def test_unmatched_local_identity_never_guesses_from_player_order(hint, reverse):
    players = [
        LivePlayer("ActualOpponent", "user", "Terran", "Undecided"),
        LivePlayer("karpidis", "user", "Zerg", "Undecided"),
    ]
    state = LiveGameState(players=players[::-1] if reverse else players)
    assert state.user_for(hint) is None
    assert state.opponent_for(hint) is None
    assert state.user_for("karpidis").name == "karpidis"
    assert state.opponent_for("karpidis").name == "ActualOpponent"


def test_duplicate_names_in_1v1_remain_unresolved():
    state = LiveGameState(players=[
        LivePlayer("[One] Barcode", "user", "Terran", "Undecided"),
        LivePlayer("[Two] Barcode", "user", "Zerg", "Undecided"),
    ])
    assert state.user_for("Barcode") is None
    assert state.opponent_for("Barcode") is None
