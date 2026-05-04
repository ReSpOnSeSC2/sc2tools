"""Crash reporter — Sentry SDK with battle-tag / path redaction.

Initialised lazily so an install without ``sentry_sdk`` (e.g. local
development before ``pip install -e .[dev]`` lands the optional dep)
never crashes on startup. The caller invokes :func:`init_crash_reporter`
once, ideally first thing in :mod:`sc2tools_agent.runner`.

The redaction filter walks every event before submission and:

  * scrubs ``battle_tag``, ``Name``, ``displayName``, ``handle``,
    ``pulse_id``, ``email`` style keys from arbitrary nested dicts;
  * replaces ``C:\\Users\\<user>\\…`` and ``/home/<user>/…`` with
    ``<user>`` so the Windows / POSIX home directory leak is gone;
  * trims ``.SC2Replay`` filenames down to the basename (no parent
    folders);
  * collapses request bodies / breadcrumb data deeper than 3 levels.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Dict, List, Optional, Tuple

from . import __version__

log = logging.getLogger(__name__)

# Substrings that mark a key as PII. Match is case-insensitive. We
# deliberately AVOID bare 3-letter fragments like "tag" or "id" — they
# match Sentry's own "tags" / "trace_id" envelope keys and would erase
# useful debug context.
_PII_KEY_FRAGMENTS: Tuple[str, ...] = (
    "battle_tag",
    "battletag",
    "displayname",
    "display_name",
    "handle",
    "pulse_id",
    "pulseid",
    "email",
    "user_id",
    "userid",
    "clerk_user_id",
    "clerkuserid",
    "device_token",
    "auth_token",
    "access_token",
    "session_token",
    "authorization",
    "x-admin-token",
    "first_name",
    "last_name",
    "full_name",
)

_HOME_PATH_RE = re.compile(
    r"(?:[A-Za-z]:\\Users\\[^\\\\/]+|/home/[^/]+|/Users/[^/]+)",
    re.IGNORECASE,
)
_REPLAY_PATH_RE = re.compile(r"([^/\\\\]+\.SC2Replay)\b", re.IGNORECASE)
_DSN_RE = re.compile(r"^https?://[A-Za-z0-9]+@[A-Za-z0-9./_-]+/[0-9]+$")

_MAX_DEPTH = 3
_MAX_STRING_LENGTH = 4096

_SENTRY: Any = None


def init_crash_reporter(
    *,
    dsn: Optional[str] = None,
    environment: Optional[str] = None,
    release: Optional[str] = None,
    sample_rate: float = 1.0,
) -> bool:
    """Configure the Sentry SDK if it's installed and a DSN is provided.

    Returns True when the reporter was successfully wired up. False when
    Sentry isn't available or no DSN is configured — both are normal
    during development.
    """
    global _SENTRY
    dsn = dsn or os.environ.get("SC2TOOLS_SENTRY_DSN") or os.environ.get("SENTRY_DSN")
    if not dsn:
        log.debug("crash_reporter_disabled reason=no_dsn")
        return False
    if not _DSN_RE.match(dsn):
        log.warning("crash_reporter_disabled reason=invalid_dsn")
        return False
    try:
        import sentry_sdk
    except ImportError:
        log.warning(
            "crash_reporter_disabled reason=sentry_sdk_not_installed "
            "(pip install sentry-sdk)",
        )
        return False
    sentry_sdk.init(
        dsn=dsn,
        environment=environment or os.environ.get("SC2TOOLS_ENV", "production"),
        release=release or f"sc2tools-agent@{__version__}",
        sample_rate=max(0.0, min(1.0, sample_rate)),
        send_default_pii=False,
        attach_stacktrace=True,
        before_send=_before_send,
        before_breadcrumb=_before_breadcrumb,
    )
    _SENTRY = sentry_sdk
    log.info(
        "crash_reporter_enabled environment=%s release=%s",
        environment or "production",
        f"sc2tools-agent@{__version__}",
    )
    return True


def capture_exception(exc: BaseException) -> None:
    """Submit an exception to Sentry if configured. No-op otherwise."""
    if not _SENTRY:
        return
    try:
        _SENTRY.capture_exception(exc)
    except Exception:  # noqa: BLE001
        log.exception("crash_capture_failed")


def capture_message(message: str, *, level: str = "info") -> None:
    """Submit a manual breadcrumb / message. No-op when Sentry isn't on."""
    if not _SENTRY:
        return
    try:
        _SENTRY.capture_message(message, level=level)
    except Exception:  # noqa: BLE001
        log.exception("crash_message_failed")


def shutdown(*, timeout_sec: float = 2.0) -> None:
    """Flush in-flight events on agent shutdown."""
    if not _SENTRY:
        return
    try:
        _SENTRY.flush(timeout=timeout_sec)
    except Exception:  # noqa: BLE001
        log.debug("crash_flush_failed", exc_info=True)


# ---------------- redaction ----------------


def _before_send(event: Dict[str, Any], _hint: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Strip every PII-shaped field from an event before sending."""
    try:
        return _redact_value(event, depth=0)
    except Exception:  # noqa: BLE001
        # Failing to redact MUST drop the event — better silent than leaky.
        log.exception("redaction_failed_event_dropped")
        return None


def _before_breadcrumb(
    crumb: Dict[str, Any], _hint: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    try:
        return _redact_value(crumb, depth=0)
    except Exception:  # noqa: BLE001
        return None


def _redact_value(value: Any, *, depth: int) -> Any:
    if depth > _MAX_DEPTH:
        return "[depth-capped]"
    if isinstance(value, dict):
        return _redact_dict(value, depth=depth)
    if isinstance(value, list):
        return _redact_list(value, depth=depth)
    if isinstance(value, tuple):
        return tuple(_redact_value(v, depth=depth + 1) for v in value)
    if isinstance(value, str):
        return _redact_string(value)
    return value


def _redact_dict(value: Dict[str, Any], *, depth: int) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for key, sub in value.items():
        if _is_pii_key(key):
            out[key] = "[redacted]"
            continue
        out[key] = _redact_value(sub, depth=depth + 1)
    return out


def _redact_list(value: List[Any], *, depth: int) -> List[Any]:
    return [_redact_value(item, depth=depth + 1) for item in value]


def _redact_string(value: str) -> str:
    if len(value) > _MAX_STRING_LENGTH:
        value = value[:_MAX_STRING_LENGTH] + "[…truncated]"
    value = _HOME_PATH_RE.sub("<user-home>", value)
    value = _REPLAY_PATH_RE.sub(r"\1", value)
    return value


def _is_pii_key(key: Any) -> bool:
    if not isinstance(key, str):
        return False
    lower = key.lower()
    return any(fragment in lower for fragment in _PII_KEY_FRAGMENTS)


__all__ = [
    "init_crash_reporter",
    "capture_exception",
    "capture_message",
    "shutdown",
]
