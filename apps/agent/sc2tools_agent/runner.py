"""Top-level agent runner.

Wires together:

  config → crash reporter → state → API → pairing → uploader →
  watcher → updater → UI (tray + console)

Each subsystem is constructed lazily from its module so a failure in
one path (e.g. tray import error on a headless server) doesn't take
the whole process down.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys
import threading
from pathlib import Path
from typing import Any, List, Optional

from . import __version__
from .api_client import ApiClient
from .config import AgentConfig, load_config
from .crash_reporter import (
    capture_exception,
    init_crash_reporter,
    shutdown as shutdown_crash_reporter,
)
from .pairing import ensure_paired
from .replay_finder import all_multiplayer_dirs, find_replays_root
from .state import AgentState, load_state, save_state
from .ui import ConsoleUI, TrayUI, can_use_tray
from .updater import ReleaseInfo, Updater, install_release
from .uploader.queue import UploadQueue
from .watcher import ReplayWatcher

LOG_FILENAME = "agent.log"
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 3


def run_agent() -> int:
    """Main entry. Returns the process exit code."""
    cfg = load_config()
    log_dir = _configure_logging(cfg)
    init_crash_reporter(release=f"sc2tools-agent@{__version__}")
    log = logging.getLogger("sc2tools_agent")
    log.info("agent_starting version=%s api=%s", __version__, cfg.api_base)

    try:
        return _run_main_loop(cfg, log_dir)
    except Exception as exc:  # noqa: BLE001
        log.exception("agent_crashed_top_level")
        capture_exception(exc)
        return 1
    finally:
        shutdown_crash_reporter()


def _run_main_loop(cfg: AgentConfig, log_dir: Path) -> int:
    log = logging.getLogger("sc2tools_agent")
    state = load_state(cfg.state_dir)
    api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)

    console = ConsoleUI()
    tray: Optional[TrayUI] = None

    stop_event = threading.Event()
    request_stop_lock = threading.Lock()
    stop_called = {"value": False}

    def request_stop() -> None:
        with request_stop_lock:
            if stop_called["value"]:
                return
            stop_called["value"] = True
        stop_event.set()
        console.request_stop()

    initial_replay_folders = _discover_replay_folders(cfg, state)
    upload: Optional[UploadQueue] = None
    watcher: Optional[ReplayWatcher] = None
    updater: Optional[Updater] = None

    if can_use_tray():
        tray = TrayUI(
            dashboard_url=_dashboard_url_from_api(cfg.api_base),
            log_dir=log_dir,
            replay_folders=initial_replay_folders,
            on_pause=lambda paused: _handle_pause(cfg, state, upload, paused),
            on_resync=lambda: _handle_resync(cfg, state, upload),
            on_choose_folder=lambda picked: _handle_choose_folder(
                cfg, state, picked, tray, log,
            ),
            on_check_updates=lambda: updater.check_now() if updater else None,
        )

    ui = _Multiplexer(console, tray)
    log.info("agent_ui_ready tray=%s log_dir=%s", bool(tray), log_dir)

    if tray:
        tray.start(on_quit=request_stop)

    ui.on_status("connecting…")

    if not state.is_paired:
        ui.on_status("waiting for pairing")
        paired = ensure_paired(
            cfg=cfg,
            state=state,
            api=api,
            on_code=ui.show_pairing_code,
            stop_event=stop_event,
        )
        if not paired:
            log.warning("not paired; exiting")
            ui.on_status("not paired — exiting")
            return 1
        api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)
        ui.on_paired(state.user_id or "")

    upload = UploadQueue(
        cfg=cfg,
        state=state,
        api=api,
        on_success=lambda p: ui.on_upload_success(p.name),
        on_failure=lambda p, exc: ui.on_upload_failed(p.name, str(exc)),
    )
    upload.set_paused(state.paused)
    watcher = ReplayWatcher(cfg=cfg, state=state, upload=upload)

    updater = Updater(
        cfg=cfg,
        state=state,
        on_update_available=lambda release: _handle_update_available(
            tray, console, release, log,
        ),
    )

    try:
        upload.start()
        watcher.start()
        updater.start()
        ui.on_status(
            "watching for replays" + (" (paused)" if state.paused else ""),
        )
        log.info("agent_ready paused=%s", state.paused)
        console.wait_for_exit()
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # noqa: BLE001
        log.exception("agent_loop_failed")
        capture_exception(exc)
        return 1
    finally:
        log.info("agent_stopping")
        if updater:
            updater.stop()
        if watcher:
            watcher.stop()
        if upload:
            upload.stop()
        if tray:
            tray.stop()
    return 0


# ---------------- callbacks ----------------


def _handle_pause(
    cfg: AgentConfig,
    state: AgentState,
    upload: Optional[UploadQueue],
    paused: bool,
) -> None:
    state.paused = paused
    save_state(cfg.state_dir, state)
    if upload:
        upload.set_paused(paused)
    logging.getLogger(__name__).info("agent_pause_toggled paused=%s", paused)


def _handle_resync(
    cfg: AgentConfig,
    state: AgentState,
    upload: Optional[UploadQueue],
) -> None:
    """Wipe the dedupe cursor + force the watcher to re-enqueue every
    replay in the configured folders. Idempotent on the cloud — the
    upsert path keys off ``gameId``."""
    state.uploaded.clear()
    save_state(cfg.state_dir, state)
    if upload:
        upload.request_full_resync()
    logging.getLogger(__name__).info("agent_resync_requested")


def _handle_choose_folder(
    cfg: AgentConfig,
    state: AgentState,
    picked: Optional[Path],
    tray: Optional[TrayUI],
    log: logging.Logger,
) -> None:
    if not picked:
        log.info("folder_picker_cancelled")
        return
    state.replay_folder_override = str(picked)
    save_state(cfg.state_dir, state)
    log.info("replay_folder_overridden path=%s", picked)
    if tray:
        tray.set_replay_folders([picked])


def _handle_update_available(
    tray: Optional[TrayUI],
    console: ConsoleUI,
    release: ReleaseInfo,
    log: logging.Logger,
) -> None:
    if release.latest:
        log.info(
            "update_available channel=%s latest=%s current=%s",
            release.channel,
            release.latest,
            release.current,
        )
    if tray and release.latest:
        tray.on_update_available(release.latest)
    if release.artifact and _running_frozen():
        try:
            log.info(
                "update_install_starting artifact=%s",
                release.artifact.platform,
            )
            install_release(release)
            console.on_status(f"installer launched for {release.latest}")
        except Exception:  # noqa: BLE001
            log.exception("update_install_failed")
    elif release.latest:
        console.on_status(
            f"update available: {release.latest} (run installer manually)",
        )


# ---------------- helpers ----------------


def _discover_replay_folders(
    cfg: AgentConfig, state: AgentState,
) -> List[Path]:
    if state.replay_folder_override:
        override = Path(state.replay_folder_override)
        if override.exists():
            return [override]
    if cfg.replay_folder:
        return [cfg.replay_folder]
    root = find_replays_root()
    if not root:
        return []
    multi = all_multiplayer_dirs(root)
    if multi:
        return list(multi)
    return [root]


def _dashboard_url_from_api(api_base: str) -> str:
    """Best-guess dashboard URL from the API URL.

    Prod:    https://api.sc2tools.app  → https://sc2tools.app
    Render:  https://sc2tools-api.onrender.com → https://sc2tools.app
    Local:   http://localhost:8080 → http://localhost:3000
    """
    if api_base.startswith("http://localhost"):
        return "http://localhost:3000"
    if "://api." in api_base:
        return api_base.replace("://api.", "://", 1)
    return "https://sc2tools.app"


def _configure_logging(cfg: AgentConfig) -> Path:
    """Add a rotating file handler in the state dir + the console
    handler the agent always shipped with. Returns the directory
    path so the tray can offer "Open log folder"."""
    log_dir = cfg.state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s | %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(_log_level_from_env())
    # Fresh wiring: drop any handlers that an embedding installed (e.g.
    # tests) so we're idempotent across invocations.
    for handler in list(root.handlers):
        root.removeHandler(handler)
    console = logging.StreamHandler()
    console.setFormatter(fmt)
    root.addHandler(console)
    file_handler = logging.handlers.RotatingFileHandler(
        log_dir / LOG_FILENAME,
        maxBytes=LOG_MAX_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    file_handler.setFormatter(fmt)
    root.addHandler(file_handler)
    return log_dir


def _log_level_from_env() -> int:
    raw = os.environ.get("SC2TOOLS_LOG_LEVEL", "INFO").upper()
    return getattr(logging, raw, logging.INFO)


def _running_frozen() -> bool:
    return getattr(sys, "frozen", False) is True


class _Multiplexer:
    """Forward UI events to console + tray."""

    def __init__(self, console: ConsoleUI, tray: Optional[TrayUI]) -> None:
        self._sinks: list[Any] = [console] + ([tray] if tray else [])

    def show_pairing_code(self, code: str) -> None:
        for s in self._sinks:
            s.show_pairing_code(code)

    def on_paired(self, user_id: str) -> None:
        for s in self._sinks:
            s.on_paired(user_id)

    def on_status(self, status: str) -> None:
        for s in self._sinks:
            s.on_status(status)

    def on_upload_success(self, name: str) -> None:
        for s in self._sinks:
            s.on_upload_success(name)

    def on_upload_failed(self, name: str, reason: str) -> None:
        for s in self._sinks:
            s.on_upload_failed(name, reason)


__all__ = ["run_agent"]
