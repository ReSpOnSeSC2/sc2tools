"""One deterministic status model for the window, sidebar and tray."""
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any

from .folder_info import folder_identity


class AgentStatus(str, Enum):
    STARTING = "starting"
    CONNECTING = "connecting"
    NEEDS_PAIRING = "needs_pairing"
    UNLINKED = "unlinked"
    WATCHING = "watching"
    SYNCING = "syncing"
    PAUSED = "paused"
    NEEDS_ATTENTION = "needs_attention"
    ERROR = "error"


@dataclass(frozen=True)
class ConnectionFacts:
    kind: str = "online"
    waiting_count: int = 0
    next_retry_at: float = 0


@dataclass
class StatusFacts:
    phase: str = "starting"
    boot_error: str = ""
    analyzer_ok: bool = True
    analyzer_diag: str = ""
    paired: bool = False
    unlinked: bool = False
    paused: bool = False
    paused_until: float | None = None
    connection: ConnectionFacts = field(default_factory=ConnectionFacts)
    pending_count: int = 0
    terminal_failure_times: list[float] = field(default_factory=list)
    latest_failure_title: str = ""
    folders: list[Any] | None = None
    filter_label: str = ""
    last_upload_at: float | None = None
    update_pending: str | None = None


@dataclass(frozen=True)
class StatusView:
    status: AgentStatus
    badge_text: str
    tone: str
    headline: str
    cause: str = ""
    action: str | None = None
    secondary_action: str | None = None
    update_pending: bool = False


def _view(facts, now):
    if facts.boot_error or facts.phase == "boot_error":
        return StatusView(AgentStatus.ERROR, "Error", "err", "SC2 Tools couldn't start syncing",
                          (facts.boot_error.strip().splitlines() or ["Open Activity log for startup details."])[0][:140], "open_log", "copy_details")
    if not facts.analyzer_ok:
        return StatusView(AgentStatus.ERROR, "Error", "err", "Replays can't be read right now",
                          "The replay analyzer failed to load; new games wait until it does.", "open_log", "copy_details")
    if facts.unlinked:
        return StatusView(AgentStatus.UNLINKED, "Unlinked", "warn", "This PC was unlinked from your account", "", "pair_again")
    if not facts.paired:
        return StatusView(AgentStatus.NEEDS_PAIRING, "Link this PC", "warn", "Link this PC to your account", "Use the code below.")
    if facts.paused:
        cause = "New replays wait until you resume."
        if facts.paused_until:
            from datetime import datetime
            cause = "Paused until " + datetime.fromtimestamp(facts.paused_until).strftime("%H:%M")
        return StatusView(AgentStatus.PAUSED, "Paused", "warn", "Sync paused", cause, "resume")
    connection = facts.connection
    if connection.kind != "online":
        headline = "SC2 Tools is busy" if connection.kind == "server_busy" else "Can't reach sc2tools.com"
        seconds = max(0, int(connection.next_retry_at - now))
        cause = f"{connection.waiting_count:,} replays waiting · retrying in {seconds} s"
        return StatusView(AgentStatus.NEEDS_ATTENTION, "Needs attention", "warn", headline, cause, "retry")
    failures = [stamp for stamp in facts.terminal_failure_times if 0 <= now - stamp <= 600]
    if len(failures) >= 3:
        return StatusView(AgentStatus.NEEDS_ATTENTION, "Needs attention", "warn",
                          f"{len(failures)} uploads failed in the last 10 minutes",
                          facts.latest_failure_title, "view_failed")
    folders = facts.folders
    if folders is not None and not folders:
        return StatusView(AgentStatus.NEEDS_ATTENTION, "Needs attention", "warn", "No replay folder found",
                          "Add your StarCraft II Replays folder.", "open_settings")
    if facts.pending_count > 0:
        return StatusView(AgentStatus.SYNCING, "Syncing", "info", f"Syncing {facts.pending_count:,} replays",
                          "Uploads run in the background.")
    if facts.phase in ("ready", "watching"):
        regions = sorted({getattr(folder, "region", None) or folder_identity(getattr(folder, "path", folder))[0] or "?"
                          for folder in folders or []})
        count = len(folders or [])
        headline = f"Watching {count} folder" + ("s" if count != 1 else "")
        if regions:
            headline += " (" + ", ".join(regions) + ")"
        cause = "Waiting for your next game"
        if facts.last_upload_at:
            age = max(0, int((now - facts.last_upload_at) / 60))
            cause = f"Last upload {age} min ago" if age else "Last upload just now"
        return StatusView(AgentStatus.WATCHING, "Watching", "ok", headline, cause, "open_settings")
    if facts.phase.rstrip(".") == "connecting":
        return StatusView(AgentStatus.CONNECTING, "Connecting", "neutral", "Connecting to sc2tools.com…")
    return StatusView(AgentStatus.STARTING, "Starting", "neutral", "Starting SC2 Tools…")


def derive_status(facts, now):
    view = _view(facts, now)
    label = facts.filter_label
    headline = view.headline + (" · " + label if label and label != "All time" else "")
    return replace(view, headline=headline, update_pending=bool(facts.update_pending))
