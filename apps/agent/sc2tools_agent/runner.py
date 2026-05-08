"""Top-level agent runner.

Wires together:

  config -> crash reporter -> state -> API -> pairing -> uploader ->
  watcher -> updater -> UI (gui + tray + console)

Each subsystem is constructed lazily from its module so a failure in
one path (e.g. tray import error on a headless server) doesn't take
the whole process down.

Two execution modes
-------------------

* **GUI mode** - when PySide6 is importable and the user hasn't passed
  ``--no-gui``. The Qt event loop runs on the main thread; the agent
  boot sequence (pairing, watcher, uploader, updater, heartbeat) runs
  on a worker thread and posts UI updates via Qt signals. This is the
  path that ships to non-technical users.

* **Headless mode** - the legacy path used by CI, the AppImage build,
  and developers who explicitly opt out. Uses the tray + console UIs
  exactly as the 0.2.x agent did.
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers
import os
import sys
import threading
from pathlib import Path
from typing import Any, List, Optional

from . import __version__
from . import autostart
from .api_client import ApiClient
from .config import AgentConfig, load_config
from .crash_reporter import (
    capture_exception,
    init_crash_reporter,
    shutdown as shutdown_crash_reporter,
)
from .heartbeat import Heartbeat
from .pairing import ensure_paired
from .socket_client import SocketClient, make_recompute_handlers
from .player_handle import (
    auto_detect_from_replays,
    read_cache as read_player_handle_cache,
    refresh_from_cloud as refresh_player_handle,
    write_cache as write_player_handle_cache,
)
from .replay_finder import (
    all_multiplayer_dirs,
    all_multiplayer_dirs_anywhere,
    find_all_replays_roots,
    find_replays_root,
)
from .replay_pipeline import probe_analyzer
from .state import AgentState, load_state, save_state
from .ui import (
    ConsoleUI,
    GuiUI,
    SettingsPayload,
    TrayUI,
    can_use_gui,
    can_use_tray,
)
from .updater import ReleaseInfo, Updater, install_release
from .uploader.queue import UploadQueue
from .watcher import ReplayWatcher

LOG_FILENAME = "agent.log"
LOG_MAX_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 3


def run_agent(argv: Optional[List[str]] = None) -> int:
    """Main entry. Returns the process exit code.

    ``argv`` is split out for tests; production callers pass ``None``
    to use ``sys.argv[1:]``.
    """
    args = _parse_args(argv)

    # The state file may carry an API base override the user set in
    # the GUI Settings tab. Apply it BEFORE load_config() runs so
    # AgentConfig sees the right base URL on startup.
    cfg, log_dir = _bootstrap(args)

    init_crash_reporter(release=f"sc2tools-agent@{__version__}")
    log = logging.getLogger("sc2tools_agent")
    log.info(
        "agent_starting version=%s api=%s argv=%s",
        __version__,
        cfg.api_base,
        argv if argv is not None else sys.argv[1:],
    )

    use_gui = (not args.no_gui) and can_use_gui()
    if args.no_gui:
        log.info("gui_disabled_via_flag")
    elif not can_use_gui():
        log.info("gui_unavailable_falling_back_to_tray_console")

    try:
        if use_gui:
            return _run_with_gui(cfg, log_dir, start_minimized=args.start_minimized)
        return _run_headless(cfg, log_dir)
    except Exception as exc:  # noqa: BLE001
        log.exception("agent_crashed_top_level")
        capture_exception(exc)
        return 1
    finally:
        shutdown_crash_reporter()


# ---------------- argv ----------------


def _parse_args(argv: Optional[List[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="sc2tools-agent",
        description="Local replay watcher + cloud uploader.",
    )
    parser.add_argument(
        "--no-gui",
        action="store_true",
        help=(
            "Disable the PySide6 main window. The system tray + console "
            "UI still come up. Useful for CI, headless servers, or "
            "developers iterating on backend code."
        ),
    )
    parser.add_argument(
        "--start-minimized",
        action="store_true",
        help=(
            "Start the GUI hidden - only the tray icon is visible. "
            "Set automatically by the Windows autostart entry so the "
            "agent doesn't pop a window on every login."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"sc2tools-agent {__version__}",
    )
    return parser.parse_args(argv)


def _bootstrap(args: argparse.Namespace) -> tuple:
    """Apply state-stored env overrides, then load config + logging."""
    cfg = load_config()
    state = load_state(cfg.state_dir)
    needs_reload = False
    if state.api_base_override and not os.environ.get("SC2TOOLS_API_BASE"):
        os.environ["SC2TOOLS_API_BASE"] = state.api_base_override
        needs_reload = True
    if state.log_level_override and not os.environ.get("SC2TOOLS_LOG_LEVEL"):
        os.environ["SC2TOOLS_LOG_LEVEL"] = state.log_level_override
    # The Settings-tab parse-concurrency knob is persisted in state
    # but ``AgentConfig`` reads it from the env var (so command-line
    # / .env / state all converge on one source of truth). Re-load
    # the config after promoting state into the env so the watcher
    # sees the user's chosen worker count on the very first sweep.
    if (
        state.parse_concurrency_override
        and not os.environ.get("SC2TOOLS_PARSE_CONCURRENCY")
    ):
        os.environ["SC2TOOLS_PARSE_CONCURRENCY"] = str(
            state.parse_concurrency_override,
        )
        needs_reload = True
    if needs_reload:
        cfg = load_config()

    if state.start_minimized:
        args.start_minimized = True

    log_dir = _configure_logging(cfg)
    return cfg, log_dir


# ---------------- Execution paths ----------------


def _run_headless(cfg: AgentConfig, log_dir: Path) -> int:
    """Legacy path - console + tray. Identical to the 0.2.x runner."""
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
    heartbeat: Optional[Heartbeat] = None
    socket_client: Optional[SocketClient] = None

    if can_use_tray():
        tray = TrayUI(
            dashboard_url=_dashboard_url_from_api(cfg.api_base),
            log_dir=log_dir,
            replay_folders=initial_replay_folders,
            on_pause=lambda paused: _handle_pause(cfg, state, upload, paused),
            on_resync=lambda: _handle_resync(cfg, state, upload),
            on_choose_folder=lambda picked: _handle_choose_folder(
                cfg, state, picked, tray, log, upload=upload,
            ),
            on_check_updates=lambda: updater.check_now() if updater else None,
        )

    ui = _Multiplexer(console, tray)
    log.info("agent_ui_ready tray=%s log_dir=%s", bool(tray), log_dir)

    if tray:
        tray.start(on_quit=request_stop)

    ui.on_status("connecting...")

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
            ui.on_status("not paired - exiting")
            return 1
        api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)
        ui.on_paired(state.user_id or "")

    probe_ok, probe_diag = probe_analyzer()
    if not probe_ok:
        log.error(
            "analyzer_probe_failed_at_startup — replays will not be parsed "
            "until the analyzer can be loaded. Diagnostic: %s",
            probe_diag,
        )

    _ensure_player_handle(api, cfg, state, initial_replay_folders, log)

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
            tray, console, None, release, log,
        ),
    )

    heartbeat = Heartbeat(api)

    if state.device_token:
        on_macro, on_opp, on_full_resync = make_recompute_handlers(
            state_dir=cfg.state_dir,
            queue_resync_for_paths=lambda paths: _queue_replays_for_resync(
                state, upload, paths, log,
            ),
            # Same semantics as the GUI's Re-sync button: drop the
            # uploaded cursor and have the watcher re-walk every replay
            # folder so spatial extracts (and any other newly-added
            # outputs) get backfilled on a fresh parse.
            full_resync=lambda: _handle_resync(cfg, state, upload),
        )
        socket_client = SocketClient(
            base_url=cfg.api_base,
            device_token=state.device_token,
            on_recompute_games=on_macro,
            on_recompute_opp_build=on_opp,
            on_full_resync=on_full_resync,
        )

    try:
        upload.start()
        watcher.start()
        updater.start()
        heartbeat.start()
        if socket_client is not None:
            socket_client.start()
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
        if socket_client:
            socket_client.stop()
        if heartbeat:
            heartbeat.stop()
        if updater:
            updater.stop()
        if watcher:
            watcher.stop()
        if upload:
            upload.stop()
        if tray:
            tray.stop()
    return 0


def _run_with_gui(
    cfg: AgentConfig, log_dir: Path, *, start_minimized: bool,
) -> int:
    """GUI path - Qt main loop on the main thread, agent on a worker."""
    log = logging.getLogger("sc2tools_agent")
    state = load_state(cfg.state_dir)
    initial_folders = _discover_replay_folders(cfg, state)

    cell = _RuntimeCell()
    stop_event = threading.Event()
    request_stop_lock = threading.Lock()
    stop_called = {"value": False}

    def request_stop() -> None:
        with request_stop_lock:
            if stop_called["value"]:
                return
            stop_called["value"] = True
        stop_event.set()
        if cell.gui:
            cell.gui.request_quit()

    initial_settings = SettingsPayload(
        api_base=state.api_base_override,
        log_level=state.log_level_override or "INFO",
        replay_folders=[Path(p) for p in state.replay_folders_override],
        replay_folder=(
            Path(state.replay_folder_override)
            if state.replay_folder_override
            else None
        ),
        autostart_enabled=autostart.is_enabled(),
        start_minimized=state.start_minimized,
        # Surface the cached handle (cloud profile or prior auto-detect)
        # so the user sees what the agent will use when no override is
        # set. Empty when nothing has been resolved yet — the placeholder
        # text in the input field tells them the implications.
        player_handle=read_player_handle_cache(cfg.state_dir) or "",
        # Show the EFFECTIVE concurrency the watcher will use this run,
        # which is the override-if-set otherwise the config default.
        # cfg.parse_concurrency already incorporates env vars + state
        # via _bootstrap, so it's the single source of truth.
        parse_concurrency=cfg.parse_concurrency,
    )

    gui = GuiUI(
        version=__version__,
        dashboard_url=_dashboard_url_from_api(cfg.api_base),
        pairing_url=_pairing_url_from_api(cfg.api_base),
        log_dir=log_dir,
        log_file=log_dir / LOG_FILENAME,
        api_base=cfg.api_base,
        replay_folders=initial_folders,
        initial_paused=state.paused,
        initial_paired=state.is_paired,
        initial_user_id=state.user_id,
        initial_settings=initial_settings,
        on_pause=lambda paused: _handle_pause(cfg, state, cell.upload, paused),
        on_resync=lambda: _handle_resync(cfg, state, cell.upload),
        on_choose_folder=lambda picked: _handle_choose_folder_gui(
            cfg, state, picked, cell, log,
        ),
        on_check_updates=lambda: cell.updater.check_now() if cell.updater else None,
        on_save_settings=lambda payload: _handle_save_settings(
            cfg, state, payload, cell, log,
        ),
        on_quit=request_stop,
        start_minimized=start_minimized,
    )
    cell.gui = gui

    tray: Optional[TrayUI] = None
    if can_use_tray():
        tray = TrayUI(
            dashboard_url=_dashboard_url_from_api(cfg.api_base),
            log_dir=log_dir,
            replay_folders=initial_folders,
            on_pause=lambda paused: _handle_pause(cfg, state, cell.upload, paused),
            on_resync=lambda: _handle_resync(cfg, state, cell.upload),
            on_choose_folder=lambda picked: _handle_choose_folder_gui(
                cfg, state, picked, cell, log,
            ),
            on_check_updates=lambda: cell.updater.check_now() if cell.updater else None,
        )
        cell.tray = tray
        tray.start(on_quit=request_stop)

    console = ConsoleUI()
    cell.console = console

    multiplex = _Multiplexer(console, tray, gui)
    cell.ui = multiplex
    log.info(
        "agent_ui_ready gui=%s tray=%s log_dir=%s",
        bool(gui),
        bool(tray),
        log_dir,
    )

    worker = threading.Thread(
        target=_gui_boot_worker,
        kwargs={
            "cfg": cfg,
            "state": state,
            "cell": cell,
            "ui": multiplex,
            "stop_event": stop_event,
            "log": log,
        },
        name="sc2tools-boot",
        daemon=True,
    )
    worker.start()

    rc = gui.run()

    log.info("agent_stopping rc=%s", rc)
    request_stop()
    if getattr(cell, "socket_client", None):
        cell.socket_client.stop()
    if cell.heartbeat:
        cell.heartbeat.stop()
    if cell.updater:
        cell.updater.stop()
    if cell.watcher:
        cell.watcher.stop()
    if cell.upload:
        cell.upload.stop()
    if cell.tray:
        cell.tray.stop()
    worker.join(timeout=4.0)
    return rc


def _gui_boot_worker(
    *,
    cfg: AgentConfig,
    state: AgentState,
    cell,
    ui,
    stop_event: threading.Event,
    log: logging.Logger,
) -> None:
    """Run the agent's startup sequence outside the Qt thread."""
    try:
        api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)

        ui.on_status("connecting...")

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
                log.warning("not paired; exiting (gui)")
                ui.on_status("not paired - exiting")
                if cell.gui:
                    cell.gui.request_quit()
                return
            api = ApiClient(
                base_url=cfg.api_base, device_token=state.device_token,
            )
            ui.on_paired(state.user_id or "")

        probe_ok, probe_diag = probe_analyzer()
        if not probe_ok:
            log.error(
                "analyzer_probe_failed_at_startup — replays will not be "
                "parsed until the analyzer can be loaded. Diagnostic: %s",
                probe_diag,
            )

        folders_for_detect = _discover_replay_folders(cfg, state)
        _ensure_player_handle(api, cfg, state, folders_for_detect, log)

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
                cell.tray, cell.console, cell.gui, release, log,
            ),
        )
        heartbeat = Heartbeat(api)

        cell.upload = upload
        cell.watcher = watcher
        cell.updater = updater
        cell.heartbeat = heartbeat

        socket_client: Optional[SocketClient] = None
        if state.device_token:
            on_macro, on_opp, on_full_resync = make_recompute_handlers(
                state_dir=cfg.state_dir,
                queue_resync_for_paths=lambda paths: _queue_replays_for_resync(
                    state, upload, paths, log,
                ),
                full_resync=lambda: _handle_resync(cfg, state, upload),
            )
            socket_client = SocketClient(
                base_url=cfg.api_base,
                device_token=state.device_token,
                on_recompute_games=on_macro,
                on_recompute_opp_build=on_opp,
                on_full_resync=on_full_resync,
            )
        cell.socket_client = socket_client

        upload.start()
        watcher.start()
        updater.start()
        heartbeat.start()
        if socket_client is not None:
            socket_client.start()
        ui.on_status(
            "watching for replays" + (" (paused)" if state.paused else ""),
        )
        log.info("agent_ready (gui worker) paused=%s", state.paused)
    except Exception as exc:  # noqa: BLE001
        log.exception("agent_boot_worker_failed")
        ui.on_status(f"error: {exc}")
        capture_exception(exc)


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
    state.uploaded.clear()
    save_state(cfg.state_dir, state)
    if upload:
        upload.request_full_resync()
    logging.getLogger(__name__).info("agent_resync_requested")


