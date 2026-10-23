"""Private local dashboard history; bounded handoff, no disk work on Qt/uploads."""
from __future__ import annotations

from collections import deque
import copy
from datetime import datetime, timezone
import threading

from .recent_games import RecentGamesStore, today_summary, upload_facts, skipped_groups, SKIP_REASONS


class DesktopHistory:
    def __init__(self, state_dir, *, owner_provider, state_provider, on_snapshot):
        self.state_dir, self.owner_provider = state_dir, owner_provider
        self.state_provider, self.on_snapshot = state_provider, on_snapshot
        self.lock = threading.Lock()
        self.wake, self.stop_event = threading.Event(), threading.Event()
        self.live, self.history = deque(maxlen=200), deque(maxlen=512)
        self.thread = None
        self.store = None
        self.latest_snapshot = {}

    def _enqueue(self, path, summary, status, detail=None):
        summary = copy.deepcopy(summary)
        owner = summary.pop("_owner", self.owner_provider())
        if owner != self.owner_provider():
            return
        entry = {**summary, "path": str(path), "status": status,
                 "updatedAt": datetime.now(timezone.utc).isoformat(), "owner": owner}
        if detail:
            entry["error"] = str(detail)[:2000]
        with self.lock:
            (self.history if summary.get("isHistory") else self.live).append(entry)
        self.wake.set()

    def game_synced(self, path, summary):
        self._enqueue(path, summary, "uploaded")

    def problem(self, path, error):
        self._enqueue(path, {"errorTitle": getattr(error, "title", str(error)),
                             "reason": "filtered" if not getattr(error, "counts_as_error", True) else None,
                             "errorKind": getattr(error, "help_anchor", "rejected")},
                      "problem" if getattr(error, "counts_as_error", True) else "skipped",
                      getattr(error, "detail", str(error)))

    def skipped(self, path, reason):
        title = SKIP_REASONS.get(reason, ("This replay was skipped", ""))[0]
        self._enqueue(path, {"reason": reason, "errorTitle": title}, "skipped")

    def refresh(self):
        self.wake.set()

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(self.latest_snapshot)

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.wake.set()
        self.thread = threading.Thread(target=self._run, name="sc2tools-desktop-history", daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            self.wake.wait(30)
            self.wake.clear()
            with self.lock:
                entries = list(self.history) + list(self.live)
                self.history.clear()
                self.live.clear()
            try:
                owner = self.owner_provider()
                state = self.state_provider()
                if self.store is None or self.store.owner != owner:
                    self.store = RecentGamesStore(self.state_dir, owner=owner, uploaded=state.get("uploaded"),
                                                  paths_by_id=state.get("paths_by_id"))
                entries = [entry for entry in entries if entry.get("owner") == owner and owner]
                if entries:
                    self.store.record_many(entries)
                rows = self.store.snapshot() if owner else []
                uploaded = state.get("uploaded", {}) if owner else {}
                result = {"rows": rows, "facts": upload_facts(uploaded, rows), "today": today_summary(rows),
                          "skipped": skipped_groups(uploaded), "owner": owner, "localError": ""}
            except Exception:
                result = {**self.snapshot(), "localError": "Local recent-game history could not be saved. Your synced games are still on the website."}
                # Keep a bounded, coalesced retry until the disk recovers.
                # Shutdown gets one final attempt, without hanging Quit.
                if not self.stop_event.is_set():
                    with self.lock:
                        self.history = deque([entry for entry in entries if entry.get("isHistory")] + list(self.history), maxlen=512)
                        self.live = deque([entry for entry in entries if not entry.get("isHistory")] + list(self.live), maxlen=200)
                    self.stop_event.wait(5)
                    self.wake.set()
            current_owner = self.owner_provider()
            if result.get("owner") != current_owner:
                # Linking can finish while disk work is in flight. Neither a
                # stale successful read nor an error fallback may expose the
                # previous account's local opponent/game metadata.
                result = {"owner": current_owner, "rows": [], "facts": {}, "today": {}, "skipped": [],
                          "localError": result.get("localError", "")}
            with self.lock:
                self.latest_snapshot = copy.deepcopy(result)
            try:
                self.on_snapshot(copy.deepcopy(result))
            except Exception:
                pass
            with self.lock:
                finished = self.stop_event.is_set() and not self.live and not self.history
            if finished:
                break
            # Coalesce bursts and cap local snapshot publication at four/sec.
            if self.stop_event.wait(.25):
                self.wake.set()

    def close(self):
        self.stop_event.set()
        self.wake.set()
        if self.thread:
            self.thread.join(timeout=5)
