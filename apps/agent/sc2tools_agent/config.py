"""Runtime configuration for the agent.

Resolution order, highest priority first:
  1. CLI args (handled in runner.py)
  2. Environment variables (loaded from .env if present)
  3. Sensible defaults
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # python-dotenv missing in dev install — silent.
    pass


_DEFAULT_API_BASE = "https://sc2tools-api.onrender.com"
_DEFAULT_POLL_INTERVAL_SEC = 10
# Default parse concurrency: 4 workers. The replay-parse path is a
# mix of CPU-bound sc2reader work (GIL-bound) and I/O (reading the
# MPQ archive + uploading the JSON record), so more workers than
# CPU cores can still help. 4 is a safe baseline on modern PCs and
# delivers ~3x throughput vs. the old 1-worker default during a
# backfill of thousands of historical replays. Users with weaker
# hardware can lower it via the Settings tab; users with strong
# CPUs and a backfill in progress can push it higher (8–16).
_DEFAULT_PARSE_CONCURRENCY = 4
# Default upload concurrency: 2 workers.
#
# The cloud rate-limits to 120 req/min per IP (see
# ``apps/api/src/config/constants.js`` ``RATE_LIMIT_PER_MINUTE``).
# At the v0.5.8 default ``upload_batch_size=40``, each request
# carries ~3-4 MB of JSON which on a typical residential connection
# takes ~1.5 seconds end-to-end (TCP/TLS + upload + server insert +
# response). One worker can sustain ~40 req/min in that case —
# *half* the rate-limit budget. A second worker takes us to ~80
# req/min, comfortably under 120 with no 429 risk. A third would
# tip us into 120+ rps territory and start producing 429s we'd
# have to retry-after our way out of, so we cap the slider at 4
# (max useful even on fast networks where requests complete in
# 0.5 sec each).
_DEFAULT_UPLOAD_CONCURRENCY = 2
# Default upload batch size: 40 games per HTTP request.
#
# The cloud accepts up to 5 MB per body (see
# ``apps/api/src/config/constants.js`` ``REQUEST_BODY_BYTES``).
# Average game payloads are ~80 KB; long-game outliers with
# build_log near the 5000-event cap can reach ~150 KB. At 40
# games/batch worst case is 6 MB — slightly over — but typical
# is 3.2 MB. We pick 40 over 50 to leave margin for outliers; the
# 50-cap on the slider lets users push higher if their games are
# consistently smaller. Total throughput at the rate-limit ceiling:
# 120 req/min × 40 games = 4800 games/min ≈ 80 games/sec.
_DEFAULT_UPLOAD_BATCH_SIZE = 40

# Maximum useful upload-concurrency setting via the GUI / env var.
# Past 4 workers, the per-IP rate limit (120 req/min) means
# additional workers just queue up on 429s without delivering any
# real throughput — so the slider stops at 4. Power users on a
# self-hosted cloud API with a higher rate limit can bypass via
# the env var like ``parse_concurrency``.
UPLOAD_CONCURRENCY_USEFUL_MAX = 4
# Maximum upload batch size on the slider. The hard server limit is
# 5 MB request body; at ~150 KB per worst-case game, a batch of 50
# is the absolute ceiling that won't trip 413 Payload Too Large on
# a long Zerg game. The default of 40 leaves margin for the average
# user; the cap of 50 lets careful users push for marginal extra
# throughput on a workload of consistently-short games.
UPLOAD_BATCH_SIZE_USEFUL_MAX = 50

# Maximum useful parse-pool worker count via the GUI / state file.
# The cloud's 120 req/min rate limit × 25-game batch = ~50 games/sec
# end-to-end throughput; 1 parse worker delivers ~3-5 games/sec, so
# 8-12 workers fully saturate the upload pipeline. Anything past this
# ceiling just sits idle waiting for the upload queue to drain, plus
# costs ~150 MB of RAM per worker. 12 is the round number with
# headroom for slow-disk machines where per-replay parse times run
# longer than typical.
#
# The cap applies to:
#   - the Settings tab's parse-concurrency slider (UI maximum)
#   - the runner's promotion of ``state.parse_concurrency_override``
#     into the env var (so a stale 32 from before this cap was
#     introduced gets clamped automatically on next agent boot,
#     instead of silently spawning 32 workers that mostly idle)
#
# It does NOT apply to the ``SC2TOOLS_PARSE_CONCURRENCY`` env var
# itself — that's the escape hatch for power users running a
# self-hosted cloud API with no rate limit, where more parsers
# really do help.
PARSE_CONCURRENCY_USEFUL_MAX = 12


@dataclass(frozen=True)
class AgentConfig:
    """Immutable agent config snapshot."""

    api_base: str
    state_dir: Path
    replay_folder: Optional[Path]
    poll_interval_sec: int
    parse_concurrency: int
    # Default to single-threaded uploads when constructed without an
    # explicit value. Production code goes through ``load_config`` which
    # picks up the v0.5.8+ default of 4 from
    # ``_DEFAULT_UPLOAD_CONCURRENCY`` — but tests historically built
    # ``AgentConfig`` by hand and expected single-thread behaviour, so
    # leaving the constructor default at 1 keeps every legacy test
    # passing without touching them.
    upload_concurrency: int = 1
    # Same default-1 rationale as ``upload_concurrency``: legacy tests
    # expect "1 API call per uploaded game" (their stubs count
    # ``upload_game`` invocations to assert on retry behaviour).
    # Production picks up the v0.5.8+ default of 25 from
    # ``_DEFAULT_UPLOAD_BATCH_SIZE`` via ``load_config``.
    upload_batch_size: int = 1


def load_config() -> AgentConfig:
    """Read env, validate, fill defaults."""
    api_base = os.environ.get("SC2TOOLS_API_BASE", _DEFAULT_API_BASE).rstrip("/")
    state_dir = Path(os.environ.get("SC2TOOLS_STATE_DIR") or _default_state_dir())
    state_dir.mkdir(parents=True, exist_ok=True)
    replay_folder = _coerce_path(os.environ.get("SC2TOOLS_REPLAY_FOLDER"))
    poll = _coerce_int("SC2TOOLS_POLL_INTERVAL", _DEFAULT_POLL_INTERVAL_SEC)
    concurrency = _coerce_int(
        "SC2TOOLS_PARSE_CONCURRENCY", _DEFAULT_PARSE_CONCURRENCY,
    )
    upload_conc = _coerce_int(
        "SC2TOOLS_UPLOAD_CONCURRENCY", _DEFAULT_UPLOAD_CONCURRENCY,
    )
    upload_batch = _coerce_int(
        "SC2TOOLS_UPLOAD_BATCH_SIZE", _DEFAULT_UPLOAD_BATCH_SIZE,
    )
    return AgentConfig(
        api_base=api_base,
        state_dir=state_dir,
        replay_folder=replay_folder,
        poll_interval_sec=max(2, poll),
        parse_concurrency=max(1, concurrency),
        upload_concurrency=max(1, upload_conc),
        upload_batch_size=max(1, upload_batch),
    )


def _coerce_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _coerce_path(raw: Optional[str]) -> Optional[Path]:
    if not raw:
        return None
    p = Path(raw).expanduser()
    return p if p.exists() else None


def _default_state_dir() -> Path:
    """Pick the right per-user state dir for the OS."""
    if os.name == "nt":
        local_app = os.environ.get("LOCALAPPDATA")
        if local_app:
            return Path(local_app) / "sc2tools"
    xdg = os.environ.get("XDG_DATA_HOME")
    if xdg:
        return Path(xdg) / "sc2tools"
    return Path.home() / ".local" / "share" / "sc2tools"