def _queue_replays_for_resync(
    state: AgentState,
    upload: Optional[UploadQueue],
    paths: List[Path],
    log: logging.Logger,
) -> None:
    """Drop selected paths from the upload cursor so the next sweep
    re-parses + re-uploads only those replays.

    Used by the Socket.io client when the cloud asks for a per-game
    recompute (macro breakdown / opponent build order). Cheaper than
    a full Resync — the user can have thousands of replays on disk
    and a one-game recompute shouldn't re-walk every file.
    """
    if not paths or upload is None:
        return
    removed = 0
    for p in paths:
        key = str(p)
        if state.uploaded.pop(key, None) is not None:
            removed += 1
    if removed == 0:
        return
    upload.request_full_resync()
    log.info(
        "per_game_resync_queued count=%d total_requested=%d",
        removed,
        len(paths),
    )


def _handle_choose_folder(
    cfg: AgentConfig,
    state: AgentState,
    picked: Optional[Path],
    tray: Optional[TrayUI],
    log: logging.Logger,
    upload: Optional[UploadQueue] = None,
) -> None:
    """Tray "Choose replay folder…" — appends to the override list.

    Calls into ``upload.request_full_resync()`` so the watcher picks
    up the new root on its next sweep without needing a restart. The
    resync flag triggers a rediscovery, not a re-upload — the
    ``state.uploaded`` cursor is still respected so existing replays
    are not double-sent.
    """
    if not picked:
        log.info("folder_picker_cancelled")
        return
    raw = str(picked)
    if raw not in state.replay_folders_override:
        state.replay_folders_override.append(raw)
    # Keep the legacy single-string field aligned so a downgrade to an
    # older agent build still finds *something* to watch.
    state.replay_folder_override = raw
    save_state(cfg.state_dir, state)
    log.info(
        "replay_folder_added path=%s total=%d",
        picked,
        len(state.replay_folders_override),
    )
    folders = [Path(p) for p in state.replay_folders_override]
    if tray:
        tray.set_replay_folders(folders)
    if upload:
        upload.request_full_resync()


