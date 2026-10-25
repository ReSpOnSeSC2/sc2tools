from tests._gui_offscreen import run_gui_check


def test_real_local_activation_shows_hidden_window(tmp_path):
    run_gui_check(tmp_path, """
import subprocess,sys,os
from sc2tools_agent.activation import listen,server_name
layouts=[]
ui,win=make_window(window_page="companion",on_window_information_layout=layouts.append)
win._set_window_size("Compact")
win.hide()
pin=win._companion_page.overlays["opponent"]
pin_size=pin.size()
server=listen(base,win._on_show_requested,parent=win)
assert server_name(base)!=server_name(base/"other")
script="from pathlib import Path;from sc2tools_agent.activation import activate_existing;import sys;print(activate_existing(Path(sys.argv[1])))"
child=subprocess.Popen([sys.executable,"-c",script,str(base)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
while child.poll() is None:
    QtTest.QTest.qWait(10)
stdout,stderr=child.communicate(timeout=2)
QtTest.QTest.qWait(20)
assert child.returncode==0 and stdout.strip()=="True",(stdout,stderr)
assert win.isVisible()
assert win.size().toTuple()==(520,480)
assert win._companion_page.current_density()=="standard"
assert layouts==["compact","standard"]
assert pin.size()==pin_size
server.close(); win.hide()
""")
