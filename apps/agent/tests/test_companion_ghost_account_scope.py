from copy import deepcopy
import os
import threading
import time

import pytest

from sc2tools_agent.companion_ghost import GhostClient, GhostError, local_ghost_state, normalize_ghost_state
from sc2tools_agent.session_stats import session_account_key


def target(source="private-A", name="Private replay"):
    return {"v": 1, "name": name, "sourceGameId": source,
            "steps": [{"t": 40, "name": "Gateway", "kind": "building", "timing": "started"}]}


def test_owner_change_masks_cloud_cache_and_offline_cloud_assignments_without_saving():
    connection = [("https://api.example.test", "token-A")]
    owner_a = session_account_key(*connection[0])
    saved = [normalize_ghost_state({"v": 1, "enabled": True, "accountKey": owner_a,
             "slots": {"PvT": target(), "PvZ": target("local:abc:1", "Local replay"), "PvP": target("private-offline")},
             "localOnlyMatchups": ["PvZ", "PvP"]})]
    writes = []
    calls = []

    def request(method, path, **options):
        calls.append((method, path, options))
        assert options["expected_connection"] == connection[0]
        if connection[0][1] == "token-B":
            raise OSError("Offline")
        return {"v": 1, "slots": {"PvT": target()},
                "references": {"family": {"target": target(), "matchup": "PvT"}},
                "history": {"family": [{"revision": "previous", "target": target(), "matchup": "PvT"}]}}

    def save(value):
        writes.append(deepcopy(value))
        saved[0] = value

    client = GhostClient(request, lambda: saved[0], save, connection_provider=lambda: connection[0])
    first = client.action({"action": "ghost_state", "accountKey": owner_a})
    assert first["references"] and first["history"]
    assert saved[0]["accountKey"] == owner_a
    connection[0] = (connection[0][0], "token-B")
    second = client.action({"action": "ghost_state", "accountKey": session_account_key(*connection[0])})
    assert set(second["ghost"]["slots"]) == {"PvZ"}
    assert second["ghost"]["enabled"] is True
    assert second["references"] == {} and second["history"] == {}
    assert len(writes) == 1


def test_old_owner_action_is_rejected_before_any_request_or_local_write():
    connection = ("https://api.example.test", "token-B")
    calls = []
    client = GhostClient(lambda *args, **options: calls.append((args, options)),
                         lambda: {"v": 1, "enabled": True, "slots": {}}, calls.append,
                         connection_provider=lambda: connection)
    with pytest.raises(GhostError, match="pairing changed"):
        client.action({"action": "ghost_save", "enabled": False,
                       "accountKey": session_account_key(connection[0], "token-A")})
    assert calls == []


def test_multistep_target_does_not_cross_pairing_between_game_and_build_requests():
    connection = [("https://api.example.test", "token-A")]
    original = connection[0]
    calls = []

    def request(method, path, **options):
        calls.append((method, path, options))
        connection[0] = (original[0], "token-B")
        return {"myRace": "P", "opponent": {"race": "T"}}

    client = GhostClient(request, lambda: {}, lambda _value: None, connection_provider=lambda: connection[0])
    with pytest.raises(GhostError, match="pairing changed"):
        client.action({"action": "ghost_target", "gameId": "private-A"})
    assert len(calls) == 1
    assert calls[0][2]["expected_connection"] == original


def test_untagged_legacy_cloud_slots_are_not_reused_after_pairing_migration():
    saved = {"v": 1, "enabled": True, "slots": {"PvT": target(), "PvZ": target("local:abc:2")},
             "localOnlyMatchups": ["PvZ"]}
    connection = ("https://api.example.test", "token")

    def offline(*_args, **_options):
        raise OSError("Offline")

    client = GhostClient(offline, lambda: saved, lambda _value: pytest.fail("Reset must not write"),
                         connection_provider=lambda: connection)
    assert set(client.action({"action": "ghost_state"})["ghost"]["slots"]) == {"PvZ"}
    assert "PvT" in saved["slots"]
    assert set(local_ghost_state(saved)["slots"]) == {"PvZ"}


@pytest.fixture
def scoped_page():
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    pytest.importorskip("PySide6")
    from PySide6 import QtCore, QtGui, QtWidgets
    from sc2tools_agent.ui.companion_ghost import build_companion_ghost

    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication([])
    current = ["owner-A"]
    gates = {}
    calls = []

    def handler(payload):
        owner = payload.get("accountKey", current[0])
        calls.append(deepcopy(payload))
        gate = gates.get((owner, payload["action"]))
        if gate is not None:
            gate[0].set()
            assert gate[1].wait(3)
        if payload["action"] == "ghost_state":
            return {"accountKey": owner, "ghost": {"v": 1, "enabled": True, "slots": {"PvT": target(owner)}},
                    "references": {owner: {"gameId": owner, "target": target(owner), "matchup": "PvT"}}}
        if payload["action"] == "ghost_games":
            return {"accountKey": owner, "items": [{"gameId": owner, "myBuild": owner,
                                                     "myRace": "P", "opponent": {"race": "T"}}]}
        return {"accountKey": owner}

    def wait(predicate):
        deadline = time.monotonic() + 3
        while not predicate() and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(0.005)
        assert predicate()

    page = build_companion_ghost(None, handler=handler, QtCore=QtCore, QtGui=QtGui, QtWidgets=QtWidgets)
    wait(lambda: not page._busy)
    page.update_snapshot({"paired": True, "accountKey": current[0]})
    wait(lambda: not page._busy)
    yield page, app, current, gates, calls, wait
    for started, release in gates.values():
        release.set()
    page.shutdown()
    page.deleteLater()
    app.processEvents()


