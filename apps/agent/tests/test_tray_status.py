from types import SimpleNamespace
from unittest.mock import Mock
from PIL import Image
from sc2tools_agent.status_model import AgentStatus, StatusView
from sc2tools_agent.ui.tray import TrayUI
from sc2tools_agent.ui.tray_images import _square_pad,render_tray_image,dot_color
from sc2tools_agent.ui import palette
from tests.test_tray import _FakePystray,_FakeItem


def test_padding_preserves_nontransparent_aspect_and_status_colors():
    source=Image.new("RGBA",(1347,1133),"cyan")
    result=_square_pad(source).resize((256,256))
    bounds=result.getbbox(); ratio=(bounds[2]-bounds[0])/(bounds[3]-bounds[1])
    assert abs(ratio/(1347/1133)-1)<.03
    colors={AgentStatus.WATCHING:palette.GREEN,AgentStatus.SYNCING:palette.CYAN,
        AgentStatus.PAUSED:palette.GREY,AgentStatus.NEEDS_PAIRING:palette.AMBER,
        AgentStatus.UNLINKED:palette.AMBER,AgentStatus.NEEDS_ATTENTION:palette.AMBER,
        AgentStatus.ERROR:palette.RED,AgentStatus.STARTING:None,AgentStatus.CONNECTING:None}
    for status,color in colors.items():
        view=StatusView(status,"badge","ok","headline")
        assert dot_color(view)==color
        if color:
            from PIL import ImageColor
            assert render_tray_image(source,color).getpixel((50,50))[:3]==ImageColor.getrgb(color)
    assert dot_color(StatusView(AgentStatus.WATCHING,"Watching","ok","headline",update_pending=True))==palette.BLUE


def test_icon_only_reassigned_when_color_changes():
    class Icon:
        def __init__(self):self.assignments=0;self.title=""
        @property
        def icon(self):return None
        @icon.setter
        def icon(self,value):self.assignments+=1
    tray=TrayUI(dashboard_url="https://example.test")
    tray._icon=Icon(); tray._base_icon=Image.new("RGBA",(64,64))
    tray.on_status_view(StatusView(AgentStatus.WATCHING,"Watching","ok","one"))
    tray.on_status_view(StatusView(AgentStatus.WATCHING,"Watching","ok","two"))
    assert tray._icon.assignments==1 and tray._icon.title=="SC2 Tools - two"
    tray.on_status_view(StatusView(AgentStatus.SYNCING,"Syncing","info","three"))
    assert tray._icon.assignments==2


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
