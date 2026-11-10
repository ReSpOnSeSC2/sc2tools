"""Render the game-start scouting views in every state, with sample data.

Run from any directory with the desktop development Python:

    python apps/agent/tests/manual/scouting_report_preview.py [output folder]

It saves the Companion's floating scouting report (five games on each side,
fewer than five, a first meeting, an opponent not identified yet, an older
server without the lists, the smallest window size and one race skin), the
loading-screen strip and the setting. No paired account, service, runner or user settings are loaded.
"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
import sys

os.environ["QT_QPA_PLATFORM"] = "offscreen"
AGENT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(AGENT))

from PySide6 import QtCore, QtGui, QtWidgets  # noqa: E402

from sc2tools_agent import __version__  # noqa: E402
from sc2tools_agent.build_checkin.scouting import parse_scouting_brief, scouting_model  # noqa: E402
from sc2tools_agent.ui import theme  # noqa: E402
from sc2tools_agent.ui.build_checkin_widgets import card_stylesheet  # noqa: E402
from sc2tools_agent.ui.companion_page import build_companion_page  # noqa: E402
from sc2tools_agent.ui.private_scouting import ScoutingStrip  # noqa: E402

NOW = datetime.now(timezone.utc)
SMALLEST = (420, 300)
DEFAULT = (650, 450)

MY_GAMES = (
    ("Win", "PvZ - Stargate into Blink", "Tourmaline LE", 0),
    ("Loss", "PvZ - Adept Glaives (Robo)", "Lightshade LE", 1),
    ("Win", "PvZ - Stargate into Blink", "Ghost River LE", 3),
    ("Win", "PvZ - Two Gate Expand", "Equilibrium LE", 4),
    ("Loss", "PvZ - Stargate into Blink", "Alcyone LE", 9),
)
THEIR_GAMES = (
    ("Loss", "Zerg - 12 Pool", "Lightshade LE", 1, "Zerg"),
    ("Win", "Zerg - Hatch First into Roach Timing", "Equilibrium LE", 4, "Zerg"),
    ("Win", "Zerg - 12 Pool", "Tourmaline LE", 16, "Zerg"),
    ("Loss", "Terran - Proxy Barracks", "Ghost River LE", 30, "Terran"),
    ("Win", "Zerg - Hatch First into Roach Timing", "Alcyone LE", 41, "Zerg"),
)
MY_STEPS = (("Gateway", 20, "building"), ("Cybernetics Core", 85, "building"), ("Stargate", 150, "building"),
            ("Oracle", 205, "unit"), ("Twilight Council", 260, "building"), ("Blink", 345, "upgrade"))
THEIR_STEPS = (("Spawning Pool", 17, "building"), ("Zergling", 58, "unit"), ("Hatchery", 95, "building"),
               ("Metabolic Boost", 160, "upgrade"), ("Roach Warren", 190, "building"), ("Roach", 245, "unit"))


def _date(days_ago):
    return (NOW - timedelta(days=days_ago, hours=1)).isoformat()


def _rows(games, side, count):
    return [{"gameId": f"{side}-{index}", "result": game[0], "build": game[1], "map": game[2],
             "date": _date(game[3]), **({"race": game[4]} if len(game) > 4 else {})}
            for index, game in enumerate(games[:count])]


def _events(steps):
    return [{"name": name, "timeSec": seconds, "kind": kind,
             "timing": "completed" if kind == "upgrade" else "started"} for name, seconds, kind in steps]


def _legacy_games(count):
    return [{"gameId": f"opp-{index}", "result": game[0].lower(), "durationSec": 540 + 37 * index, "map": game[2],
             "date": _date(game[3]), "myBuild": MY_GAMES[index][1], "oppStrategy": game[1],
             "myTechMilestones": _events(MY_STEPS), "oppTechMilestones": _events(THEIR_STEPS)}
            for index, game in enumerate(THEIR_GAMES[:count])]


def context(mine, theirs, *, lists=True):
    """A live opponent as the Companion sees it. ``lists`` off is an older
    server; ``theirs`` None is an opponent whose account is not known yet."""
    their_rows = None if theirs is None else _rows(THEIR_GAMES, "opp", theirs)
    history = {"recentBuilds": {"matchup": "PvZ", "mine": _rows(MY_GAMES, "my", mine),
                                "theirs": their_rows}} if lists else {}
    return {"name": "NorthStar", "race": "Zerg", "league": "Master", "region": "US", "mmr": 4310,
            "headToHead": {"wins": 3, "losses": 2}, "last5GamesScouting": _legacy_games(theirs or 0), **history}


def _load_stored_events(page, panel):
    # Stand in for the stored replay events the paired agent would fetch.
    for side in ("my", "opp"):
        for index in range(5):
            page._build_order_cache[(panel._source_id, f"{side}-{index}")] = {
                "my": _events(MY_STEPS), "opp": _events(THEIR_STEPS), "statuses": {"my": "ok", "opp": "ok"}}


def _save(widget, folder, name):
    QtWidgets.QApplication.processEvents()
    target = folder / (name + ".png")
    assert widget.grab().save(str(target)), target
    print(target)


def render_report(folder):
    page = build_companion_page(None, handler=None, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    panel = page.overlays["scouting"]
    states = (
        ("scouting-report-five-games", context(5, 5), DEFAULT, "default"),
        ("scouting-report-five-games-full", context(5, 5), (650, 1010), "default"),
        ("scouting-report-five-games-smallest", context(5, 5), SMALLEST, "default"),
        ("scouting-report-five-games-zerg-skin", context(5, 5), DEFAULT, "zerg"),
        ("scouting-report-fewer-than-five", context(2, 3), DEFAULT, "default"),
        ("scouting-report-first-meeting", context(5, 0), DEFAULT, "default"),
        ("scouting-report-first-meeting-smallest", context(5, 0), SMALLEST, "default"),
        ("scouting-report-not-identified", context(5, None), DEFAULT, "default"),
        ("scouting-report-older-server", context(0, 2, lists=False), DEFAULT, "default"),
    )
    for name, live, size, skin in states:
        panel.update_context({})
        panel.update_context(live)
        _load_stored_events(page, panel)
        panel.set_appearance(skin, False)
        panel.resize(*size)
        panel.show()
        QtWidgets.QApplication.processEvents()
        panel.render_build_data()
        _save(panel, folder, name)
    page.controls_page.resize(560, 330)
    page.controls_page.show()
    _save(page.controls_page, folder, "scouting-first-meeting-setting")
    page.shutdown()
    page.deleteLater()


def render_strip(folder):
    brief = {"gameKey": "preview", "oppName": "NorthStar", "pulseId": "1-S2-1-42", "h2h": {"w": 3, "l": 2},
             "lastMet": {"at": _date(1), "result": "Loss", "map": "Lightshade LE"},
             "forecast": {"name": "12 Pool", "share": 0.4, "samples": 2, "n": 5},
             "recentBuilds": {"matchup": "PvZ", "mine": _rows(MY_GAMES, "my", 5), "theirs": _rows(THEIR_GAMES, "opp", 5)}}
    for name, payload in (("scouting-strip-five-games", brief),
                          ("scouting-strip-first-meeting", {**brief, "h2h": {"w": 0, "l": 0}, "lastMet": None, "forecast": None,
                                                           "recentBuilds": {**brief["recentBuilds"], "theirs": []}})):
        # A fresh card per state, sized from its own content as on a real game start.
        card = QtWidgets.QFrame()
        card.setObjectName("card")
        card.setStyleSheet(card_stylesheet())
        card.setFixedWidth(320)
        strip = ScoutingStrip()
        QtWidgets.QVBoxLayout(card).addWidget(strip)
        strip.set_model(scouting_model(parse_scouting_brief(payload, "preview"), NOW.timestamp()))
        card.show()
        card.adjustSize()
        _save(card, folder, name)
        card.deleteLater()


def capture(folder):
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    for name in ("segoeui.ttf", "segoeuib.ttf", "seguisb.ttf", "seguisym.ttf"):
        QtGui.QFontDatabase.addApplicationFont("C:/Windows/Fonts/" + name)
    app.setFont(QtGui.QFont("Segoe UI", 10))
    app.setStyleSheet(theme.STYLE)
    folder.mkdir(parents=True, exist_ok=True)
    render_report(folder)
    render_strip(folder)
    app.processEvents()


if __name__ == "__main__":
    capture(Path(sys.argv[1]) if len(sys.argv) > 1
            else AGENT.parents[1] / "docs" / "images" / ("agent-" + __version__))