def test_unpair_clears_private_ghost_rows_references_previews_and_pending_assignments(scoped_page):
    page, app, current, gates, calls, wait = scoped_page
    assert page._games and page._references and page._state["slots"]
    page.local_path.setText("D:/Replays/Chosen.SC2Replay")
    page._pending_saves.append({"action": "ghost_save", "matchup": "PvT", "target": target()})
    before = len(calls)
    page.update_snapshot({"paired": False})
    app.processEvents()
    assert page._games == [] and page._references == {} and page._history == {}
    assert page.games.count() == 0 and page.history_reference.count() == 0
    assert page._state["slots"] == {} and page._pending_saves == []
    assert page._preview is None and not page.panel.isVisible()
    assert page.local_path.text() == "D:/Replays/Chosen.SC2Replay"
    assert len(calls) == before
    current[0] = "owner-B"
    page.update_snapshot({"paired": True, "accountKey": current[0]})
    wait(lambda: not page._busy)
    assert [row["gameId"] for row in page._games] == ["owner-B"]
    assert set(page._references) == {"owner-B"}


def test_late_old_owner_reply_cannot_replace_new_owner_or_clear_new_inflight_request(scoped_page):
    page, app, current, gates, calls, wait = scoped_page
    old_gate = gates[("owner-A", "ghost_games")] = (threading.Event(), threading.Event())
    page.refresh()
    wait(old_gate[0].is_set)
    old_request = page._requests["games"]
    new_gate = gates[("owner-B", "ghost_games")] = (threading.Event(), threading.Event())
    current[0] = "owner-B"
    page.update_snapshot({"paired": True, "accountKey": current[0]})
    wait(new_gate[0].is_set)
    seen = []
    page._signals.result.connect(seen.append)
    old_gate[1].set()
    wait(lambda: any(row.get("requestId") == old_request for row in seen))
    assert "games" in page._busy
    assert page._requests["games"] != old_request
    assert not any(row["gameId"] == "owner-A" for row in page._games)
    new_gate[1].set()
    wait(lambda: not page._busy)
    assert [row["gameId"] for row in page._games] == ["owner-B"]


def test_local_preview_and_explicit_local_target_survive_account_reset_without_upload(scoped_page):
    page, app, current, gates, calls, wait = scoped_page
    local = target("local:abc:1", "Chosen local replay")
    page._state = {"v": 1, "enabled": True, "slots": {"PvZ": local}, "localOnlyMatchups": ["PvZ"]}
    page.sources.setCurrentIndex(0)
    page.local_path.setText("D:/Replays/Chosen.SC2Replay")
    page._show_targets({"players": [{"name": "Chosen player", "race": "P", "matchup": "PvZ", "target": local}]})
    before = len(calls)
    page.update_snapshot({"paired": False})
    app.processEvents()
    assert page._state["slots"]["PvZ"]["sourceGameId"] == "local:abc:1"
    assert page._preview["sourceGameId"] == "local:abc:1"
    assert page.local_path.text() == "D:/Replays/Chosen.SC2Replay"
    assert len(calls) == before
    assert not page.arm_button.isEnabled()
    page._arm()
    assert page._pending_saves == []
    assert page.enabled_toggle.isEnabled()
    assert len(calls) == before


def test_pairing_reset_unlocks_checkbox_after_discarding_old_owner_save(scoped_page):
    page, app, current, gates, calls, wait = scoped_page
    gate = gates[("owner-A", "ghost_save")] = (threading.Event(), threading.Event())
    page._save({"enabled": False})
    wait(gate[0].is_set)
    assert not page.enabled_toggle.isEnabled()
    current[0] = "owner-B"
    page.update_snapshot({"paired": True, "accountKey": current[0]})
    wait(lambda: not page._busy)
    assert page.enabled_toggle.isEnabled()
    gate[1].set()
    app.processEvents()
    assert page.enabled_toggle.isEnabled()


def test_detected_connection_change_clears_private_cache_before_next_snapshot(scoped_page):
    page, app, current, gates, calls, wait = scoped_page
    page._requests["state"] = 1000
    page._busy.add("state")
    page._reply({"channel": "state", "requestId": 1000, "generation": page._account_generation,
                 "owner": page._account_key, "payload": {"action": "ghost_state"},
                 "pairingChanged": True, "error": "Pairing changed"})
    assert page._games == [] and page._references == {} and page._history == {}
    assert page._state["slots"] == {} and page._busy == set()
    assert page.enabled_toggle.isEnabled()
    assert not page.panel.isVisible()