def _handle_choose_folder_gui(
    cfg: AgentConfig,
    state: AgentState,
    picked: Optional[Path],
    cell,
    log: logging.Logger,
) -> None:
    """Same as ``_handle_choose_folder`` but updates BOTH tray and GUI."""
    _handle_choose_folder(
        cfg, state, picked, cell.tray, log, upload=cell.upload,
    )
    if cell.gui:
        cell.gui.set_replay_folders(
            [Path(p) for p in state.replay_folders_override],
        )


def _handle_save_settings(
    cfg: AgentConfig,
    state: AgentState,
    payload: SettingsPayload,
    cell,
    log: logging.Logger,
) -> None:
    """Persist Settings-tab edits and apply the registry-side changes."""
    if payload.api_base is not None:
        state.api_base_override = payload.api_base or None
    if payload.log_level:
        state.log_level_override = payload.log_level
    if payload.player_handle is not None:
        # Empty string means "clear my override and fall back to cloud
        # profile / auto-detect". Anything else writes the user-typed
        # value into the cache the parser reads on every replay.
        try:
            write_player_handle_cache(
                cfg.state_dir, payload.player_handle or None,
            )
        except OSError:
            log.exception("player_handle_cache_write_failed")
    if payload.parse_concurrency is not None:
        # Clamp into the same range the spinbox enforces, so a malformed
        # JSON edit can't slip a 0 / negative through. Stored on state
        # so the next ``_bootstrap`` call promotes it into the env var
        # before AgentConfig reads it.
        n = int(payload.parse_concurrency)
        state.parse_concurrency_override = max(1, min(32, n))
    if payload.replay_folders is not None:
        # The Settings tab owns the full list — replace, don't merge.
        cleaned: list[str] = []
        seen: set[str] = set()
        for entry in payload.replay_folders:
            raw = str(entry).strip()
            if not raw or raw in seen:
                continue
            seen.add(raw)
            cleaned.append(raw)
        state.replay_folders_override = cleaned
        # Keep the legacy single-folder field pointing at the first
        # entry so a downgrade still has somewhere to watch.
        state.replay_folder_override = cleaned[0] if cleaned else None
    if payload.start_minimized is not None:
        state.start_minimized = bool(payload.start_minimized)
    if payload.autostart_enabled is not None:
        ok = autostart.set_enabled(bool(payload.autostart_enabled))
        if ok:
            state.autostart_enabled = bool(payload.autostart_enabled)
        else:
            log.warning(
                "autostart_toggle_unsupported_or_failed enabled=%s",
                payload.autostart_enabled,
            )

    save_state(cfg.state_dir, state)

    if payload.replay_folders is not None:
        folders = [Path(p) for p in state.replay_folders_override]
        if cell.tray:
            cell.tray.set_replay_folders(folders)
        if cell.gui:
            cell.gui.set_replay_folders(folders)
        # Force the live watcher to rediscover roots on its next sweep
        # so the new list takes effect without a restart.
        if cell.upload:
            cell.upload.request_full_resync()

    log.info(
        "settings_saved api_base=%s log_level=%s autostart=%s minimised=%s folders=%d",
        bool(state.api_base_override),
        state.log_level_override,
        state.autostart_enabled,
        state.start_minimized,
        len(state.replay_folders_override),
    )


