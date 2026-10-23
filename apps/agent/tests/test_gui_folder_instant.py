from tests._gui_offscreen import run_gui_check


def test_real_runner_folder_add_remove_and_exact_undo(tmp_path):
    run_gui_check(tmp_path,"""
import logging
from unittest.mock import Mock
from sc2tools_agent import runner,replay_finder
from sc2tools_agent.state import AgentState,load_state
from sc2tools_agent.config import AgentConfig
replay_finder.candidate_documents_dirs=lambda:iter(())
folder=base/"2-S2-1-42"/"Replays"/"Multiplayer";folder.mkdir(parents=True)
state=AgentState(device_token="t",user_id="u1",uploaded={"kept":"dated"},replay_folders_excluded=["prior-exclusion"])
cell=runner._RuntimeCell();cell.no_obs=True;cell.upload=Mock()
cfg=AgentConfig(api_base="http://localhost:0",state_dir=base,replay_folder=None,poll_interval_sec=10,parse_concurrency=1)
ui,win=make_window(
    on_choose_folder=lambda path:runner._handle_choose_folder_gui(cfg,state,path,cell,logging.getLogger("test")),
    on_save_settings=lambda payload:runner._handle_save_settings(cfg,state,payload,cell,logging.getLogger("test")),
    on_restore_folders=lambda token:runner._restore_folder_snapshot(cfg,state,cell,token))
cell.gui=ui
win._go_to_page("settings");win.show();app.processEvents()
QtWidgets.QFileDialog.getExistingDirectory=lambda *args:str(folder)
def use_anyway():
    dialog=next(widget for widget in app.topLevelWidgets() if isinstance(widget,QtWidgets.QMessageBox))
    assert "has no replays" in dialog.text()
    next(button for button in dialog.buttons() if button.text()=="Use anyway").click()
QtCore.QTimer.singleShot(0,use_anyway)
win._add_folder_row();app.processEvents()
assert state.replay_folders_override==[str(folder)]
assert load_state(base).replay_folders_override==[str(folder)]
assert win._folder_undo_dash.isVisible()==False  # Settings page owns its visible Undo.
QtTest.QTest.qWait(100)
item=win._folder_list.item(0)
assert item.toolTip()==str(folder)
row=win._folder_list.itemWidget(item)
assert any("EU · 2-S2-1-42 · 0 replays" in label.text() for label in row.findChildren(QtWidgets.QLabel))
win._folder_undo.click();app.processEvents()
assert state.replay_folders_override==[] and state.replay_folders_excluded==["prior-exclusion"]
assert state.uploaded=={"kept":"dated"}
(folder/"one.SC2Replay").write_bytes(b"fixture")
win._click_choose_folder();app.processEvents()
win._folder_list.setCurrentRow(0);win._folder_list.setFocus();win.activateWindow();app.processEvents()
QtTest.QTest.keyClick(win._folder_list,QtCore.Qt.Key_Delete);app.processEvents()
assert state.replay_folders_override==[]
win._folder_undo.click();app.processEvents()
assert state.replay_folders_override==[str(folder)]
win.hide()
""")
