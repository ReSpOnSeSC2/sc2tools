"""Date-range filter for the watcher's upload decision.

Mirrors the global filter bar on the web app
(``apps/web/lib/datePresets.ts``) so the user can scope which replays
the agent uploads in the same vocabulary they use to read them back:

  * ``all``                — no filter (default; legacy behaviour)
  * ``current_season``     — replays played in the in-progress
                             ladder season
  * ``season:<N>``         — replays played during a specific season
  * ``custom``             — user-supplied ``since`` / ``until`` ISO
                             dates (either bound is optional)

Why agent-side filtering exists at all: a new install on a long-time
streamer's PC can find tens of thousands of historical replays. Most
streamers only care about THIS season (or this month) for the live
overlay and analytics. Without a filter, the agent grinds through
every old replay — burns CPU on the parser, fills the cloud with rows
the user will never look at, and pays Mongo storage on the API side.

The filter is applied at TWO points in the watcher pipeline:

  1. ``mtime_in_range`` — cheap pre-check during the sweep walk.
     File mtime is the OS-recorded "last modified" timestamp; SC2
     writes it when the replay is saved. We grant a 7-day slack
     window on either side to absorb clock skew, OneDrive sync
     timestamps, and the case where a user copies a backup of old
     replays into the watched folder (mtime gets the copy time, not
     the play time). Files outside the slack window are NEVER
     parsed — that's where the speed-up during a backfill comes
     from.
  2. ``replay_in_range`` — accurate check after the parser has
     extracted ``cloud_game.date_iso``. Catches the false positives
     the mtime pre-check let through.

A "filtered" replay is recorded in ``state.uploaded`` with the value
``"filtered"`` so future sweeps skip it without re-parsing. The runner
clears these entries when the user changes the filter so the next
sweep re-evaluates everything against the new range — cheaper than
making the watcher carry a hash of the active filter.

Season catalog is the same anchored approximation the web app uses
(``apps/web/lib/seasonCatalog.ts``): Season 67 starts 2026-04-01, each
season is ~91 days. Within a few days of the true Blizzard boundary,
which is well within the 7-day mtime slack — the user can drop into
"Custom range" for surgical precision.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional

log = logging.getLogger(__name__)


PRESET_ALL = "all"
PRESET_CURRENT_SEASON = "current_season"
PRESET_CUSTOM = "custom"
PRESET_SEASON_PREFIX = "season:"

# Mirror ``apps/web/lib/seasonCatalog.ts``. When the website's anchor
# moves, this constant moves with it — they MUST match so the agent's
# "Season 67" filter matches what the website calls "Season 67".
ANCHOR_SEASON = 67
ANCHOR_START = datetime(2026, 4, 1, tzinfo=timezone.utc)
SEASON_LENGTH = timedelta(days=91)

# Slack on either side of the user's chosen range when pre-filtering by
# file mtime. Wide enough to absorb clock skew on the gaming PC, the
# OneDrive sync stamping the file with the SYNC time instead of the
# PLAY time, and a user who backed up old replays and restored them
# into the watched folder (mtime = restore time). We pay for it with a
# few extra parses per filter boundary; cheap.
MTIME_SLACK = timedelta(days=7)

# Validation: the agent stores the user's preset as a free-text string
# but every value we ship through this module must match one of these
# patterns. Anything else is treated as ``all`` (i.e. the user gets the
# full feed) so a malformed state file can't hide replays from the
# user without a clear error.
_PRESET_RE = re.compile(r"^(all|current_season|custom|season:-?\d+)$")


@dataclass(frozen=True)
class SyncFilter:
    """User-chosen window for which replays the agent uploads.

    Frozen so the value is safe to share across the watcher's parse
    threads without a lock.
    """

    preset: str = PRESET_ALL
    since_iso: Optional[str] = None
    until_iso: Optional[str] = None

    @classmethod
    def from_state(
        cls,
        preset: Optional[str],
        since_iso: Optional[str],
        until_iso: Optional[str],
    ) -> "SyncFilter":
        """Build a SyncFilter from raw state fields.

        Defensive parser: malformed presets fall back to ``all`` so a
        broken state file never hides a streamer's replays. Custom
        ranges with unparseable dates also fall back to ``all`` rather
        than silently dropping one bound.
        """
        normalised = (preset or "").strip().lower()
        if not _PRESET_RE.match(normalised):
            normalised = PRESET_ALL
        if normalised == PRESET_CUSTOM:
            since = _parse_iso_date(since_iso)
            until = _parse_iso_date(until_iso)
            if since is None and until is None:
                # Custom with no anchors is a no-op; treat as "all"
                # rather than a wide-open custom that confuses logs.
                return cls(preset=PRESET_ALL)
        return cls(
            preset=normalised,
            since_iso=since_iso,
            until_iso=until_iso,
        )

    def resolve(self, *, now: Optional[datetime] = None) -> tuple[Optional[datetime], Optional[datetime]]:
        """Return the concrete ``(since, until)`` tuple.

        Either bound may be None ("open on this side"). ``now`` is
        injectable for tests so we can pin the clock.
        """
        if self.preset == PRESET_ALL:
            return (None, None)
        if self.preset == PRESET_CUSTOM:
            return (
                _parse_iso_date(self.since_iso),
                _parse_iso_date(self.until_iso, end_of_day=True),
            )
        if self.preset == PRESET_CURRENT_SEASON:
            return _season_bounds(current_season(now=now), now=now)
        if self.preset.startswith(PRESET_SEASON_PREFIX):
            try:
                n = int(self.preset[len(PRESET_SEASON_PREFIX):])
            except ValueError:
                return (None, None)
            return _season_bounds(n, now=now)
        return (None, None)

    def is_active(self) -> bool:
        """True iff the filter actually narrows the upload set."""
        if self.preset == PRESET_ALL:
            return False
        since, until = self.resolve()
        return since is not None or until is not None

    def mtime_in_range(self, mtime_unix: float, *, now: Optional[datetime] = None) -> bool:
        """Cheap mtime pre-check used during the watcher sweep.

        Returns True iff the file MIGHT fall inside the window — the
        slack window means we err on the side of inclusion so a
        slightly-skewed clock can't hide a real replay. The accurate
        check runs post-parse against the real replay date.
        """
        since, until = self.resolve(now=now)
        if since is None and until is None:
            return True
        try:
            mtime = datetime.fromtimestamp(mtime_unix, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            # A garbage stat result shouldn't hide the file — let the
            # parser see it and the post-parse check decide.
            return True
        if since is not None and mtime < since - MTIME_SLACK:
            return False
        if until is not None and mtime > until + MTIME_SLACK:
            return False
        return True

    def replay_in_range(
        self,
        date_iso: Optional[str],
        *,
        now: Optional[datetime] = None,
    ) -> bool:
        """Accurate check against the post-parse ``CloudGame.date_iso``.

        Falls back to "include" when the date can't be parsed — the
        replay was clearly important enough to parse successfully, so
        we'd rather upload a borderline-malformed timestamp than hide
        it from the user.
        """
        since, until = self.resolve(now=now)
        if since is None and until is None:
            return True
        if not date_iso:
            return True
        d = _parse_iso_datetime(date_iso)
        if d is None:
            return True
        if since is not None and d < since:
            return False
        if until is not None and d > until:
            return False
        return True

    def short_label(self) -> str:
        """Short human label for log lines / status bar."""
        if self.preset == PRESET_ALL:
            return "all time"
        if self.preset == PRESET_CURRENT_SEASON:
            return f"Season {current_season()}"
        if self.preset.startswith(PRESET_SEASON_PREFIX):
            return f"Season {self.preset[len(PRESET_SEASON_PREFIX):]}"
        if self.preset == PRESET_CUSTOM:
            since = self.since_iso or "—"
            until = self.until_iso or "now"
            return f"{since} → {until}"
        return self.preset


def current_season(*, now: Optional[datetime] = None) -> int:
    """Best-effort guess for the season in progress right now.

    Mirrors ``apps/web/lib/seasonCatalog.ts#currentSeason``.
    """
    pinned = now if now is not None else datetime.now(tz=timezone.utc)
    if pinned.tzinfo is None:
        pinned = pinned.replace(tzinfo=timezone.utc)
    offset_ms = (pinned - ANCHOR_START).total_seconds() * 1000
    season_ms = SEASON_LENGTH.total_seconds() * 1000
    offset_seasons = int(offset_ms // season_ms) if offset_ms >= 0 else -((-int(offset_ms) // int(season_ms)) + 1)
    return ANCHOR_SEASON + offset_seasons


def _season_bounds(
    season: int, *, now: Optional[datetime] = None,
) -> tuple[datetime, datetime]:
    """Compute (start, end) for a season number. End is clamped to now.

    Mirrors ``apps/web/lib/seasonCatalog.ts#seasonRange``.
    """
    pinned = now if now is not None else datetime.now(tz=timezone.utc)
    if pinned.tzinfo is None:
        pinned = pinned.replace(tzinfo=timezone.utc)
    offset = season - ANCHOR_SEASON
    start = ANCHOR_START + offset * SEASON_LENGTH
    raw_end = start + SEASON_LENGTH - timedelta(milliseconds=1)
    end = pinned if raw_end > pinned else raw_end
    return (start, end)


def _parse_iso_date(
    raw: Optional[str], *, end_of_day: bool = False,
) -> Optional[datetime]:
    """Parse a YYYY-MM-DD or full ISO datetime into a UTC datetime.

    Returns None on any parse failure — the caller treats None as
    "no bound on this side". ``end_of_day=True`` is for the upper
    bound of a Custom range so a user-typed "2026-05-08" includes
    everything played that day.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    s = raw.strip()
    # YYYY-MM-DD shape FIRST — Python 3.12's fromisoformat would
    # otherwise accept the bare date as midnight UTC, which silently
    # ignores ``end_of_day=True`` and breaks the Custom range upper
    # bound (a user-typed "2026-05-01" should include everything
    # played that day, not just the moment 00:00:00.000).
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if m:
        try:
            y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            base = datetime(y, mo, d, tzinfo=timezone.utc)
        except ValueError:
            return None
        if end_of_day:
            base = base.replace(
                hour=23, minute=59, second=59, microsecond=999_000,
            )
        return base
    # Full ISO datetime path — anything carrying time-of-day or a
    # tz designator. ``end_of_day`` is intentionally ignored here
    # because the caller has already specified a precise instant.
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _parse_iso_datetime(raw: str) -> Optional[datetime]:
    """Parse the agent's ``CloudGame.date_iso`` (always RFC 3339 UTC).

    The agent's ``_to_iso`` in replay_pipeline.py guarantees a 'Z'
    suffix on every CloudGame, so this is the cheap path. We still
    fall through to the more permissive ``_parse_iso_date`` for
    forward-compat with any stored value that took a different shape.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        dt = datetime.fromisoformat(raw.strip().replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return _parse_iso_date(raw)
