from pathlib import Path
from unittest.mock import Mock
from sc2tools_agent.pairing.flow import PairingUiState
from sc2tools_agent.runner import _Multiplexer, _handle_pause
from sc2tools_agent.state import AgentState, load_state
from sc2tools_agent.status_model import AgentStatus, StatusFacts


def test_unlinked_recovery_and_pause_use_one_model_for_all_sinks(tmp_path):
    one,two=Mock(),Mock()
    ui=_Multiplexer(one,two,facts=StatusFacts(paired=True,phase="ready",folders=[Path("2-S2-1-42")]))
    ui.on_unlinked()
    assert one.on_status_view.call_args.args[0].status==AgentStatus.UNLINKED
    ui.on_pairing_state(PairingUiState("requesting"))
    assert one.on_status_view.call_args.args[0].status==AgentStatus.NEEDS_PAIRING
    ui.on_paired("u1")
    cfg=Mock(state_dir=tmp_path);state=AgentState();upload=Mock()
    _handle_pause(cfg,state,upload,True,ui=ui,until=1234567890)
    assert state.paused and load_state(tmp_path).paused_until==1234567890
    upload.set_paused.assert_called_once_with(True)
    view=one.on_status_view.call_args.args[0]
    assert view.status==AgentStatus.PAUSED and "Paused until" in view.cause
    assert two.on_status_view.call_args.args[0]==view
    one.on_paused.assert_called_once_with(True,1234567890)
    _handle_pause(cfg,state,upload,False,ui=ui)
    assert not load_state(tmp_path).paused and load_state(tmp_path).paused_until is None
    assert one.on_status_view.call_args.args[0].status==AgentStatus.WATCHING
