"""Clip naming and filing, on temporary folders only."""
from datetime import datetime

import pytest

from sc2tools_agent.streaming.clip_files import HIGHLIGHTS, MAX_NAME, clip_name, file_clip

UNSAFE = "<>:\"/" + chr(92) + "|?*"
ENDED = datetime(2026, 11, 28, 21, 5).timestamp()
FACTS = {"result": "Victory", "my_race": "Protoss", "map_name": "Alcyone LE",
         "opponent": {"displayName": "Barcode", "race": "Zerg"}}


def test_the_name_says_when_the_matchup_the_result_the_opponent_and_the_map():
    assert clip_name(ENDED, FACTS) == "2026-11-28 21-05 PvZ Victory vs Barcode on Alcyone LE"


def test_a_game_with_no_facts_still_gets_a_dated_name():
    assert clip_name(ENDED, None) == "2026-11-28 21-05 Game"
    assert clip_name(ENDED, {"opponent": "oops", "my_race": "Random"}) == "2026-11-28 21-05 Game"


def test_characters_a_file_name_cannot_hold_are_removed_and_the_length_is_capped():
    facts = {**FACTS, "map_name": "A" + UNSAFE + "B", "opponent": {"displayName": "x" * 300, "race": "Terran"}}
    name = clip_name(ENDED, facts)
    assert not any(char in name for char in UNSAFE) and len(name) <= MAX_NAME and not name.endswith((" ", "."))


def test_the_clip_moves_into_a_highlights_folder_beside_it(tmp_path):
    source = tmp_path / "Replay 2026-11-28 21-04-58.MKV"
    source.write_bytes(b"video")
    target = file_clip(source, "2026-11-28 21-05 Game")
    assert target == tmp_path / HIGHLIGHTS / "2026-11-28 21-05 Game.mkv"
    assert target.read_bytes() == b"video" and not source.exists()


def test_a_name_already_taken_is_never_overwritten(tmp_path):
    for index, text in enumerate((b"first", b"second", b"third")):
        source = tmp_path / f"clip{index}.mp4"
        source.write_bytes(text)
        file_clip(source, "Same")
    kept = sorted(path.name for path in (tmp_path / HIGHLIGHTS).iterdir())
    assert kept == ["Same (2).mp4", "Same (3).mp4", "Same.mp4"]
    assert (tmp_path / HIGHLIGHTS / "Same.mp4").read_bytes() == b"first"


@pytest.mark.parametrize("make", [
    lambda root: root / "missing.mkv",
    lambda root: root,
    lambda root: _file(root / "notes.txt"),
    lambda root: _file(root / HIGHLIGHTS / "already.mkv"),
])
def test_only_a_video_file_outside_highlights_is_ever_moved(tmp_path, make):
    source = make(tmp_path)
    assert file_clip(source, "Name") is None
    assert not (tmp_path / HIGHLIGHTS / "Name.mkv").exists()


def test_a_file_that_cannot_be_moved_stays_where_it_is(tmp_path, monkeypatch):
    source = _file(tmp_path / "clip.mkv")
    monkeypatch.setattr(type(source), "rename", lambda *_: (_ for _ in ()).throw(PermissionError()))
    assert file_clip(source, "Name") is None
    assert source.exists()


def _file(path):
    path.parent.mkdir(exist_ok=True)
    path.write_bytes(b"x")
    return path
