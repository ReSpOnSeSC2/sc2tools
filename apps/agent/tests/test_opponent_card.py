import pytest

from sc2tools_agent.ui import opponent_card
from sc2tools_agent.ui.opponent_card import opponent_asset_root, opponent_identity, opponent_record
from tests._gui_offscreen import run_gui_check


def run_card_check(tmp_path, body):
    font_setup = '''
import os
fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
for name in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf"):
    path = fonts / name
    if path.is_file():
        QtGui.QFontDatabase.addApplicationFont(str(path))
'''
    run_gui_check(tmp_path, font_setup + body)


@pytest.mark.parametrize("race,expected", [("Z", "Zerg"), ("protoss", "Protoss"), (" Terran ", "Terran"), ("R", "Random"), (None, "—"), ("Terrible", "—")])
def test_identity_normalizes_only_real_race_aliases(race, expected):
    assert opponent_identity("  Opponent   name  ", race, 5189) == {"name": "Opponent name", "race": expected, "mmr": "5189"}


@pytest.mark.parametrize("mmr", [None, "5189", True, False, 0, -1, float("nan"), float("inf"), 10 ** 400])
def test_unknown_mmr_never_becomes_an_invented_rating(mmr):
    assert opponent_identity(None, None, mmr) == {"name": "—", "race": "—", "mmr": "—"}


def test_asset_root_supports_source_and_bundled_installations(tmp_path, monkeypatch):
    assert (opponent_asset_root() / "units" / "hydralisk.png").is_file()
    module = tmp_path / "package" / "sc2tools_agent" / "ui" / "opponent_card.py"
    bundled = module.parent / "assets" / "sc2"
    bundled.mkdir(parents=True)
    monkeypatch.setattr(opponent_card, "__file__", str(module))
    assert opponent_asset_root() == bundled


def test_compact_card_has_identity_record_real_artwork_and_one_expand_action(tmp_path):
    run_card_check(tmp_path, '''
        from sc2tools_agent.ui.opponent_card import build_opponent_card
        card = build_opponent_card(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
        card.resize(420, 44)
        card.show()
        calls = []
        card.enlargeRequested.connect(lambda: calls.append("expand"))
        for race, unit in [("Zerg", "hydralisk"), ("Terran", "marine"), ("Protoss", "zealot")]:
            card.set_identity("GoldChain", race, 5189, wins=2, losses=1)
            app.processEvents()
            assert card.identity == {"name": "GoldChain", "race": race, "mmr": "5189"}
            assert card.portrait.asset_path.name == unit + ".png"
            assert not card.portrait._image.isNull()
        assert sorted(label.text() for label in card.findChildren(QtWidgets.QLabel)) == sorted(["GoldChain", "Protoss", "5189", "RACE", "MMR", "YOUR RECORD", "YOUR WIN RATE", "2W · 1L", "66.7%"])
        assert card.record == {"wins": 2, "losses": 1, "text": "2W · 1L", "winRate": "66.7%"}
        assert all(label.textFormat() == QtCore.Qt.PlainText for label in card.findChildren(QtWidgets.QLabel))
        assert card.enlarge_button.accessibleName() == "Enlarge Companion"
        assert card.enlarge_button.text() == "Expand"
        assert card.scouting_button.text() == ""
        assert card.scouting_button.isVisible()
        assert not card.enlarge_button.isVisible()
        assert [button for button in card.findChildren(QtWidgets.QToolButton) if button.isVisible()] == [card.scouting_button]
        assert card.portrait.isHidden()
        card.enlarge_button.click()
        assert calls == ["expand"]
        assert card.grab().save(str(base / "opponent-compact.png"))
        card.close()
    ''')


