"""Qt-free sync health: pushed facts, an ordered rule table and coalesced snapshots.

Subsystems report facts through small O(1) setters on ``HealthMonitor``. Each
push replaces one frozen ``HealthFacts`` under a single lock and claims at most
one pending recompute. The recompute turns the latest facts into an immutable
``HealthSnapshot`` at most twice a second and hands it to subscribers outside
that lock. Only the standard library (and the stdlib-only folder labels) is
imported, so headless runs, the tray and the window can all share it.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime
import errno
import logging
import os
import threading
import time

from .folder_info import folder_identity

log = logging.getLogger(__name__)

RECOMPUTE_INTERVAL_SEC = 0.5  # at most two snapshots a second
FAILURE_WINDOW_SEC = 600
FAILURE_WARN_AT = 3
MAX_FAILURE_TIMES = 50
UNRESOLVED_WARN_AT = 3
UNRESOLVED_WINDOW_SEC = 7 * 86400  # only the last week's skips warn
HEARTBEAT_GRACE_SEC = 150  # about three missed 60 s heartbeats
LIVE_CONTACT_SEC = 15  # the client poller backs off to 5 s while SC2 is idle
STARTING_PHASES = ("starting", "connecting")
LEVELS = ("ok", "info", "warn", "error", "off")
ACTIONS = frozenset({"link_pc", "retry_now", "add_folder", "set_player_name", "resume",
                     "open_obs_settings", "install_update", "restart_agent", "copy_details", "open_log"})
STATUS_HELP = "desktop-app-status"
SYNC_HELP = "desktop-app-sync-problems"
BOOT_HEADLINES = {
    "analyzer": "SC2 Tools couldn't load the replay analyzer",
    "state_dir": "SC2 Tools can't use its data folder",
    "network": "SC2 Tools couldn't reach sc2tools.com",
    "unknown": "SC2 Tools couldn't start syncing",
}

_RANK = {"error": 0, "warn": 1, "info": 2, "ok": 3}
_CLOUD = {"offline": "Can't reach sc2tools.com", "server_busy": "sc2tools.com is busy",
          "rate_limited": "sc2tools.com asked SC2 Tools to slow down",
          "signed_out": "sc2tools.com signed this PC out"}
_IDENTITY = {"cloud": "Your player name comes from your sc2tools.com profile.",
             "cache": "Your player name is saved on this PC.",
             "auto_detect": "Your player name was found in your replays.",
             "settings": "Your player name is set in Settings."}
_ANALYZER_PACKAGES = frozenset({"core", "sc2reader", "mpyq", "s2protocol"})
# Matched by class name so this module never imports requests.
_REQUESTS_NETWORK = frozenset({"requests.exceptions.ConnectionError", "requests.exceptions.Timeout"})
_BLOCKED_ERRNOS = frozenset({errno.EACCES, errno.EPERM})
_BLOCKED_WINERRORS = frozenset({5, 32, 33})  # access denied, file in use, file locked
_STORAGE_ERRNOS = frozenset({errno.EROFS, errno.ENOSPC})
_STORAGE_WINERRORS = frozenset({112})  # disk full


@dataclass(frozen=True)
class BootFailure:
    kind: str
    summary: str


@dataclass(frozen=True)
class HealthFacts:
    """Everything the rules read. ``None`` means that subsystem hasn't reported yet."""

    phase: str = "starting"
    boot: BootFailure | None = None
    # Pairing
    paired: bool | None = None
    unlinked: bool = False
    # Cloud
    heartbeat_ok_at: float | None = None
    heartbeat_failed_at: float | None = None
    heartbeat_failing_since: float | None = None
    socket_connected: bool | None = None
    connection: str = "online"
    connection_since: float = 0.0
    retry_at: float = 0.0
    error_kind: str = ""
    # Folders, identity and the analyzer
    folders: tuple[str, ...] | None = None
    missing_folders: tuple[str, ...] = ()
    identity_source: str | None = None
    analyzer_ok: bool | None = None
    analyzer_diag: str = ""
    # Sync
    paused: bool = False
    paused_until: float | None = None
    filter_label: str = ""
    pending: int = 0
    archive_pending: int = 0
    archive_missing: int = 0
    archive_total: int = 0
    failure_times: tuple[float, ...] = ()
    skipped: tuple[tuple[str, int], ...] = ()
    unresolved_times: tuple[float, ...] = ()
    last_upload_at: float | None = None
    # Live, OBS and updates
    live_enabled: bool | None = None
    live_contact_at: float | None = None
    obs_enabled: bool | None = None
    obs_connected: bool | None = None
    obs_auth_failed: bool = False
    update_version: str | None = None
    update_required: bool = False
    update_failed: bool = False
    auto_update: bool | None = None

    def skipped_count(self, reason):
        return dict(self.skipped).get(reason, 0)


