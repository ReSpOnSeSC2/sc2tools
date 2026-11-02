import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
from PIL import Image
from sc2tools_agent.health import BootFailure, HealthMonitor, HealthSnapshot
from sc2tools_agent.runner import _Multiplexer
from sc2tools_agent.status_model import StatusFacts
from sc2tools_agent.ui.tray import TrayUI
from sc2tools_agent.ui.tray_images import _square_pad,render_tray_image,dot_color
from sc2tools_agent.ui import palette
from tests.test_tray import _FakePystray,_FakeItem


def test_padding_preserves_nontransparent_aspect_and_status_colors():
    source=Image.new("RGBA",(1347,1133),"cyan")
    result=_square_pad(source).resize((256,256))
    bounds=result.getbbox(); ratio=(bounds[2]-bounds[0])/(bounds[3]-bounds[1])
    assert abs(ratio/(1347/1133)-1)<.03
    # Four dots, one per HealthSnapshot.tray level; none while starting, and no cyan or blue.
    colors={"green":palette.GREEN,"amber":palette.AMBER,"red":palette.RED,"grey":palette.GREY,None:None}
    for level,color in colors.items():
        assert dot_color(level)==color
        if color:
            from PIL import ImageColor
            assert render_tray_image(source,color).getpixel((50,50))[:3]==ImageColor.getrgb(color)


def test_icon_only_reassigned_when_color_changes():
    class Icon:
        def __init__(self):self.assignments=0;self.title=""
        @property
        def icon(self):return None
        @icon.setter
        def icon(self,value):self.assignments+=1
    tray=TrayUI(dashboard_url="https://example.test")
    tray._icon=Icon(); tray._base_icon=Image.new("RGBA",(64,64))
    tray.on_health(HealthSnapshot("Starting SC2 Tools…",0,"ok",None))  # the plain icon, no dot
    tray.on_health(HealthSnapshot("1 thing needs attention",1,"warn","amber"))
    tray.on_health(HealthSnapshot("2 things need attention",2,"warn","amber"))
    assert tray._icon.assignments==2 and tray._icon.title=="SC2 Tools - 2 things need attention"
    tray.on_health(HealthSnapshot("Everything's working",0,"ok","green"))
    assert tray._icon.assignments==3 and tray._title(None)=="Everything's working"


def test_tray_title_and_dot_follow_the_windows_health_snapshot():
    tray=TrayUI(dashboard_url="https://example.test")
    tray._icon=SimpleNamespace(title="",icon=None); tray._base_icon=Image.new("RGBA",(64,64))
    assert not hasattr(tray,"on_status_view")  # the StatusView now only feeds the console
    ui=_Multiplexer(Mock(),tray,facts=StatusFacts(paired=True),
                    health=HealthMonitor(schedule=lambda delay,callback:callback()))
    assert (tray._title(None),tray._icon_color)==("Starting SC2 Tools…",None)  # no dot while starting
    ui.on_folders([Path("2-S2-1-42")]); ui.on_phase("ready")
    snapshot=ui.health.snapshot()
    assert (tray._title(None),tray._icon.title)==(snapshot.headline,"SC2 Tools - "+snapshot.headline)
    assert (snapshot.headline,tray._icon_color)==("Everything's working",palette.GREEN)
    ui.on_paused(True)
    assert (tray._title(None),tray._icon_color)==("1 thing needs attention",palette.GREY)
    now=time.time()
    ui.on_paused(False); ui.on_pending(5); ui.on_connection_state("offline",now,now+30,5)
    assert (tray._title(None),tray._icon_color)==("1 thing needs attention",palette.AMBER)
    ui.health.set_boot_error(BootFailure("network","Check your internet connection."))
    assert (tray._title(None),tray._icon_color)==("SC2 Tools couldn't reach sc2tools.com",palette.RED)


def test_seeded_pause_menu_and_gui_folder_path():
    selected=[]; shown=[]; resync=[]
    tray=TrayUI(dashboard_url="https://example.test",initial_paused=True,
        on_show_window=lambda:shown.append(True),on_choose_folder=selected.append,
        on_resync=lambda:resync.append(True),on_pause_for=lambda _:None)
    assert tray._pause_label(None)=="Resume syncing"
    tray._resync_clicked(None,None); assert not resync
    menu=tray._build_menu(_FakePystray)
    labels=[item.text for item in menu.items if isinstance(item,_FakeItem)]
    assert "More" in labels and "Pause" in labels and "Open SC2 Tools" in labels
    more=next(item for item in menu.items if isinstance(item,_FakeItem) and item.text=="More")
    assert [item.text for item in more.action.items]==["Add replay folder…","Re-sync library…","Open log folder","Check for updates"]
    tray._choose_folder_clicked(None,None)
    assert shown==[True] and selected==[None]