def test_small_compact_geometry_keeps_fields_and_button_inside_the_card(tmp_path):
    run_card_check(tmp_path, '''
        from sc2tools_agent.ui.opponent_card import build_opponent_card
        card = build_opponent_card(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
        card.set_identity("A very long opponent name that must not cover the portrait or rating", "Protoss", 5189, wins=0, losses=12)
        card.resize(360, 40)
        card.show()
        app.processEvents()
        assert card.size().toTuple() == (360, 40)
        for child in [card.name_label, card.race_label, card.mmr_label, card.race_caption, card.mmr_caption, card.scouting_button,
                      card.record_caption, card.record_label, card.win_rate_caption, card.win_rate_label]:
            assert card.rect().contains(child.geometry()), (child.objectName(), child.geometry().getRect())
        assert card.portrait.isHidden()
        assert card.name_label.geometry().right() < card.race_caption.geometry().left()
        assert card.win_rate_label.geometry().right() < card.scouting_button.geometry().left()
        assert card.name_label.text() != card.name_label.full_text
        assert card.name_label.toolTip() == card.name_label.full_text
        assert card.race_label.fontMetrics().horizontalAdvance(card.race_label.text()) <= card.race_label.width()
        assert card.mmr_label.fontMetrics().horizontalAdvance(card.mmr_label.text()) <= card.mmr_label.width()
        assert card.record_label.fontMetrics().horizontalAdvance(card.record_label.text()) <= card.record_label.width()
        assert card.win_rate_label.text() == "0%"
        assert card.record_caption.geometry().bottom() < card.record_label.geometry().top()
        assert card.grab().save(str(base / "opponent-small.png"))
        card.close()
    ''')


def test_slim_bar_window_buttons_emit_only_explicit_requests(tmp_path):
    run_card_check(tmp_path, '''
        from sc2tools_agent.ui.opponent_card import build_opponent_card
        card = build_opponent_card(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
        card.resize(card.sizeHint())
        card.show()
        card.set_identity("GoldChain", "Zerg", 5189, wins=3, losses=2)
        app.processEvents()
        assert card.size().toTuple() == (420, 44)
        assert card.minimumSize().toTuple() == (360, 40)
        requests = []
        card.enlargeRequested.connect(lambda: requests.append("enlarge"))
        card.minimizeRequested.connect(lambda: requests.append("minimize"))
        card.closeRequested.connect(lambda: requests.append("close"))
        for button, name in ((card.enlarge_button, "Enlarge Companion"),
                             (card.minimize_button, "Minimize Companion"),
                             (card.close_button, "Close Companion")):
            assert not button.isVisible() and button.accessibleName() == name
            button.click()
        assert requests == ["enlarge", "minimize", "close"]
        assert card.isVisible()
        assert card.identity == {"name": "GoldChain", "race": "Zerg", "mmr": "5189"}
        assert card.record["text"] == "3W · 2L" and card.record["winRate"] == "60%"
        card.close()
    ''')


def test_original_scouting_glyphs_are_distinct_transparent_and_highlight_when_open(tmp_path):
    run_card_check(tmp_path, '''
        from sc2tools_agent.ui.scouting_glyph import build_scouting_icon
        rendered = []
        for skin in ("default", "protoss", "terran", "zerg"):
            icon = build_scouting_icon(skin, QtCore=QtCore, QtGui=QtGui)
            normal = icon.pixmap(QtCore.QSize(24, 24), QtGui.QIcon.Normal, QtGui.QIcon.Off).toImage()
            selected = icon.pixmap(QtCore.QSize(24, 24), QtGui.QIcon.Normal, QtGui.QIcon.On).toImage()
            assert normal != selected
            assert normal.pixelColor(0, 0).alpha() == 0
            assert all(normal != previous for previous in rendered)
            assert normal.save(str(base / (skin + "-scouting-glyph.png")))
            rendered.append(normal)
    ''')


