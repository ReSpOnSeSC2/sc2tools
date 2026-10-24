from tests._gui_offscreen import run_gui_check
from tests.test_gui_race_animation import _SETUP


def test_real_team_rosters_keep_approved_dimensions_and_build_times_visible(tmp_path):
    run_gui_check(tmp_path, _SETUP + '''
base_handler = handler
def handler(payload):
    if payload["action"] == "game_build_order":
        return {"ok": True, "game_id": payload["gameId"], "my_status": "ready", "opp_status": "ready",
                "events": [{"name": "Gateway", "time": 43, "is_building": True, "category": "building"}],
                "opp_events": [{"name": "Barracks", "time": 47, "is_building": True, "category": "building"}]}
    return base_handler(payload)
for team_size in (2, 4):
    players = []
    for index in range(team_size * 2):
        name = "Local player" if index == 0 else "Library opponent" if index == team_size else "Roster player " + str(index)
        players.append({"id": index + 1, "name": name, "race": "Protoss" if index == 0 else "Terran", "type": "user"})
    snapshot["accountKey"] = "fixture-owner"
    snapshot["liveGame"] = {"phase": "match_in_progress", "gameKey": "team-" + str(team_size), "capturedAt": time.time(),
                            "isReplay": False, "displayTime": 60, "players": players,
                            "user": {"name": "Local player", "race": "Protoss"}}
    ui, win, page, effects = ready_window(window_skin="default", window_animations=False)
    roster = page.team_roster_state
    own = next(row["key"] for row in roster.players if row["player_id"] == 1)
    enemies = [row["key"] for row in roster.players if row["player_id"] > team_size]
    roster.confirm(own, enemies)
    roster.select(next(row["key"] for row in roster.enemies if row["name"] == "Library opponent"))
    page._refresh_team_roster()
    wait_until(lambda: bool(page._team_details) and bool(page.build_chains["my"].steps) and bool(page.build_chains["opp"].steps))
    for title, width, height in (("Compact", 340, 78), ("Standard", 520, 480), ("Detailed", 1024, 800)):
        assert win._set_window_size(title)
        app.processEvents()
        QtTest.QTest.qWait(100)
        screen = win.screen().availableGeometry()
        assert (win.width(), win.height()) == (min(width, screen.width()), min(height, screen.height())), (team_size, title, win.size(), win.minimumSize())
        if title == "Compact":
            assert not page.team_roster_widget.isVisible()
        else:
            assert page.team_roster_summary.isVisible() if title == "Standard" else page.team_roster_widget.isVisible()
            assert len(page.team_roster_widget._buttons) == team_size
            assert page.team_roster_widget.height() <= (32 if title == "Standard" else 200)
            if title == "Standard":
                page.team_roster_summary.open_roster.click()
                app.processEvents()
                assert page.console.current_route() == "team-roster"
                assert len(page.team_roster_page._buttons) == team_size
                page.console.navigate("scouting")
                app.processEvents()
        if title == "Standard":
            win.grab().save(str(base / ("team-" + str(team_size) + "v" + str(team_size) + "-standard.png")))
            for side in ("my", "opp"):
                chain = page.build_chains[side]
                assert chain.isVisible() and chain.height() >= 156, (team_size, side, chain.size())
                if chain.steps:
                    for observation in (chain.steps[0].icon_label, chain.steps[0].time_label, chain.steps[0].timing_label):
                        viewport = page.overview.viewport()
                        rectangle = QtCore.QRect(observation.mapTo(viewport, QtCore.QPoint()), observation.size())
                        assert viewport.rect().contains(rectangle), (team_size, side, viewport.size(), rectangle)
        win.grab().save(str(base / ("team-" + str(team_size) + "v" + str(team_size) + "-" + title.lower() + ".png")))
    assert win._set_window_size("Full workspace")
    app.processEvents()
    assert win.isMaximized()
    assert len(page.team_roster_widget._buttons) == team_size
    assert page.team_roster_widget.scroll.viewport().height() >= 90
    finish(win, page, effects)
''')
