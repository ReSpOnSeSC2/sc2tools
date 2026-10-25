from datetime import datetime, timezone, timedelta
import json
from types import SimpleNamespace

import pytest

from sc2tools_agent.recent_games import (RecentGamesStore, build_game_summary, today_summary,
                                        upload_facts, skipped_groups)


def game(**overrides):
    values = dict(game_id="raw-id", date_iso="2026-10-23T12:00:00Z", result="Victory",
                  my_race="Protoss", map_name="Alcyone LE", duration_sec=600, my_mmr=5321,
                  opponent={"name": "Opponent", "race": "Zerg", "mmr": 9000},
                  my_toon_handle="1-S2-1-42", my_ladder_race="Protoss", is_ladder_game=True)
    return SimpleNamespace(**{**values, **overrides})


def row(date="2026-10-23T12:00:00Z", mmr=5321, region="NA", **overrides):
    return {"gameId": date, "dateIso": date, "mmr": mmr, "region": region,
            "ladderRace": "Protoss", "status": "uploaded", "result": "Victory",
            "isLadder": True, **overrides}


def test_summary_uses_accepted_id_own_mmr_and_only_whitelisted_fields():
    summary = build_game_summary(game(), {"gameId": "canonical-id", "secret": "not-local-history"})
    assert summary == {"gameId": "canonical-id", "dateIso": "2026-10-23T12:00:00Z",
                       "result": "Victory", "races": {"own": "Protoss", "opponent": "Zerg"},
                       "oppName": "Opponent", "map": "Alcyone LE", "durationSec": 600,
                       "mmr": 5321, "region": "NA", "isLadder": True,
                       "ladderRace": "Protoss", "isHistory": False, "isResumed": False}
    absent = build_game_summary(game(my_mmr=None, opponent=None, is_ladder_game=None), {})
    assert absent["mmr"] is None and absent["oppName"] is None and absent["isLadder"] is None
    assert "secret" not in str(summary)


def test_first_start_seeds_only_newest_hundred_dated_cursor_entries(tmp_path):
    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    uploaded = {str(index): (start + timedelta(minutes=index)).isoformat() for index in range(130)}
    uploaded.update(skipped="skipped:ai_game", filtered="filtered", invalid="not-a-date")
    store = RecentGamesStore(tmp_path, owner="owner", uploaded=uploaded, paths_by_id={"game129": "129"})
    rows = store.snapshot()
    assert len(rows) == 100 and rows[0]["path"] == "129" and rows[-1]["path"] == "30"
    assert rows[0]["gameId"] == "game129" and rows[0]["seeded"] is True
    assert "result" not in rows[0]  # No invented game result from a filename.
    second = RecentGamesStore(tmp_path, owner="owner", uploaded={"new": start.isoformat()})
    assert second.snapshot() == rows


def test_jsonl_is_trimmed_deduplicated_and_survives_restart(tmp_path):
    store = RecentGamesStore(tmp_path, owner="owner")
    for index in range(205):
        store.record(str(index), {"gameId": str(index)})
    assert len(store.path.read_text(encoding="utf-8").splitlines()) == 200
    assert len(store.snapshot()) == 200
    store.record("renamed-path", {"gameId": "204", "result": "Defeat"})
    assert len(store.snapshot()) == 200
    assert store.snapshot()[0]["path"] == "renamed-path"
    assert RecentGamesStore(tmp_path, owner="owner").snapshot() == store.snapshot()
    assert not list(tmp_path.glob("recent-games-*.tmp"))


def test_other_linked_account_and_malformed_lines_are_never_displayed(tmp_path):
    store = RecentGamesStore(tmp_path, owner="first")
    store.record("first-path", {"gameId": "private-first"})
    with store.path.open("a", encoding="utf-8") as stream:
        stream.write("not json\n[]\n")
    assert len(RecentGamesStore(tmp_path, owner="first").snapshot()) == 1
    assert RecentGamesStore(tmp_path, owner="second").snapshot() == []
    assert RecentGamesStore(tmp_path, owner=None).snapshot() == []
    second = RecentGamesStore(tmp_path, owner="second")
    second.record("second-path", {"gameId": "private-second"})
    assert "private-first" not in second.path.read_text(encoding="utf-8")


