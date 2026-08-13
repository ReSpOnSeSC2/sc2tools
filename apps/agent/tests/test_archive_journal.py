"""Durability and corruption tests for the replay archive journal."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from sc2tools_agent.uploader.archive_journal import (
    ARCHIVE_JOURNAL_FILENAME,
    ReplayArchiveJournal,
    ReplayArchiveJournalError,
    ReplayArchiveTask,
)


def _task(tmp_path: Path, name: str, game_id: str) -> ReplayArchiveTask:
    return ReplayArchiveTask(tmp_path / name, game_id)


def test_enqueue_is_durable_across_restart_and_ack_removes_task(
    tmp_path: Path,
) -> None:
    task = _task(tmp_path, "one.SC2Replay", "g1")
    journal = ReplayArchiveJournal(tmp_path)
    assert journal.enqueue_many([task]) == 1

    restarted = ReplayArchiveJournal(tmp_path)
    assert restarted.pending_count() == 1
    assert restarted.contains(task)

    assert restarted.acknowledge_many([task], durable=True) == 1
    assert ReplayArchiveJournal(tmp_path).pending_count() == 0


def test_same_path_with_two_game_ids_preserves_both_archive_tasks(
    tmp_path: Path,
) -> None:
    first = _task(tmp_path, "drift.SC2Replay", "old-game-id")
    second = _task(tmp_path, "drift.SC2Replay", "new-game-id")
    journal = ReplayArchiveJournal(tmp_path)
    assert journal.enqueue_many([first, second]) == 2

    restarted = ReplayArchiveJournal(tmp_path)
    assert restarted.pending_count() == 2
    assert restarted.contains(first)
    assert restarted.contains(second)

    assert restarted.acknowledge_many([first], durable=True) == 1
    final = ReplayArchiveJournal(tmp_path)
    assert not final.contains(first)
    assert final.contains(second)


def test_unterminated_torn_final_record_is_discarded_and_repaired(
    tmp_path: Path,
) -> None:
    task = _task(tmp_path, "safe.SC2Replay", "g-safe")
    journal = ReplayArchiveJournal(tmp_path)
    journal.enqueue_many([task])
    with journal.path.open("ab") as fh:
        fh.write(b'{"op":"enqueue","path":"torn')

    recovered = ReplayArchiveJournal(tmp_path)
    assert recovered.contains(task)
    # Constructor compacts the torn tail, so a second restart is clean too.
    assert ReplayArchiveJournal(tmp_path).contains(task)


def test_valid_unterminated_final_record_is_applied_then_repaired(
    tmp_path: Path,
) -> None:
    path = tmp_path / ARCHIVE_JOURNAL_FILENAME
    first = _task(tmp_path, "first.SC2Replay", "g-first")
    second = _task(tmp_path, "second.SC2Replay", "g-second")
    path.write_text(
        json.dumps(
            {
                "op": "enqueue",
                "path": str(first.file_path),
                "gameId": first.game_id,
            },
        ),
        encoding="utf-8",
    )

    recovered = ReplayArchiveJournal(tmp_path)
    assert recovered.contains(first)
    assert recovered.enqueue_many([second]) == 1

    restarted = ReplayArchiveJournal(tmp_path)
    assert restarted.contains(first)
    assert restarted.contains(second)


def test_corrupt_newline_terminated_middle_record_fails_closed(
    tmp_path: Path,
) -> None:
    path = tmp_path / ARCHIVE_JOURNAL_FILENAME
    valid = json.dumps(
        {"op": "enqueue", "path": "one.SC2Replay", "gameId": "g1"},
    )
    path.write_text(f"{valid}\n{{not-json}}\n{valid}\n", encoding="utf-8")

    with pytest.raises(ReplayArchiveJournalError, match="corrupt_record"):
        ReplayArchiveJournal(tmp_path)


def test_journal_read_failure_fails_closed_instead_of_losing_tasks(
    tmp_path: Path,
) -> None:
    path = tmp_path / ARCHIVE_JOURNAL_FILENAME
    path.write_text("placeholder\n", encoding="utf-8")
    real_read = Path.read_bytes

    def _read_bytes(target: Path) -> bytes:
        if target == path:
            raise PermissionError("locked")
        return real_read(target)

    with patch.object(Path, "read_bytes", _read_bytes):
        with pytest.raises(ReplayArchiveJournalError, match="unreadable"):
            ReplayArchiveJournal(tmp_path)


def test_ready_hydration_is_bounded_and_can_page_past_exclusions(
    tmp_path: Path,
) -> None:
    tasks = [_task(tmp_path, f"{i}.SC2Replay", f"g{i}") for i in range(20)]
    journal = ReplayArchiveJournal(tmp_path)
    journal.enqueue_many(tasks)

    first = journal.next_tasks(excluded=set(), limit=5)
    assert first == tasks[:5]
    second = journal.next_tasks(
        excluded={task.key for task in first},
        limit=5,
    )
    assert second == tasks[5:10]


def test_failed_ack_checkpoint_restores_live_pending_index(
    tmp_path: Path,
) -> None:
    tasks = [_task(tmp_path, f"{i}.SC2Replay", f"g{i}") for i in range(16)]
    journal = ReplayArchiveJournal(tmp_path)
    journal.enqueue_many(tasks)

    with patch.object(
        journal,
        "_append_records_locked",
        side_effect=OSError("disk full"),
    ):
        with pytest.raises(OSError, match="disk full"):
            journal.acknowledge_many(tasks)

    assert journal.pending_count() == len(tasks)
    assert all(journal.contains(task) for task in tasks)


def test_append_failure_poisoning_prevents_followup_record_corruption(
    tmp_path: Path,
) -> None:
    first = _task(tmp_path, "first.SC2Replay", "g-first")
    second = _task(tmp_path, "second.SC2Replay", "g-second")
    journal = ReplayArchiveJournal(tmp_path)

    with patch("os.fsync", side_effect=OSError("disk full")):
        with pytest.raises(
            ReplayArchiveJournalError,
            match="write_failed",
        ):
            journal.enqueue_many([first])

    # Even if the underlying error clears, this process cannot know which
    # append boundary became durable and must not concatenate more JSON.
    with pytest.raises(ReplayArchiveJournalError, match="write_failed"):
        journal.enqueue_many([second])

    # Restart safely applies/repairs the complete-looking unterminated tail.
    restarted = ReplayArchiveJournal(tmp_path)
    assert restarted.contains(first)
    assert restarted.enqueue_many([second]) == 1