def _handle_update_available(
    tray: Optional[TrayUI],
    console: Optional[ConsoleUI],
    gui: Optional[GuiUI],
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
    if gui and release.latest:
        gui.on_update_available(release.latest)
    if release.artifact and _running_frozen():
        try:
            log.info(
                "update_install_starting artifact=%s",
                release.artifact.platform,
            )
            install_release(release)
            if console:
                console.on_status(f"installer launched for {release.latest}")
        except Exception:  # noqa: BLE001
            log.exception("update_install_failed")
    elif release.latest and console:
        console.on_status(
            f"update available: {release.latest} (run installer manually)",
        )


# ---------------- helpers ----------------


def _ensure_player_handle(
    api: ApiClient,
    cfg: AgentConfig,
    state: AgentState,
    folders: List[Path],
    log: logging.Logger,
) -> Optional[str]:
    """Resolve a usable player handle, persist it, and return it.

    Resolution order, picking the first that yields a non-empty value:

      1. **Cloud profile** (``GET /v1/me/profile``) — the user typed
         it into Settings → Profile in the web app. This is the
         canonical source.
      2. **Disk cache** — the most recent successful resolution. Lets
         offline launches and transient API outages keep working.
      3. **Auto-detect from replays** — read the most recent replay
         in the watched folders, match the path's toon-handle to a
         player record, and harvest their display name. This means a
         brand-new install with ZERO setup still uploads correctly
         the first time the user plays a multiplayer game.

    On a successful auto-detect the value is written to the cache so
    subsequent starts (and the per-replay parser path) skip the scan.

    Returns the resolved handle, or ``None`` if no source produced one.
    Never raises — all branches are defensive because this runs in
    the GUI boot worker and must not abort agent startup.
    """
    # 1. Cloud — if it returns a value, refresh_from_cloud already wrote
    #    the disk cache for us, so nothing more to do here.
    try:
        cloud_handle = refresh_player_handle(api, cfg.state_dir)
    except Exception:  # noqa: BLE001
        log.exception("player_handle_refresh_unhandled")
        cloud_handle = None
    if cloud_handle:
        log.info("player_handle_resolved source=cloud")
        return cloud_handle

    # 2. Disk cache (cloud was empty / offline / unreachable).
    cached = read_player_handle_cache(cfg.state_dir)
    if cached:
        log.info("player_handle_resolved source=cache value=%s", cached)
        return cached

    # 3. Auto-detect from a recent replay. This is the only path that
    #    produces a usable handle for a fresh-install user who hasn't
    #    set their battleTag in the web UI — without it the agent
    #    would happily run forever, silently uploading zero games.
    try:
        detected = auto_detect_from_replays(folders)
    except Exception:  # noqa: BLE001
        log.exception("player_handle_auto_detect_unhandled")
        detected = None
    if detected:
        try:
            write_player_handle_cache(cfg.state_dir, detected)
        except OSError:
            log.warning("player_handle_cache_write_failed_post_autodetect")
        log.info("player_handle_resolved source=auto_detect value=%s", detected)
        return detected

    log.warning(
        "player_handle_unresolved — uploads will be skipped until the "
        "user sets battleTag in Settings → Profile or plays a game in "
        "a watched folder so auto-detect has something to scan.",
    )
    return None


def _discover_replay_folders(
    cfg: AgentConfig, state: AgentState,
) -> List[Path]:
    """Resolve every replay folder the watcher should observe.

    StarCraft II writes replays to a separate ``Replays/Multiplayer``
    folder for each (region, toon) pair, so a player who plays on
    multiple regions or with multiple battle.net handles owns more
    than one. The watcher takes a list and observes every entry
    recursively — passing in the parent of a Multiplayer dir (or the
    full ``StarCraft II/Accounts`` root) is fine because watchdog plus
    our periodic sweep both walk recursively.

    Resolution order:
      1. The user's explicit list from the Settings tab. Takes
         precedence in full when non-empty — auto-discovery is
         skipped so the user never gets a "ghost" extra folder
         appearing.
      2. The single-folder env override (``SC2TOOLS_REPLAY_FOLDER``).
         Mostly used by tests and headless runs.
      3. Auto-discovery: every ``Replays/Multiplayer`` dir under the
         detected ``StarCraft II/Accounts`` root.
    """
    out: List[Path] = []
    seen: set[str] = set()

    def _add(p: Path) -> None:
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            return
        seen.add(key)
        out.append(p)

    for raw in state.replay_folders_override:
        path = Path(raw)
        if path.exists():
            _add(path)

    if out:
        return out

    if cfg.replay_folder:
        return [cfg.replay_folder]

    # Discover every Replays/Multiplayer directory under EVERY detected
    # StarCraft II Accounts root. A player with one toon per region —
    # or one regular-Documents and one OneDrive copy of the same tree —
    # ends up with multiple folders here, and we want all of them.
    multi = all_multiplayer_dirs_anywhere()
    if multi:
        for mp in multi:
            _add(mp)
        return out

    # No Multiplayer dirs detected — fall back to watching the Accounts
    # roots themselves so the recursive walker still picks up replays
    # SC2 writes after we start.
    for root in find_all_replays_roots():
        _add(root)
    return out


_DEFAULT_DASHBOARD_URL = "https://sc2tools.com"


def _dashboard_url_from_api(api_base: str) -> str:
    """Best-guess dashboard URL from the API URL.

    Prod:    https://api.sc2tools.com         -> https://sc2tools.com
    Render:  https://sc2tools-api.onrender.com -> https://sc2tools.com
    Local:   http://localhost:8080            -> http://localhost:3000

    The production marketing + dashboard origin lives on the ``.com``
    apex (``sc2tools.com``); ``.app`` is no longer authoritative, and a
    stale ``.app`` link sends users to a broken page. The URL is also
    used as the base for the pairing page (``/devices``), so getting
    this right is critical for first-launch onboarding.
    """
    if api_base.startswith("http://localhost"):
        return "http://localhost:3000"
    if "://api." in api_base:
        return api_base.replace("://api.", "://", 1)
    return _DEFAULT_DASHBOARD_URL


def _pairing_url_from_api(api_base: str) -> str:
    """Pairing page lives at /devices on the dashboard origin."""
    return _dashboard_url_from_api(api_base).rstrip("/") + "/devices"


def _configure_logging(cfg: AgentConfig) -> Path:
    """Add a rotating file handler in the state dir + the console
    handler the agent always shipped with."""
    log_dir = cfg.state_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter(
        fmt="%(asctime)s %(levelname)s %(name)s | %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )
    root = logging.getLogger()
    root.setLevel(_log_level_from_env())
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


class _RuntimeCell:
    """Mutable container shared between the GUI thread and the boot
    worker. Kept as a plain class (no dataclass) so it never tries to
    deepcopy the live thread/queue handles."""

    __slots__ = (
        "gui",
        "tray",
        "console",
        "ui",
        "upload",
        "watcher",
        "updater",
        "heartbeat",
        "socket_client",
    )

    def __init__(self) -> None:
        self.gui = None
        self.tray = None
        self.console = None
        self.ui = None
        self.upload = None
        self.watcher = None
        self.updater = None
        self.heartbeat = None
        self.socket_client = None


class _Multiplexer:
    """Forward UI events to every wired-up sink (console + tray + gui)."""

    def __init__(
        self,
        console: ConsoleUI,
        tray: Optional[TrayUI] = None,
        gui: Optional[GuiUI] = None,
    ) -> None:
        self._sinks: List[Any] = [console]
        if tray:
            self._sinks.append(tray)
        if gui:
            self._sinks.append(gui)

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