@dataclass(frozen=True)
class HealthRow:
    id: str
    level: str
    sentence: str
    action: str | None = None
    help_slug: str = STATUS_HELP


@dataclass(frozen=True)
class HealthSnapshot:
    headline: str
    attention: int
    level: str
    tray: str | None
    rows: tuple[HealthRow, ...] = ()
    footer: tuple[HealthRow, ...] = ()


# ---------------- rule table ----------------


def _plural(count, word):
    return f"{count:,} {word}" + ("" if count == 1 else "s")


def _age(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return "just now"
    if seconds < 3600:
        return f"{seconds // 60} min ago"
    if seconds < 172800:
        return f"{seconds // 3600} h ago"
    return f"{seconds // 86400} days ago"


def _clock_time(stamp):
    try:
        return datetime.fromtimestamp(stamp).strftime("%H:%M")
    except (OverflowError, OSError, ValueError):
        return ""


def _starting(facts):
    return facts.phase.rstrip(".") in STARTING_PHASES


def _syncing(facts):
    return facts.paired is True and not facts.unlinked


def _boot(facts):
    if facts.boot is None and facts.phase != "boot_error":
        return None
    failure = facts.boot or BootFailure("unknown", "Open the Activity log for startup details.")
    return HealthRow("boot", "error", failure.summary, "restart_agent")


def _pairing(facts, now):
    if facts.unlinked:
        return HealthRow("pairing", "warn", "This PC was unlinked from your account.", "link_pc")
    if facts.paired is False:
        return HealthRow("pairing", "warn", "Link this PC to your account to start syncing.", "link_pc")
    if facts.paired:
        return HealthRow("pairing", "ok", "This PC is linked to your account.")
    return None


def _paused(facts, now):
    if not facts.paused:
        return None
    until = _clock_time(facts.paused_until) if facts.paused_until else ""
    sentence = f"Sync is paused until {until}." if until else "Sync is paused, so new replays wait until you resume."
    return HealthRow("paused", "warn", sentence, "resume")


def _cloud(facts, now):
    if not _syncing(facts):
        return None
    # A pause freezes the queue's hold, so the heartbeat rows speak for the cloud meanwhile.
    if facts.connection != "online" and not facts.paused:
        waiting = facts.pending
        tail = f", so {_plural(waiting, 'replay')} {'is' if waiting == 1 else 'are'} waiting" if waiting else ""
        action = "link_pc" if facts.connection == "signed_out" else "retry_now"
        return HealthRow("cloud", "warn", _CLOUD.get(facts.connection, _CLOUD["offline"]) + tail + ".",
                         action, SYNC_HELP)
    since = facts.heartbeat_failing_since
    if since is not None and now - since >= HEARTBEAT_GRACE_SEC:
        cause = _CLOUD["server_busy" if facts.error_kind == "server_busy" else "offline"]
        return HealthRow("cloud", "warn", cause + " right now; SC2 Tools keeps trying.", None, SYNC_HELP)
    if facts.socket_connected is False:
        return HealthRow("cloud", "info", "Actions from the website can't reach this PC right now.")
    if facts.heartbeat_ok_at is not None:
        return HealthRow("cloud", "ok", "Connected to sc2tools.com.")
    return None


def _failures(facts, now):
    count = sum(0 <= now - stamp <= FAILURE_WINDOW_SEC for stamp in facts.failure_times)
    if count < FAILURE_WARN_AT:
        return None
    return HealthRow("failures", "warn", f"{count:,} uploads failed in the last 10 minutes.", "open_log")


def _folders(facts, now):
    if facts.folders is None:
        return None
    if not facts.folders:
        return HealthRow("folders", "warn", "No replay folder found; add your StarCraft II Replays folder.",
                         "add_folder")
    missing = len(facts.missing_folders)
    if missing:
        verb = "is" if missing == 1 else "are"
        return HealthRow("folders", "warn", f"{_plural(missing, 'replay folder')} you added {verb} missing.",
                         "add_folder")
    regions = sorted({region for path in facts.folders if (region := folder_identity(path)[0])})
    where = f" ({', '.join(regions)})" if regions else ""
    return HealthRow("folders", "ok", f"Watching {_plural(len(facts.folders), 'replay folder')}{where}.")


def _identity(facts, now):
    unresolved = sum(0 <= now - stamp <= UNRESOLVED_WINDOW_SEC for stamp in facts.unresolved_times)
    if unresolved >= UNRESOLVED_WARN_AT:
        return HealthRow("identity", "warn", f"{unresolved:,} games from the last week were skipped because "
                         "SC2 Tools couldn't tell which player was you.", "set_player_name")
    source = facts.identity_source
    if source is None:
        return None
    if source == "none":
        return HealthRow("identity", "info", "SC2 Tools doesn't know your player name yet.", "set_player_name")
    return HealthRow("identity", "ok", _IDENTITY.get(source, "Your player name is set."))


def _analyzer(facts, now):
    if facts.analyzer_ok is False:
        return HealthRow("analyzer", "error", "The replay analyzer didn't load, so new replays can't be read.",
                         "open_log")
    if facts.analyzer_ok:
        return HealthRow("analyzer", "ok", "The replay analyzer is ready.")
    return None


def _uploads(facts, now):
    # Pairing, pause and connection rows already explain why nothing moves.
    if not _syncing(facts) or facts.paused or facts.connection != "online":
        return None
    if facts.pending:
        return HealthRow("uploads", "info", f"Uploading {_plural(facts.pending, 'replay')}.")
    if facts.archive_pending:
        return HealthRow("uploads", "info", f"Backing up {_plural(facts.archive_pending, 'replay file')}.")
    if facts.last_upload_at is not None:
        return HealthRow("uploads", "ok", f"Last upload {_age(now - facts.last_upload_at)}.")
    if not _starting(facts):
        return HealthRow("uploads", "ok", "Waiting for your next game.")
    return None


def _archive(facts, now):
    missing, total = facts.archive_missing, facts.archive_total
    if missing <= 0 or total <= 0:
        return None
    if missing == 1:
        sentence = f"1 of your {total:,} saved games needs one full Re-sync to back up its replay file."
    else:
        sentence = f"{missing:,} of your {total:,} saved games need one full Re-sync to back up their replay files."
    return HealthRow("archive", "info", sentence)


def _filter(facts, now):
    label = facts.filter_label.strip()
    if not label or label.casefold() == "all time":
        return None
    return HealthRow("filter", "info", f"Only games from {label} sync.")


def _updates(facts, now):
    version = facts.update_version
    if not version:
        return None
    if facts.update_failed:
        return HealthRow("updates", "warn", f"Version {version} couldn't install.", "install_update")
    if facts.update_required:
        return HealthRow("updates", "warn", f"This version is no longer supported; install version {version}.",
                         "install_update")
    return HealthRow("updates", "info", f"Version {version} is ready to install.", "install_update")


def _live(facts, now):
    if facts.live_enabled is None:
        return None
    if not facts.live_enabled:
        return HealthRow("live", "off", "Live game features are off.")
    contact = facts.live_contact_at
    if contact is not None and 0 <= now - contact <= LIVE_CONTACT_SEC:
        return HealthRow("live", "ok", "Connected to StarCraft II.")
    return HealthRow("live", "off", "StarCraft II is closed.")


def _obs(facts, now):
    if facts.obs_enabled is None:
        return None
    if not facts.obs_enabled:
        return HealthRow("obs", "off", "OBS scene switching is off.")
    if facts.obs_auth_failed:
        return HealthRow("obs", "warn", "OBS rejected the saved password.", "open_obs_settings")
    if facts.obs_connected is False:
        return HealthRow("obs", "info", "OBS isn't connected, so scenes won't switch.", "open_obs_settings")
    if facts.obs_connected:
        return HealthRow("obs", "ok", "Connected to OBS.")
    return None


def _auto_update(facts, now):
    if facts.auto_update is False:
        return HealthRow("auto_update", "off", "Automatic updates are off.")
    return None


# Table order breaks ties inside a level and decides the tray: the first warn
# row wins, so a pairing problem stays amber while a pause greys the rest.
RULES = (_pairing, _paused, _cloud, _failures, _folders, _identity, _analyzer,
         _uploads, _archive, _filter, _updates, _live, _obs, _auto_update)


def _headline(facts, attention):
    if facts.boot is not None or facts.phase == "boot_error":
        return BOOT_HEADLINES.get(facts.boot.kind if facts.boot else "unknown", BOOT_HEADLINES["unknown"])
    if attention:
        return "1 thing needs attention" if attention == 1 else f"{attention} things need attention"
    return "Starting SC2 Tools…" if _starting(facts) else "Everything's working"


def _tray_level(facts, rows, attention):
    top = rows[0] if rows else None
    if top is not None and top.level == "error":
        return "red"
    if _starting(facts) and not attention:
        return None
    if top is not None and top.level == "warn":
        return "grey" if top.id == "paused" else "amber"
    return "green"


def evaluate(facts, now):
    """Turn one set of facts into a snapshot. Pure: equal inputs give equal snapshots."""
    boot = _boot(facts)
    rows = (boot,) if boot else tuple(row for rule in RULES if (row := rule(facts, now)) is not None)
    visible = tuple(sorted((row for row in rows if row.level != "off"), key=lambda row: _RANK[row.level]))
    footer = tuple(row for row in rows if row.level == "off")
    attention = sum(row.level in ("warn", "error") for row in visible)
    return HealthSnapshot(_headline(facts, attention), attention, visible[0].level if visible else "ok",
                          _tray_level(facts, visible, attention), visible, footer)


# ---------------- boot failures ----------------


def _first_line(exc, limit=140):
    try:
        text = str(exc)
    except Exception:  # noqa: BLE001 - a broken __str__ must not hide the failure
        text = ""
    return (text.strip().splitlines() or [""])[0][:limit]


def _reason(exc):
    if isinstance(exc, OSError) and exc.strerror:
        return str(exc.strerror)[:100]  # strerror never carries the file path
    return _first_line(exc, 100)


def _summary(sentence, reason):
    return f"{sentence} ({reason})." if reason else sentence + "."


def _is_network(exc):
    status = getattr(exc, "status", None)
    if isinstance(status, int) and (status in (408, 429) or status >= 500):
        return True
    names = {f"{cls.__module__}.{cls.__qualname__}" for cls in type(exc).__mro__}
    return isinstance(exc, (ConnectionError, TimeoutError)) or bool(names & _REQUESTS_NETWORK)


def _is_analyzer(exc):
    modules = [getattr(exc, "name", None) or ""] if isinstance(exc, ImportError) else []
    trace = exc.__traceback__
    while trace is not None:
        modules.append(trace.tb_frame.f_globals.get("__name__") or "")
        trace = trace.tb_next
    return any(module.split(".")[0] in _ANALYZER_PACKAGES for module in modules)


def _inside(name, root):
    if not isinstance(name, (str, os.PathLike)):
        return False
    path, base = (os.path.normcase(os.path.abspath(os.fspath(item))) for item in (name, root))
    return path == base or path.startswith(base.rstrip("\\/") + os.sep)


def _is_blocked(exc):
    if not isinstance(exc, OSError):
        return False
    return (isinstance(exc, PermissionError) or exc.errno in _BLOCKED_ERRNOS
            or getattr(exc, "winerror", None) in _BLOCKED_WINERRORS)


def _is_state_error(exc, state_dir):
    if not isinstance(exc, OSError):
        return False
    if exc.errno in _STORAGE_ERRNOS or getattr(exc, "winerror", None) in _STORAGE_WINERRORS:
        return True
    return state_dir is not None and any(_inside(name, state_dir) for name in (exc.filename, exc.filename2))


def _classify_boot(exc, state_dir):
    if _is_network(exc):
        return BootFailure("network", "Check your internet connection, then restart SC2 Tools.")
    if _is_analyzer(exc):
        return BootFailure("analyzer", _summary("The replay analyzer didn't load", _reason(exc)))
    if _is_blocked(exc):
        return BootFailure("state_dir", _summary("Windows blocked a file or folder SC2 Tools needs", _reason(exc)))
    if _is_state_error(exc, state_dir):
        return BootFailure("state_dir", _summary("SC2 Tools can't use its data folder", _reason(exc)))
    if isinstance(exc, OSError):  # strerror only, so no file path reaches the row
        return BootFailure("unknown", _summary("SC2 Tools couldn't open a file it needs", _reason(exc)))
    return BootFailure("unknown", _first_line(exc) or "Open the Activity log for startup details.")


def classify_boot_error(exc, *, state_dir=None):
    """Name a startup failure's cause in one plain line. Never raises."""
    try:
        return _classify_boot(exc, state_dir)
    except Exception:  # noqa: BLE001 - the boot error path must always have something to show
        return BootFailure("unknown", _first_line(exc) or "Open the Activity log for startup details.")


# ---------------- monitor ----------------


def _start_timer(delay, callback):
    timer = threading.Timer(delay, callback)
    timer.name, timer.daemon = "sc2tools-health", True
    timer.start()


def _paths(items):
    return tuple(str(getattr(item, "path", item)) for item in items or ())


def _recent(times, at):
    kept = tuple(stamp for stamp in times if 0 <= at - stamp <= FAILURE_WINDOW_SEC)
    return kept[-(MAX_FAILURE_TIMES - 1):] + (at,)


class HealthMonitor:
    """Coalesce pushed facts into at most two snapshots a second.

    Every setter replaces the frozen facts under one lock, so pushes from many
    threads never lose each other. A recompute always reads the newest facts,
    equal snapshots are dropped, and subscribers run outside the lock with the
    newest snapshot delivered last.
    """

    def __init__(self, *, clock=time.monotonic, now=time.time, schedule=_start_timer,
                 interval=RECOMPUTE_INTERVAL_SEC):
        self._clock, self._now, self._schedule, self._interval = clock, now, schedule, interval
        self._lock = threading.Lock()
        self._facts = HealthFacts()
        self._scheduled = False
        self._next_run_at = None
        self._taken = self._delivered = 0
        self._snapshot = None
        self._emitting = False
        self._subscribers = []

    def subscribe(self, callback):
        with self._lock:
            self._subscribers.append(callback)

    def facts(self):
        with self._lock:
            return self._facts

    def snapshot(self):
        with self._lock:
            return self._snapshot

    def refresh(self):
        """Re-check the time-based rules (failure window, ages) without new facts."""
        self._apply(None)

    # ---- setters, one small push per fact ----

    def set_phase(self, phase):
        self._set(phase=str(phase or "starting"))

    def set_boot_error(self, failure):
        self._set(boot=failure)

    def set_pairing(self, paired, *, unlinked=False):
        self._set(paired=bool(paired), unlinked=bool(unlinked))

    def heartbeat_ok(self, at=None):
        self._set(heartbeat_ok_at=self._stamp(at), heartbeat_failing_since=None)

    def heartbeat_failed(self, kind="", at=None):
        at = self._stamp(at)
        self._apply(lambda facts: replace(
            facts, heartbeat_failed_at=at, error_kind=kind or facts.error_kind,
            heartbeat_failing_since=at if facts.heartbeat_failing_since is None else facts.heartbeat_failing_since))

    def set_socket(self, connected):
        self._set(socket_connected=bool(connected))

    def set_connection(self, kind, since=0.0, retry_at=0.0):
        kind = kind or "online"
        changes = {"connection": kind, "connection_since": since or 0.0, "retry_at": retry_at or 0.0}
        if kind != "online":
            changes["error_kind"] = kind
        self._set(**changes)

    def set_transport_error(self, kind):
        self._set(error_kind=kind or "")

    def set_folders(self, watched, missing=()):
        self._set(folders=None if watched is None else _paths(watched), missing_folders=_paths(missing))

    def set_identity(self, source):
        self._set(identity_source=source or "none")

    def set_analyzer(self, ok, diag=""):
        self._set(analyzer_ok=bool(ok), analyzer_diag=diag or "")

    def set_paused(self, paused, until=None):
        self._set(paused=bool(paused), paused_until=until if paused else None)

    def set_filter_label(self, label):
        self._set(filter_label=label or "")

    def set_pending(self, count):
        self._set(pending=max(0, int(count or 0)))

    def set_archive_pending(self, count):
        self._set(archive_pending=max(0, int(count or 0)))

    def set_archive_status(self, missing, total):
        self._set(archive_missing=max(0, int(missing or 0)), archive_total=max(0, int(total or 0)))

    def upload_failed(self, at=None):
        at = self._stamp(at)
        self._apply(lambda facts: replace(facts, failure_times=_recent(facts.failure_times, at)))

    def upload_succeeded(self, at=None):
        at = self._stamp(at)
        self._apply(lambda facts: replace(
            facts, last_upload_at=at if facts.last_upload_at is None else max(at, facts.last_upload_at)))

    def set_unresolved_skips(self, times):
        """When the user's own games were skipped as unresolved; only the newest are kept."""
        self._set(unresolved_times=tuple(sorted(float(stamp) for stamp in times or ()))[-MAX_FAILURE_TIMES:])

    def set_skipped(self, counts):
        self._set(skipped=tuple(sorted((str(reason), int(count)) for reason, count in dict(counts or {}).items()
                                       if count)))

    def set_live(self, enabled):
        self._set(live_enabled=bool(enabled))

    def live_contact(self, at=None):
        self._set(live_enabled=True, live_contact_at=self._stamp(at))

    def set_obs(self, enabled, *, connected=None, auth_failed=False):
        self._set(obs_enabled=bool(enabled), obs_connected=connected, obs_auth_failed=bool(auth_failed))

    def set_update(self, version, *, required=False, failed=False):
        self._set(update_version=version or None, update_required=bool(required), update_failed=bool(failed))

    def set_auto_update(self, enabled):
        self._set(auto_update=bool(enabled))

    # ---- coalescing ----

    def _stamp(self, at):
        return self._now() if at is None else float(at)

    def _set(self, **fields):
        self._apply(lambda facts: replace(facts, **fields))

    def _apply(self, change):
        with self._lock:
            if change is not None:
                self._facts = change(self._facts)
            if self._scheduled:
                return  # the pending recompute will read these facts
            self._scheduled = True
            due = self._next_run_at
            delay = 0.0 if due is None else max(0.0, due - self._clock())
        try:
            self._schedule(delay, self._recompute)
        except Exception:  # noqa: BLE001 - a push must never fail the subsystem that sent it
            with self._lock:
                self._scheduled = False
            log.debug("health_schedule_failed", exc_info=True)

    def _recompute(self):
        with self._lock:
            self._scheduled = False
            self._next_run_at = self._clock() + self._interval
            self._taken += 1
            facts, sequence = self._facts, self._taken
        try:
            snapshot = evaluate(facts, self._now())
        except Exception:  # noqa: BLE001 - keep the last good snapshot
            log.exception("health_evaluate_failed")
            return
        self._deliver(snapshot, sequence)

    def _deliver(self, snapshot, sequence):
        with self._lock:
            if sequence <= self._delivered:
                return  # a newer recompute already finished
            self._delivered = sequence
            if snapshot == self._snapshot:
                return
            self._snapshot = snapshot
            if self._emitting:
                return  # the active emitter delivers it next
            self._emitting = True
            subscribers = tuple(self._subscribers)
        while True:
            for subscriber in subscribers:
                try:
                    subscriber(snapshot)
                except Exception:  # noqa: BLE001 - one broken sink must not stop the others
                    log.exception("health_subscriber_failed")
            with self._lock:
                if self._snapshot is snapshot:
                    self._emitting = False
                    return
                snapshot, subscribers = self._snapshot, tuple(self._subscribers)