def test_failed_durable_write_preserves_both_disk_and_visible_history(tmp_path, monkeypatch):
    store = RecentGamesStore(tmp_path, owner="owner")
    store.record("first", {"gameId": "first"})
    before = store.path.read_bytes()
    def fail(*args):
        raise OSError("fixture disk failure")
    monkeypatch.setattr("sc2tools_agent.recent_games._replace_state_file", fail)
    with pytest.raises(OSError):
        store.record("second", {"gameId": "second"})
    assert store.path.read_bytes() == before
    assert [row["gameId"] for row in store.snapshot()] == ["first"]
    assert not list(tmp_path.glob("recent-games-*.tmp"))


def test_today_uses_local_midnight_and_excludes_future_resumed_and_problem_rows():
    eastern = timezone(timedelta(hours=-4))
    now = datetime(2026, 10, 23, 12, tzinfo=eastern)
    rows = [row("2026-10-23T03:59:59Z", result="Defeat"),
            row("2026-10-23T04:00:00Z", 5300), row("2026-10-23T05:00:00Z", 5321),
            row("2026-10-23T06:00:00Z", 5300, result="Defeat"),
            row("2026-10-24T04:00:00Z"), row(isResumed=True), row(status="problem")]
    today = today_summary(rows, now=now)
    assert (today["wins"], today["losses"], today["games"]) == (2, 1, 3)
    assert today["netMmr"] == 0 and today["mmrPairs"] == 2
    assert today["lastGame"]["result"] == "Defeat"


def test_mmr_delta_never_crosses_region_race_custom_or_missing_rating():
    now = datetime(2026, 10, 23, 23, tzinfo=timezone.utc)
    rows = [row("2026-10-23T01:00:00Z", 5300), row("2026-10-23T02:00:00Z", 5320),
            row("2026-10-23T03:00:00Z", 4000, "EU"), row("2026-10-23T04:00:00Z", 3990, "EU"),
            row("2026-10-23T05:00:00Z", None, "EU"), row("2026-10-23T06:00:00Z", 4010, "EU"),
            row("2026-10-23T07:00:00Z", 8000, "EU", isLadder=False),
            row("2026-10-23T08:00:00Z", 4020, "EU"),
            row("2026-10-23T09:00:00Z", 3000, "EU", ladderRace="Terran")]
    assert today_summary(rows, now=now)["netMmr"] == 10
    assert today_summary(rows[:1], now=now)["netMmr"] is None


def test_upload_time_tiles_survive_restart_without_counting_skip_markers():
    now = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
    uploaded = {"old": "2026-10-22T12:00:00Z", "today": "2026-10-23T01:00:00Z",
                "skip": "skipped:parse_failed", "future": "2026-10-24T01:00:00Z"}
    facts = upload_facts(uploaded, [row(status="problem", updatedAt="2026-10-22T13:00:00Z"),
                                    row(status="problem", updatedAt="2026-10-22T11:59:59Z")], now=now)
    assert facts == {"synced": 2, "syncedToday": 1, "lastUploadAt": "2026-10-23T01:00:00+00:00", "failed24h": 1}


def test_skipped_groups_include_all_markers_and_only_documented_retry_reasons():
    groups = skipped_groups({"one": "skipped:player_unresolved", "two": "skipped:player_unresolved",
                             "three": "skipped:ai_game", "four": "filtered", "five": "2026-10-23T01:00:00Z"})
    by_reason = {group["reason"]: group for group in groups}
    assert by_reason["player_unresolved"]["count"] == 2
    assert by_reason["player_unresolved"]["retryable"] is True
    assert by_reason["filtered"]["retryable"] is True
    assert by_reason["ai_game"]["retryable"] is False
    assert len(groups) == 3
