"""Translate transport and per-file failures into actionable, deterministic copy."""
from dataclasses import dataclass
import requests


@dataclass(frozen=True)
class UserError:
    kind: str
    title: str
    detail: str
    action: str
    transient: bool

    @property
    def help_anchor(self):
        return self.kind.replace("_", "-")


def classify(exc: Exception) -> UserError:
    from .api_client import ReplayIngestBusy, ReplayArchiveSourceUnavailable
    from .uploader.queue import TerminalUploadError
    detail = str(exc)
    status = getattr(exc, "status", None)
    if status in (401, 403):
        return UserError("signed_out", "This PC needs to be linked again", detail,
                         "Link this PC", True)
    if status == 429:
        return UserError("rate_limited", "Sync is waiting for a short break", detail,
                         "Wait; syncing will resume automatically", True)
    if isinstance(exc, ReplayIngestBusy) or isinstance(status, int) and status >= 500:
        return UserError("server_busy", "SC2 Tools is busy", detail,
                         "Wait or retry now", True)
    if status == 408 or isinstance(exc, (ConnectionError, TimeoutError, requests.ConnectionError, requests.Timeout)):
        return UserError("offline", "Can't reach SC2 Tools", detail,
                         "Check your internet connection or retry now", True)
    if isinstance(exc, TerminalUploadError):
        titles = {"game_payload_too_large": "This replay has too much data to sync",
                  "unsupported_replay": "This replay format isn't supported",
                  "invalid_game": "This replay could not be accepted"}
        title = next((title for key, title in titles.items() if key in detail),
                     "This replay could not be accepted")
        if not exc.counts_as_error:
            title = "Outside your selected sync range"
        return UserError("rejected", title, detail, "Review the replay details", False)
    if isinstance(exc, (OSError, ReplayArchiveSourceUnavailable)):
        return UserError("file", "This replay file isn't ready", detail,
                         "Check that the file can be read and SC2 has finished saving", True)
    if status is not None and 400 <= status < 500:
        return UserError("rejected", "This replay could not be accepted", detail,
                         "Open the activity log for details", False)
    return UserError("unknown", "Sync couldn't finish yet", detail,
                     "Retry or open the activity log", True)