@pytest.mark.parametrize("layout,size", [("compact", (420, 44)), ("profile", (260, 380))])
def test_race_skins_repaint_only_cosmetics_and_default_restores_original_pixels(tmp_path, layout, size):
    run_card_check(tmp_path, f'''
        from sc2tools_agent.ui.opponent_card import build_opponent_card
        card = build_opponent_card(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, layout={layout!r})
        card.resize(*{size!r})
        card.set_identity("GoldChain", "Zerg", 5189, wins=3, losses=2)
        card.show()
        app.processEvents()
        baseline = card.grab().toImage()
        identity, record = dict(card.identity), dict(card.record)
        for skin in ("protoss", "terran", "zerg"):
            card.set_skin(skin)
            app.processEvents()
            assert card.property("raceSkin") == skin
            assert card.grab().toImage() != baseline
            assert card.identity == identity and card.record == record
            assert card.size().toTuple() == {size!r}
        card.set_skin("default")
        app.processEvents()
        assert card.property("raceSkin") == "default"
        assert card.grab().toImage() == baseline
        card.close()
    ''')


def test_profile_variant_reuses_identity_art_and_stacks_them_in_a_narrow_rail(tmp_path):
    run_card_check(tmp_path, '''
        from sc2tools_agent.ui.opponent_card import build_opponent_card
        card = build_opponent_card(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, layout="profile")
        card.resize(260, 380)
        card.set_identity("GoldChain", "Zerg", 5189, wins=2, losses=1)
        card.show()
        app.processEvents()
        assert card.portrait.width() >= 145
        assert card.minimize_button.isHidden() and card.close_button.isHidden()
        assert card.name_label.geometry().top() > card.portrait.geometry().bottom()
        for size in [(260, 380), (220, 340)]:
            card.resize(*size)
            app.processEvents()
            for child in [card.name_label, card.race_label, card.mmr_label, card.portrait, card.enlarge_button,
                          card.record_caption, card.record_label, card.win_rate_caption, card.win_rate_label]:
                assert card.rect().contains(child.geometry()), (size, child.objectName(), child.geometry().getRect())
        card.resize(260, 380)
        app.processEvents()
        assert card.grab().save(str(base / "opponent-profile.png"))
        card.close()
    ''')


def test_missing_assets_and_identity_use_neutral_placeholders_without_network(tmp_path):
    run_card_check(tmp_path, '''
        from sc2tools_agent.ui.opponent_card import build_opponent_card
        card = build_opponent_card(QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets, icon_root=base / "no-assets")
        card.resize(420, 44)
        card.set_identity("<b>Not markup</b>", "Unknown", None)
        card.show()
        app.processEvents()
        assert card.name_label.full_text == "<b>Not markup</b>"
        assert card.name_label.textFormat() == QtCore.Qt.PlainText
        assert card.race_label.text() == card.mmr_label.text() == "—"
        assert card.portrait.asset_path is None
        assert card.portrait._image.isNull()
        assert card.record_label.text() == card.win_rate_label.text() == "—"
        card.set_identity()
        app.processEvents()
        assert card.identity == {"name": "—", "race": "—", "mmr": "—"}
        card.close()
    ''')


@pytest.mark.parametrize("wins,losses,record,rate", [
    (2, 1, "2W · 1L", "66.7%"), (0, 3, "0W · 3L", "0%"),
    (3, 0, "3W · 0L", "100%"), (0, 0, "0W · 0L", "—"),
    (None, 1, "—", "—"), (1, None, "—", "—"), (True, 2, "—", "—"),
    (-1, 2, "—", "—"), (1.5, 2, "—", "—"), (float("nan"), 2, "—", "—"),
    (2.0, 1.0, "2W · 1L", "66.7%"), ("2", 1, "—", "—"),
])
def test_your_record_and_percentage_use_only_complete_nonnegative_counts(wins, losses, record, rate):
    result = opponent_record(wins, losses)
    assert result["text"] == record
    assert result["winRate"] == rate
    if record == "—":
        assert result["wins"] is result["losses"] is None
