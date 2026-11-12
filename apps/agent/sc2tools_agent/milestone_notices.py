"""Deliver the newest private bell milestone for a just-synced game."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from hashlib import sha256
import logging
import threading
from urllib.parse import quote

from requests import RequestException

from .api_client import ApiClient, ApiError
from .live.types import LiveLifecyclePhase
from .recent_games import parse_time
from .state import _STATE_SAVE_LOCK, save_state
from .sync_retry import ReplayTicket, replay_ticket


log = logging.getLogger(__name__)
_RECENT_GAME_AGE = timedelta(minutes=15)  # The server's Game Moments freshness window.
_RETRY_DELAYS = (2, 2, 4, 8, 16, 32, 64)
_BETWEEN_GAMES = {LiveLifecyclePhase.IDLE, LiveLifecyclePhase.MENU, LiveLifecyclePhase.MATCH_ENDED}


@dataclass(frozen=True)
class _SyncedGame:
    date: datetime
    href: str
    receipt_key: str
    ticket: ReplayTicket = field(repr=False)


def _fresh_game(summary):
    if summary.get("isHistory") or summary.get("isResumed") or summary.get("isLadder") is False:
        return None
    game_id = summary.get("gameId")
    if not isinstance(game_id, str) or not 0 < len(game_id) <= 200:
        return None
    date = parse_time(summary.get("dateIso"))
    now = datetime.now(timezone.utc)
    if date is not None and now - _RECENT_GAME_AGE <= date <= now + timedelta(seconds=30):
        return game_id, date
    return None


def _matches_unread_milestone(row, href):
    return (isinstance(row, dict) and row.get("href") == href and row.get("readAt") is None
            and isinstance(row.get("kind"), str) and row["kind"].startswith("moment."))


def _newest_notice(payload, href):
    items = payload.get("items") if isinstance(payload, dict) else None
    if not isinstance(items, list):
        return None
    # The bell endpoint orders newest first. Check the type and game again
    # for servers that do not understand the milestones query filter yet.
    for row in items:
        if not _matches_unread_milestone(row, href):
            continue
        title, body = row.get("title"), row.get("body")
        if isinstance(title, str) and title.strip():
            return title.strip(), body.strip() if isinstance(body, str) else ""
    return None


class MilestoneNotices:
    """Fetch on one advisory worker instead of the upload or live threads."""

    def __init__(self, *, state, state_dir, api_base, notify, stop_event):
        self._state, self._state_dir, self._api_base = state, state_dir, api_base
        self._notify = notify
        self._stop_event = stop_event
        self._changed = threading.Condition()
        self._latest: _SyncedGame | None = None
        # Wait for the live poller's first observation, including at startup
        # when an upload can finish before an already-running game is detected.
        self._between_games = False
        self._closed = False
        self._worker = threading.Thread(target=self._run, name="sc2tools-milestone-notices", daemon=True)

    def start(self):
        self._worker.start()

    def close(self):
        with self._changed:
            if self._closed:
                return
            self._closed = True
            self._changed.notify_all()
        self._worker.join(timeout=1)

    def on_game_event(self, event):
        with self._changed:
            between_games = event.phase in _BETWEEN_GAMES
            if between_games != self._between_games:
                self._between_games = between_games
                self._changed.notify_all()

    def on_game_synced(self, summary):
        owner, fresh = summary.get("_owner"), _fresh_game(summary)
        if not owner or fresh is None:
            return
        game_id, date = fresh
        ticket = replay_ticket(self._state)
        if ticket.owner != owner:
            return
        receipt_key = sha256(f"{owner}\0{game_id}".encode("utf-8")).hexdigest()
        href = "/app/game/" + quote(game_id, safe="!'()*")
        self._queue(_SyncedGame(date, href, receipt_key, ticket))

    def _queue(self, game):
        with self._changed:
            if self._closed or not self._eligible(game):
                return
            latest = self._latest
            if (latest and latest.ticket.epoch is game.ticket.epoch
                    and (latest.receipt_key == game.receipt_key or latest.date > game.date)):
                return
            self._latest = game
            self._changed.notify_all()

    def _eligible(self, game):
        with _STATE_SAVE_LOCK:
            state = self._state
            return (not self._stop_event.is_set() and state.notify_milestones
                    and not state.notifications_muted and state.is_paired
                    and game.ticket.current(state) and game.receipt_key not in state.milestone_notice_receipts)

    def _run(self):
        previous = None
        while True:
            with self._changed:
                self._changed.wait_for(lambda: self._closed or self._latest is not previous)
                if self._closed:
                    return
                previous = self._latest
            self._check_for_notice(previous)

    def _check_for_notice(self, game):
        def interrupted():
            return self._closed or self._latest is not game

        client = ApiClient(base_url=self._api_base, device_token=game.ticket.token,
                           _auth_guard=lambda: self._eligible(game))
        # Ingest responds before the bell sink finishes. Retry an empty read
        # or a transient transport failure without keeping an upload worker busy.
        for delay in _RETRY_DELAYS:
            with self._changed:
                self._changed.wait_for(interrupted, timeout=delay)
                self._changed.wait_for(lambda: interrupted() or self._between_games)
                if interrupted():
                    return
            if not self._eligible(game):
                return
            try:
                notice = _newest_notice(client.get_unread_milestones(), game.href)
            except ApiError as exc:
                if 400 <= exc.status < 500 and exc.status != 408:
                    return  # Includes old deployments, retired auth and rate limits.
                continue
            except RequestException:
                continue
            if notice is None:
                continue
            with self._changed:
                self._changed.wait_for(lambda: interrupted() or self._between_games)
                if interrupted():
                    return
                if self._deliver(game, notice):
                    return

    def _deliver(self, game, notice):
        with _STATE_SAVE_LOCK:
            if not self._eligible(game):
                return True
            state = self._state
            previous = state.milestone_notice_receipts
            cutoff = datetime.now(timezone.utc) - _RECENT_GAME_AGE
            state.milestone_notice_receipts = {
                key: stamp for key, stamp in previous.items()
                if (date := parse_time(stamp)) is not None and date >= cutoff
            }
            state.milestone_notice_receipts[game.receipt_key] = game.date.isoformat()
            # Claim durably before showing. A restart at this boundary can
            # miss a toast but can never replay one already given to the OS.
            try:
                save_state(self._state_dir, state)
            except Exception:
                state.milestone_notice_receipts = previous
                log.warning("milestone_notice_save_failed")
                return False
            title, body = notice
            try:
                self._notify(body or title, title=title if body else "SC2 Tools Agent")
            except Exception:
                log.warning("milestone_notice_display_failed")
            return True
