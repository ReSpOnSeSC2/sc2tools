"""Replay-folder discovery keeps up with folders SC2 creates later.

StarCraft II creates ``Accounts/<id>/<toon>/Replays/Multiplayer`` the first
time a region or handle saves a replay; the 5.0.17 PTR's toon handles use
gateway 98 (``98-S2-1-<id>``). Up to 0.17.5 the watcher only watched the
folders found at startup, and a Settings Save or a folder pick stored a list
that replaced detection for good, so a PTR game's replays were never synced.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, List, Optional, Tuple

import pytest

from sc2tools_agent import replay_finder
from sc2tools_agent.config import AgentConfig
from sc2tools_agent.replay_finder import path_key, watched_replay_folders
from sc2tools_agent.runner import (
    _discover_replay_folders,
    _handle_choose_folder,
    _handle_save_settings,
)
from sc2tools_agent.state import AgentState, load_state
from sc2tools_agent.ui import SettingsPayload

ACCOUNT = "50983875"
LIVE_TOON = "1-S2-1-267727"
PTR_TOON = "98-S2-1-30230"


@pytest.fixture
def documents(tmp_path: Path, monkeypatch) -> Path:
    """A Documents folder that discovery probes instead of the real one."""
    docs = tmp_path / "Documents"
    docs.mkdir()
    monkeypatch.setattr(
        replay_finder, "candidate_documents_dirs", lambda: iter([docs]),
    )
    return docs


def _toon(docs: Path, toon: str, *, client: str = "StarCraft II") -> Path:
    folder = docs / client / "Accounts" / ACCOUNT / toon / "Replays" / "Multiplayer"
    folder.mkdir(parents=True)
    return folder


def _keys(folders) -> List[str]:
    return [path_key(Path(p)) for p in folders]


def _cfg(state_dir: Path, *, poll_interval_sec: int = 10) -> AgentConfig:
    state_dir.mkdir(parents=True, exist_ok=True)
    return AgentConfig(
        api_base="http://localhost:0",
        state_dir=state_dir,
        replay_folder=None,
        poll_interval_sec=poll_interval_sec,
        parse_concurrency=1,
    )


# ---------------- replay_finder ----------------


def test_ptr_toon_created_later_is_detected(documents: Path) -> None:
    live = _toon(documents, LIVE_TOON)
    assert _keys(watched_replay_folders()) == _keys([live])

    ptr = _toon(documents, PTR_TOON)

    assert _keys(watched_replay_folders()) == _keys([live, ptr])


def test_saved_folders_are_merged_with_detection(
    documents: Path, tmp_path: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    custom = tmp_path / "Replay backups"
    custom.mkdir()
    ptr = _toon(documents, PTR_TOON)

    # A pre-0.17.6 Save stored the detected folder alongside the custom one.
    folders = watched_replay_folders(added=[str(live), str(custom)])

    assert _keys(folders) == _keys([live, ptr, custom])


def test_excluded_folder_is_skipped_and_nested_folders_collapse(
    documents: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    ptr = _toon(documents, PTR_TOON)
    accounts = documents / "StarCraft II" / "Accounts"

    assert _keys(watched_replay_folders(excluded=[str(ptr)])) == _keys([live])
    # A user-added Accounts root already covers both toon folders, and
    # watching them as well would see every replay twice.
    assert _keys(watched_replay_folders(added=[str(accounts)])) == _keys([accounts])


def test_test_client_documents_folder_is_probed(documents: Path) -> None:
    live = _toon(documents, LIVE_TOON)
    ptr = _toon(documents, PTR_TOON, client="StarCraft II PTR")
    _toon(documents, "2-S2-1-8780508", client="StarCraft II - Copy")

    assert _keys(watched_replay_folders()) == _keys([live, ptr])


def test_accounts_root_is_watched_before_any_replay_exists(
    documents: Path,
) -> None:
    accounts = documents / "StarCraft II" / "Accounts"
    accounts.mkdir(parents=True)

    assert _keys(watched_replay_folders()) == _keys([accounts])


# ---------------- watcher ----------------


class _FakeUploadQueue:
    def __init__(self) -> None:
        self.resync = False

    def submit(self, job) -> bool:
        return True

    def pending_count(self) -> int:
        return 0

    def is_pending(self, path: Path) -> bool:
        return False

    def is_resync_requested(self) -> bool:
        return self.resync

    def acknowledge_resync(self) -> None:
        self.resync = False


class _FakeObserver:
    def __init__(self) -> None:
        self.scheduled: List[str] = []
        self.unscheduled: List[str] = []

    def schedule(self, handler, path: str, *, recursive: bool = False):
        assert recursive
        self.scheduled.append(path)
        return SimpleNamespace(path=path)

    def unschedule(self, watch) -> None:
        self.unscheduled.append(watch.path)

    def stop(self) -> None:
        pass

    def join(self, timeout: Optional[float] = None) -> None:
        pass


@pytest.fixture
def make_watcher(tmp_path: Path, monkeypatch):
    from sc2tools_agent.watcher import ReplayWatcher

    monkeypatch.setenv("SC2TOOLS_PARSE_USE_PROCESSES", "0")
    built: List[Any] = []

    def _make(state: AgentState, **cfg_kwargs: Any) -> Any:
        upload = _FakeUploadQueue()
        changes: List[List[Path]] = []
        watcher = ReplayWatcher(
            cfg=_cfg(tmp_path / "state", **cfg_kwargs),
            state=state,
            upload=upload,
            on_roots_changed=changes.append,
        )
        submitted: List[Tuple[Path, bool]] = []

        def _record(path: Path, *, live: bool = False) -> None:
            submitted.append((path, live))

        watcher._submit_parse = _record  # type: ignore[assignment]
        watcher.test_upload = upload
        watcher.test_changes = changes
        watcher.test_submitted = submitted
        built.append(watcher)
        return watcher

    yield _make

    for watcher in built:
        watcher.stop()


def test_sweep_watches_toon_folder_created_after_start(
    documents: Path, make_watcher,
) -> None:
    live = _toon(documents, LIVE_TOON)
    watcher = make_watcher(AgentState(device_token="t"))
    observer = _FakeObserver()
    watcher._observer = observer

    watcher._sweep_once()
    assert _keys(watcher._roots) == _keys([live])
    assert _keys(observer.scheduled) == _keys([live])

    # The player's first PTR game creates the gateway-98 toon folder.
    ptr = _toon(documents, PTR_TOON)
    replay = ptr / "Ultralove LE.SC2Replay"
    replay.write_bytes(b"replay")
    watcher._sweep_once()

    assert _keys(watcher._roots) == _keys([live, ptr])
    assert _keys(observer.scheduled) == _keys([live, ptr])
    assert watcher.test_submitted == [(replay, True)]
    assert [_keys(change) for change in watcher.test_changes] == [
        _keys([live]),
        _keys([live, ptr]),
    ]

    # Nothing new: no rescheduling and no change notification.
    watcher._sweep_once()
    assert len(observer.scheduled) == 2
    assert len(watcher.test_changes) == 2


def test_sweep_adds_new_folder_to_a_saved_folder_list(
    documents: Path, tmp_path: Path, make_watcher,
) -> None:
    live = _toon(documents, LIVE_TOON)
    custom = tmp_path / "Replay backups"
    custom.mkdir()
    # What a pre-0.17.6 Settings Save left behind: the whole list.
    state = AgentState(
        device_token="t", replay_folders_override=[str(live), str(custom)],
    )
    watcher = make_watcher(state)
    watcher._observer = _FakeObserver()
    watcher._sweep_once()

    ptr = _toon(documents, PTR_TOON)
    watcher._sweep_once()

    assert _keys(watcher._roots) == _keys([live, custom, ptr])


def test_resync_replaces_roots_and_unwatches_removed_folder(
    documents: Path, make_watcher,
) -> None:
    live = _toon(documents, LIVE_TOON)
    ptr = _toon(documents, PTR_TOON)
    state = AgentState(device_token="t")
    watcher = make_watcher(state)
    observer = _FakeObserver()
    watcher._observer = observer
    watcher._sweep_once()
    assert _keys(watcher._roots) == _keys([live, ptr])

    # Without a resync, a folder dropping out is kept (it may be a
    # OneDrive hiccup); a Settings change arrives with a resync.
    state.replay_folders_excluded = [str(ptr)]
    watcher._sweep_once()
    assert _keys(watcher._roots) == _keys([live, ptr])

    watcher.test_upload.resync = True
    watcher._sweep_once()
    assert _keys(watcher._roots) == _keys([live])
    assert _keys(observer.unscheduled) == _keys([ptr])
    assert watcher.test_upload.resync is False


def test_real_observer_sees_replay_in_folder_found_after_start(
    documents: Path, make_watcher,
) -> None:
    _toon(documents, LIVE_TOON)
    # A long poll interval keeps the sweep loop out of the way; the test
    # drives the one sweep that finds the new folder itself.
    watcher = make_watcher(AgentState(device_token="t"), poll_interval_sec=3600)
    seen: List[Path] = []
    seen_event = threading.Event()

    def _on_created(path: Path) -> None:
        seen.append(path)
        seen_event.set()

    watcher.on_replay_created = _on_created  # type: ignore[assignment]
    watcher.start()

    ptr = _toon(documents, PTR_TOON)
    watcher._sweep_once()
    assert path_key(ptr) in watcher._watches

    replay = ptr / "Ultralove LE (2).SC2Replay"
    replay.write_bytes(b"replay")

    assert seen_event.wait(timeout=10), "watchdog never reported the replay"
    assert replay in seen


# ---------------- runner: Settings Save and folder picks ----------------


def _save(tmp_path: Path, state: AgentState, **payload: Any) -> SimpleNamespace:
    tray = SimpleNamespace(folders=None)
    tray.set_replay_folders = lambda folders: setattr(tray, "folders", folders)
    upload = SimpleNamespace(resync_calls=0)
    upload.request_full_resync = lambda: setattr(
        upload, "resync_calls", upload.resync_calls + 1,
    )
    cell = SimpleNamespace(upload=upload, tray=tray, gui=None, watcher=None)
    _handle_save_settings(
        _cfg(tmp_path / "state"), state, SettingsPayload(**payload), cell,
        logging.getLogger("test"),
    )
    return cell


def test_save_keeps_watching_folders_that_appear_later(
    documents: Path, tmp_path: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    custom = tmp_path / "Replay backups"
    custom.mkdir()
    state = AgentState(device_token="t")

    # Settings shows the detected folder; the user adds one and saves.
    cell = _save(tmp_path, state, replay_folders=[live, custom])

    assert _keys(state.replay_folders_override) == _keys([custom])
    assert state.replay_folders_excluded == []
    assert _keys(cell.tray.folders) == _keys([live, custom])
    assert cell.upload.resync_calls == 1

    ptr = _toon(documents, PTR_TOON)
    reloaded = load_state(tmp_path / "state")
    cfg = _cfg(tmp_path / "state")
    assert _keys(_discover_replay_folders(cfg, reloaded)) == _keys(
        [live, ptr, custom],
    )


def test_save_does_not_exclude_folder_missing_from_a_stale_list(
    documents: Path, tmp_path: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    state = AgentState(device_token="t")
    # Settings was filled before the PTR folder existed.
    ptr = _toon(documents, PTR_TOON)

    _save(tmp_path, state, replay_folders=[live], replay_folders_removed=[])

    assert state.replay_folders_excluded == []
    assert _keys(_discover_replay_folders(_cfg(tmp_path / "state"), state)) == (
        _keys([live, ptr])
    )


def test_removed_folder_stays_excluded_until_listed_again(
    documents: Path, tmp_path: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    ptr = _toon(documents, PTR_TOON)
    state = AgentState(device_token="t")
    cfg = _cfg(tmp_path / "state")

    _save(tmp_path, state, replay_folders=[live], replay_folders_removed=[ptr])
    assert _keys(state.replay_folders_excluded) == _keys([ptr])
    assert _keys(_discover_replay_folders(cfg, state)) == _keys([live])

    # A later Save that doesn't touch the list keeps the exclusion.
    _save(tmp_path, state, replay_folders=[live], replay_folders_removed=[])
    assert _keys(_discover_replay_folders(cfg, state)) == _keys([live])

    # Auto-detect puts it back in the list.
    _save(tmp_path, state, replay_folders=[live, ptr], replay_folders_removed=[])
    assert state.replay_folders_excluded == []
    assert _keys(_discover_replay_folders(cfg, state)) == _keys([live, ptr])


def test_removing_a_folder_the_user_added_just_drops_it(
    documents: Path, tmp_path: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    custom = tmp_path / "Replay backups"
    custom.mkdir()
    state = AgentState(device_token="t", replay_folders_override=[str(custom)])

    _save(tmp_path, state, replay_folders=[live], replay_folders_removed=[custom])

    assert state.replay_folders_override == []
    assert state.replay_folders_excluded == []


def test_saving_an_empty_list_resets_to_detection(
    documents: Path, tmp_path: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    ptr = _toon(documents, PTR_TOON)
    state = AgentState(
        device_token="t",
        replay_folders_override=[str(tmp_path / "gone")],
        replay_folders_excluded=[str(ptr)],
        replay_folder_override=str(tmp_path / "gone"),
    )

    _save(tmp_path, state, replay_folders=[], replay_folders_removed=[live])

    assert state.replay_folders_override == []
    assert state.replay_folders_excluded == []
    assert state.replay_folder_override is None
    assert _keys(_discover_replay_folders(_cfg(tmp_path / "state"), state)) == (
        _keys([live, ptr])
    )


class _FakeTray:
    def __init__(self) -> None:
        self.folders: Optional[List[Path]] = None

    def set_replay_folders(self, folders: List[Path]) -> None:
        self.folders = list(folders)


class _FakeResyncQueue:
    def __init__(self) -> None:
        self.resync_calls = 0

    def request_full_resync(self) -> None:
        self.resync_calls += 1


def test_adding_a_folder_in_auto_mode_keeps_detected_folders(
    documents: Path, tmp_path: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    custom = tmp_path / "Replay backups"
    custom.mkdir()
    state = AgentState(device_token="t")
    cfg = _cfg(tmp_path / "state")
    tray = _FakeTray()
    upload = _FakeResyncQueue()

    _handle_choose_folder(
        cfg, state, custom, tray, logging.getLogger("test"), upload=upload,
    )

    assert _keys(state.replay_folders_override) == _keys([custom])
    assert _keys(tray.folders) == _keys([live, custom])
    assert upload.resync_calls == 1

    # After a restart, the detected folder is still watched, and so is a
    # PTR folder created since.
    ptr = _toon(documents, PTR_TOON)
    reloaded = load_state(cfg.state_dir)
    assert _keys(_discover_replay_folders(cfg, reloaded)) == _keys(
        [live, ptr, custom],
    )


def test_picking_an_excluded_detected_folder_watches_it_again(
    documents: Path, tmp_path: Path,
) -> None:
    live = _toon(documents, LIVE_TOON)
    ptr = _toon(documents, PTR_TOON)
    state = AgentState(device_token="t", replay_folders_excluded=[str(ptr)])
    cfg = _cfg(tmp_path / "state")

    _handle_choose_folder(cfg, state, ptr, None, logging.getLogger("test"))

    assert state.replay_folders_excluded == []
    # Detected already, so it is not stored as an addition.
    assert state.replay_folders_override == []
    assert _keys(_discover_replay_folders(cfg, state)) == _keys([live, ptr])
