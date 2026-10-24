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
import time
import urllib.parse
import webbrowser
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import __version__
from . import autostart
from .api_client import ApiClient
from .build_checkin import build_checkin_view_for, start_build_checkin
from .build_checkin.wiring import web_queue_url
from .config import AgentConfig, load_config
from .crash_reporter import (
    capture_exception,
    init_crash_reporter,
    shutdown as shutdown_crash_reporter,
)
from .heartbeat import Heartbeat
from .instance_lock import AgentInstanceLock
from .live import EventBus, LiveBridge, LiveLifecycleEvent, PulseClient
from .live.client_api import LiveClientPoller
from .live.metrics import PeriodicMetricsLogger
from .live.types import _unique_player_name_match
from .live.obs_client import ObsAuthFailed, ObsClient
from .live.obs_scene import DEFAULT_SCENE_MAP, ObsSceneController
from .live.transport import (
    CloudTransport,
    FanOutTransport,
    OverlayBackendTransport,
)
from .pairing import ensure_paired
from .pairing.flow import PairingControls
from .pairing.recovery import RuntimeRecovery
from .errors import classify
from .status_model import StatusFacts, ConnectionFacts, derive_status
from .game_activity import GameActivityGate
from .update_scheduler import UpdateScheduler
from .obs_activity import outputs_active
from .import_controller import ImportController
from .socket_client import SocketClient, make_recompute_handlers
from .bot_lab import BotLabController
from .player_handle import (
    auto_detect_from_replays,
    read_cache as read_player_handle_cache,
    refresh_from_cloud as refresh_player_handle,
    resolve as resolve_player_handle,
    write_cache as write_player_handle_cache,
)
from .replay_finder import (
    detected_replay_folders,
    path_key,
    watched_replay_folders,
)
from .replay_pipeline import probe_analyzer
from .state import AgentState, COMPANION_SKINS, _STATE_SAVE_LOCK, count_synced, load_state, save_state
from .sync_filter import SyncFilter
from .ui import (
    ConsoleUI,
    GuiUI,
    SettingsPayload,
    TrayUI,
    can_use_gui,
    can_use_tray,
)
from .updater import ReleaseInfo, Updater, install_release, update_is_mandatory
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
    # Acquire the process-wide guard before configuring the rotating log
    # or starting any watcher/live services. A manual launch racing the
    # autostart entry must become a cheap no-op, not a second uploader
    # and Live Game Bridge pointed at the same account.
    cfg, _ = _bootstrap(args, configure_logging=False)
    instance_lock = AgentInstanceLock(cfg.state_dir)
    if not instance_lock.acquire():
        if not args.no_gui and can_use_gui():
            from .activation import activate_existing
            if activate_existing(cfg.state_dir):
                return 0
        print(
            "SC2 Tools Agent is already running. Check the system tray.",
            file=sys.stderr,
        )
        return 0

    try:
        return _run_locked_agent(cfg, args, argv)
    finally:
        instance_lock.release()


def _run_locked_agent(
    cfg: AgentConfig,
    args: argparse.Namespace,
    argv: Optional[List[str]],
) -> int:
    """Start agent services after the caller owns the instance lock."""
    log_dir = _configure_logging(cfg)
    init_crash_reporter(release=f"sc2tools-agent@{__version__}")
    log = logging.getLogger("sc2tools_agent")
    log.info(
        "agent_starting version=%s api=%s argv=%s",
        __version__,
        cfg.api_base,
        argv if argv is not None else sys.argv[1:],
    )
    log.info("timebase: real-seconds (fps=22.4)")
    use_gui = (not args.no_gui) and can_use_gui()
    if args.no_gui:
        log.info("gui_disabled_via_flag")
    elif not can_use_gui():
        log.info("gui_unavailable_falling_back_to_tray_console")
    try:
        if use_gui:
            return _run_with_gui(
                cfg,
                log_dir,
                start_minimized=args.start_minimized,
                no_live=args.no_live,
                no_obs=args.no_obs,
            )
        return _run_headless(
            cfg, log_dir, no_live=args.no_live, no_obs=args.no_obs,
        )
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
        "--no-live",
        action="store_true",
        help=(
            "Disable the Live Game Bridge (the LiveClientPoller that "
            "talks to Blizzard's localhost SC2 client API). Off-switch "
            "for diagnostics; the rest of the agent (replay watcher, "
            "uploader, heartbeat, GUI) keeps working unchanged."
        ),
    )
    parser.add_argument(
        "--no-obs",
        action="store_true",
        help=(
            "Disable automatic OBS scene switching for this run, "
            "without clearing the saved Settings. Mirrors --no-live: "
            "an off-switch for diagnostics that leaves the rest of "
            "the agent untouched."
        ),
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"sc2tools-agent {__version__}",
    )
    return parser.parse_args(argv)


def _bootstrap(
    args: argparse.Namespace,
    *,
    configure_logging: bool = True,
) -> tuple:
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
    #
    # Clamp at ``PARSE_CONCURRENCY_USEFUL_MAX`` here so a stale
    # state file from before the v0.5.8 cap was introduced (e.g.
    # the user had cranked the old uncapped slider to 32) doesn't
    # silently spawn 32 workers that mostly idle waiting for
    # uploads to drain. The clamp is intentionally NOT applied to
    # the env var itself further down in load_config — env var is
    # the documented escape hatch for power users on a self-hosted
    # cloud API with a higher rate limit.
    from .config import (
        PARSE_CONCURRENCY_USEFUL_MAX,
        UPLOAD_CONCURRENCY_USEFUL_MAX,
        UPLOAD_BATCH_SIZE_USEFUL_MAX,
    )
    _bootstrap_log = logging.getLogger("sc2tools_agent")
    if (
        state.parse_concurrency_override
        and not os.environ.get("SC2TOOLS_PARSE_CONCURRENCY")
    ):
        clamped = min(
            int(state.parse_concurrency_override),
            PARSE_CONCURRENCY_USEFUL_MAX,
        )
        if clamped != state.parse_concurrency_override:
            # ``log`` isn't module-level in this file; use the same
            # logger name the rest of the agent does so the clamp
            # message lands alongside ``agent_starting`` in agent.log.
            _bootstrap_log.info(
                "parse_concurrency_clamped from=%d to=%d "
                "reason=above_useful_max",
                state.parse_concurrency_override,
                clamped,
            )
        os.environ["SC2TOOLS_PARSE_CONCURRENCY"] = str(clamped)
        needs_reload = True
    # Same promote-to-env path for the v0.5.8 upload-pipeline knobs.
    # The clamp here doesn't apply to the env var if it's already
    # set explicitly — that's the documented escape hatch for
    # power users on a self-hosted cloud API with a higher rate
    # limit. We only clamp the GUI/state value to keep it sane.
    if (
        state.upload_concurrency_override
        and not os.environ.get("SC2TOOLS_UPLOAD_CONCURRENCY")
    ):
        clamped = min(
            int(state.upload_concurrency_override),
            UPLOAD_CONCURRENCY_USEFUL_MAX,
        )
        if clamped != state.upload_concurrency_override:
            _bootstrap_log.info(
                "upload_concurrency_clamped from=%d to=%d "
                "reason=above_useful_max",
                state.upload_concurrency_override,
                clamped,
            )
        os.environ["SC2TOOLS_UPLOAD_CONCURRENCY"] = str(clamped)
        needs_reload = True
    if (
        state.upload_batch_size_override
        and not os.environ.get("SC2TOOLS_UPLOAD_BATCH_SIZE")
    ):
        clamped = min(
            int(state.upload_batch_size_override),
            UPLOAD_BATCH_SIZE_USEFUL_MAX,
        )
        if clamped != state.upload_batch_size_override:
            _bootstrap_log.info(
                "upload_batch_size_clamped from=%d to=%d "
                "reason=above_useful_max",
                state.upload_batch_size_override,
                clamped,
            )
        os.environ["SC2TOOLS_UPLOAD_BATCH_SIZE"] = str(clamped)
        needs_reload = True
    if needs_reload:
        cfg = load_config()

    if state.start_minimized:
        args.start_minimized = True

    log_dir = (
        _configure_logging(cfg)
        if configure_logging
        else cfg.state_dir / "logs"
    )
    return cfg, log_dir


# ---------------- Execution paths ----------------


def _run_headless(
    cfg: AgentConfig,
    log_dir: Path,
    *,
    no_live: bool = False,
    no_obs: bool = False,
) -> int:
    """Legacy path - console + tray. Identical to the 0.2.x runner."""
    log = logging.getLogger("sc2tools_agent")
    state = load_state(cfg.state_dir)
    api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)

    recovery_cell = _RuntimeCell()
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
    live_poller: Optional[LiveClientPoller] = None
    live_bus: Optional[EventBus[LiveLifecycleEvent]] = None
    live_bridge: Optional[LiveBridge] = None
    obs_client: Optional[ObsClient] = None
    obs_scene: Optional[ObsSceneController] = None

    if can_use_tray():
        tray = TrayUI(
            initial_paused=state.paused, initial_paused_until=state.paused_until,
            dashboard_url=_dashboard_url_from_api(cfg.api_base),
            log_dir=log_dir,
            replay_folders=initial_replay_folders,
            on_pause=lambda paused: _handle_pause(cfg, state, upload, paused, ui=ui),
            on_pause_for=lambda until: _handle_pause(cfg, state, upload, True, ui=ui, until=until),
            on_resync=lambda: _request_desktop_resync(cfg, state, recovery_cell),
            on_choose_folder=lambda picked: _handle_choose_folder(
                cfg, state, picked, tray, log, upload=upload,
            ),
            on_check_updates=lambda: _check_updates_with_notice(recovery_cell),
            on_install_update=lambda: recovery_cell.update_scheduler.tick(explicit=True) if recovery_cell.update_scheduler else None,
            # No GUI in this mode — the tray omits its window item.
            synced_count_provider=lambda: count_synced(state),
        )

    ui = _Multiplexer(console, tray, facts=StatusFacts(paired=state.is_paired,
        paused=state.paused,folders=list(initial_replay_folders)))
    ui.on_paused(state.paused, state.paused_until)
    _start_pause_expiry(cfg, state, lambda: upload, lambda: ui, stop_event)
    log.info("agent_ui_ready tray=%s log_dir=%s", bool(tray), log_dir)

    if tray:
        tray.start(on_quit=request_stop)

    ui.on_status("connecting...")

    ui.on_phase("connecting")

    if not state.is_paired:
        ui.on_status("waiting for pairing")
        ui.on_phase("waiting_pairing")
        paired = ensure_paired(
            cfg=cfg,
            state=state,
            api=api,
            on_code=ui.show_pairing_code,
            on_state=ui.on_pairing_state,
            stop_event=stop_event,
        )
        if not paired:
            return 0  # ensure_paired returns only when stop was requested.
        api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)
        ui.on_paired(state.user_id or "")

    probe_ok, probe_diag = probe_analyzer()
    ui.on_analyzer_probe(probe_ok, probe_diag)
    if not probe_ok:
        log.error(
            "analyzer_probe_failed_at_startup — replays will not be parsed "
            "until the analyzer can be loaded. Diagnostic: %s",
            probe_diag,
        )

    _ensure_player_handle(api, cfg, state, initial_replay_folders, log)

    # Forward-declared so the upload/watcher callbacks (constructed
    # first) can late-bind it; assigned right after the watcher exists.
    import_ctl: Optional[ImportController] = None

    activity_gate = GameActivityGate(enabled=not no_live)
    recovery_cell.api = api
    recovery = RuntimeRecovery(cell=recovery_cell, cfg=cfg, state=state, ui=ui,
                               stop_event=stop_event)
    recovery_cell.recent_history = _start_desktop_history(cfg, state, ui)
    upload = UploadQueue(
        on_connection_state=ui.on_connection_state,
        on_auth_failure=recovery.watchdog.failure,
        on_auth_success=recovery.watchdog.success,
        cfg=cfg,
        state=state,
        api=api,
        on_success=lambda p: (
            ui.on_upload_success(p.name),
            import_ctl.on_upload_success(p) if import_ctl else None,
        ),
        on_failure=lambda p, exc: _desktop_upload_failed(ui, import_ctl, p, exc),
        on_pending_changed=ui.on_pending,
        on_game_synced=ui.on_game_synced,
    )
    recovery_cell.upload = upload
    upload.set_activity_gate(activity_gate)
    upload.set_paused(state.paused)
    watcher = ReplayWatcher(
        activity_gate=activity_gate,
        cfg=cfg,
        state=state,
        upload=upload,
        on_capture_notice=lambda message: _notify_replay_capture(
            tray, console, None, message, log,
        ),
        on_replay_skipped=lambda p, reason: _desktop_replay_skipped(ui, import_ctl, p, reason),
        on_roots_changed=ui.on_folders,
    )
    import_ctl = ImportController(
        api=api,
        watcher=watcher,
        full_resync=lambda: _handle_replay_archive_resync(
            cfg, state, upload,
        ),
        list_folders=lambda: [
            str(p) for p in _discover_replay_folders(cfg, state)
        ],
        on_change=ui.on_import_progress,
    )

    recovery_cell.tray, recovery_cell.console, recovery_cell.ui = tray, console, ui
    recovery_cell.update_scheduler = _make_update_scheduler(cfg,state,recovery_cell,activity_gate,
        stop_event,request_stop,log)
    updater = Updater(cfg=cfg,state=state,on_update_available=recovery_cell.update_scheduler.offer,
                      on_check=lambda release: _announce_updated_version(cfg,state,recovery_cell,release))
    recovery_cell.updater = updater
    heartbeat = Heartbeat(api, on_success=recovery.connected,
                          on_failure=recovery.watchdog.failure)
    recovery_cell.watcher = watcher
    recovery_cell.heartbeat = heartbeat
    recovery_cell.import_ctl = import_ctl
    ui._import_ctl = import_ctl
    import_ctl.set_hold(paused=state.paused)

    if state.device_token:
        on_macro, on_opp, on_full_resync = make_recompute_handlers(
            state_dir=cfg.state_dir,
            notify_capture_start=lambda message: _notify_replay_capture(
                tray, console, None, message, log,
            ),
            queue_resync_for_paths=lambda paths: _queue_replays_for_resync(
                state, upload, paths, log, state_dir=cfg.state_dir,
            ),
            # Same semantics as the GUI's Re-sync button: drop the
            # uploaded cursor and have the watcher re-walk every replay
            # folder so spatial extracts (and any other newly-added
            # outputs) get backfilled on a fresh parse.
            full_resync=lambda: _handle_replay_archive_resync(
                cfg, state, upload,
            ),
        )
        socket_client = SocketClient(
            base_url=cfg.api_base,
            device_token=state.device_token,
            on_recompute_games=on_macro,
            on_recompute_opp_build=on_opp,
            on_full_resync=on_full_resync,
            on_import_scan=import_ctl.handle_scan_request,
            on_import_start=import_ctl.handle_start_request,
            on_import_cancel=import_ctl.handle_cancel_request,
            on_import_pick_folder=import_ctl.handle_pick_folder_request,
            on_bot_lab=BotLabController(cfg.state_dir, state).handle,
            overlay_token_provider=lambda token: ApiClient(base_url=cfg.api_base, device_token=token).get_overlay_token(interactive=True),
            session_enabled=state.companion_session_enabled,
        )

    live_transport: Optional[FanOutTransport] = None
    live_metrics_logger: Optional[PeriodicMetricsLogger] = None
    if not no_live:
        (
            live_bus,
            live_poller,
            live_bridge,
            live_transport,
            live_metrics_logger,
        ) = _build_live_bridge(
            user_name_hint=resolve_player_handle(cfg.state_dir),
            state_dir=cfg.state_dir,
            replay_folders=initial_replay_folders,
            log=log,
            api=api,
            device_token=state.device_token,
        )
    else:
        log.info("live_bridge_disabled_via_flag")

    if live_bus is not None:
        live_bus.subscribe(activity_gate.on_event)
    obs_client, obs_scene = _build_obs_switcher(
        state=state, bridge=live_bridge, log=log, no_obs=no_obs,
    )
    stream_service = _build_stream_service(cfg, state, no_obs=no_obs)
    recovery_cell.stream_service = stream_service
    _publish_companion_socket(recovery_cell, state, socket_client)
    recovery_cell.live_transport = live_transport

    try:
        if stream_service:
            stream_service.start()
        upload.start()
        watcher.start()
        # Register the startup sweep as a visible import job when the
        # un-uploaded backlog is large (first run / long offline gap).
        # On a thread: sizing the job walks every replay folder, which
        # can take seconds on multi-thousand-replay libraries, and boot
        # must not wait on it.
        threading.Thread(
            target=import_ctl.maybe_start_auto_backfill,
            name="sc2tools-auto-backfill",
            daemon=True,
        ).start()
        updater.start()
        heartbeat.start()
        if socket_client is not None:
            socket_client.start()
        if live_bridge is not None:
            live_bridge.start()
        if live_poller is not None:
            live_poller.start()
            log.info("live_poller_started base_url=http://localhost:6119")
        if live_metrics_logger is not None:
            live_metrics_logger.start()
        if obs_client is not None:
            obs_client.start()
        if obs_scene is not None:
            obs_scene.start()
        ui.on_status(
            "watching for replays" + (" (paused)" if state.paused else ""),
        )
        threading.Thread(
            target=_surface_replay_archive_prompt,
            args=(api, ui, log),
            name="sc2tools-replay-archive-status",
            daemon=True,
        ).start()
        ui.on_phase("ready")
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
        if stream_service:
            stream_service.close()
        if obs_scene:
            obs_scene.shutdown()
        if obs_client:
            obs_client.shutdown()
        if live_metrics_logger:
            live_metrics_logger.stop()
        if live_poller:
            live_poller.stop()
        if live_bridge:
            live_bridge.stop()
        if live_transport:
            live_transport.shutdown()
        if recovery_cell.socket_client:
            recovery_cell.socket_client.stop()
        if import_ctl:
            import_ctl.stop()
        if heartbeat:
            heartbeat.stop()
        if updater:
            updater.stop()
        if watcher:
            watcher.stop()
        if upload:
            upload.stop()
        if recovery_cell.recent_history:
            recovery_cell.recent_history.close()
        if tray:
            tray.stop()
    return 0


def _run_with_gui(
    cfg: AgentConfig, log_dir: Path, *, start_minimized: bool,
    no_live: bool = False,
    no_obs: bool = False,
) -> int:
    """GUI path - Qt main loop on the main thread, agent on a worker."""
    log = logging.getLogger("sc2tools_agent")
    state = load_state(cfg.state_dir)
    initial_folders = _discover_replay_folders(cfg, state)

    cell = _RuntimeCell()
    # ``--no-obs`` is an authoritative runtime prohibition, including GUI
    # settings changes that arrive after the boot worker has started.
    cell.no_obs = bool(no_obs)
    stream_service = _build_stream_service(cfg, state, no_obs=no_obs)
    cell.stream_service = stream_service
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
        background_import_speed=state.background_import_speed,
        pause_history_in_game=state.pause_history_in_game,
        pause_on_battery=state.pause_on_battery,
        api_base=state.api_base_override,
        log_level=state.log_level_override or "INFO",
        # The watched list, detected folders included: Save stores it as
        # additions and exclusions, so showing only the saved additions
        # would hide the detected folders from the user.
        replay_folders=list(dict.fromkeys([*initial_folders,*map(Path,state.replay_folders_override)])),
        autostart_enabled=autostart.is_enabled(),
        start_minimized=state.start_minimized,
        notify_every_game=state.notify_every_game,
        # Surface the cached handle (cloud profile or prior auto-detect)
        # so the user sees what the agent will use when no override is
        # set. Empty when nothing has been resolved yet — the placeholder
        # text in the input field tells them the implications.
        player_handle=read_player_handle_cache(cfg.state_dir) or "",
        # Show the EFFECTIVE concurrency the watcher will use this run,
        # which is the override-if-set otherwise the config default.
        # cfg.* already incorporates env vars + state via _bootstrap,
        # so it's the single source of truth for what the agent will
        # actually do this run.
        parse_concurrency=cfg.parse_concurrency,
        upload_concurrency=cfg.upload_concurrency,
        upload_batch_size=cfg.upload_batch_size,
        # Date-range filter — surface what the watcher will gate on so
        # the user sees their previously-saved filter immediately on
        # open. None / "all" means "no filter".
        sync_filter_preset=state.sync_filter_preset,
        sync_filter_since=state.sync_filter_since,
        sync_filter_until=state.sync_filter_until,
        auto_update_enabled=state.auto_update_enabled,
        replay_capture_enabled=state.replay_capture_enabled,
        obs_scene_switch_enabled=state.obs_scene_switch_enabled,
        obs_host=state.obs_host,
        obs_port=state.obs_port,
        obs_password=state.obs_password,
        obs_scene_map=dict(state.obs_scene_map),
        obs_switch_debounce_sec=state.obs_switch_debounce_sec,
        obs_switch_on_replays=state.obs_switch_on_replays,
    )

    from .companion import CompanionClient

    def save_companion_preferences(preferences):
        previous = state.companion_preferences
        state.companion_preferences = dict(preferences)
        try:
            save_state(cfg.state_dir, state)
        except OSError:
            state.companion_preferences = previous
            raise

    def save_companion_modes(modes):
        previous = state.companion_modes
        state.companion_modes = dict(modes)
        try:
            save_state(cfg.state_dir, state)
        except OSError:
            state.companion_modes = previous
            raise

    companion = CompanionClient(
        lambda: (cfg.api_base, state.device_token),
        preferences_provider=lambda: state.companion_preferences,
        save_preferences=save_companion_preferences,
        modes_provider=lambda: state.companion_modes,
        save_modes=save_companion_modes,
        session_provider=lambda: cell.socket_client.session_snapshot() if cell.socket_client else None,
        session_settings_provider=lambda: state.companion_session_enabled,
        save_session_settings=lambda enabled: _set_companion_session(cfg.state_dir, state, cell, enabled),
    )
    from .companion_ghost import GhostClient

    def save_companion_ghost(preferences):
        previous = state.companion_ghost
        state.companion_ghost = dict(preferences)
        try:
            save_state(cfg.state_dir, state)
        except OSError:
            state.companion_ghost = previous
            raise

    ghost = GhostClient(
        companion._request,
        preferences_provider=lambda: state.companion_ghost,
        save_preferences=save_companion_ghost,
    )

    def companion_action(request):
        if isinstance(request, dict) and str(request.get("action", "")).startswith("ghost_"):
            if request.get("action") == "ghost_local_target":
                from .ghost_replay import load_local_ghost_replay

                return load_local_ghost_replay(request.get("path"))
            result = ghost.action(request)
            if request.get("action") == "ghost_state":
                result["replayFolders"] = [str(folder) for folder in _discover_replay_folders(cfg, state)]
            return result
        return companion.action(request)

    gui = GuiUI(
        on_restore_folders=lambda snapshot: _restore_folder_snapshot(cfg,state,cell,snapshot),
        on_install_update=lambda: cell.update_scheduler.tick(explicit=True) if cell.update_scheduler else None,
        on_update_later=lambda: cell.update_scheduler.later() if cell.update_scheduler else None,
        on_pairing_retry=cell.pairing_controls.retry_now.set,
        on_pairing_refresh=cell.pairing_controls.request_new_code,
        on_link_again=lambda: cell.recovery.link_again() if cell.recovery else None,
        on_sync_retry=lambda: cell.upload.retry_now() if cell.upload else None,
        state_dir=cfg.state_dir,
        initial_tray_hint_shown=state.tray_hint_shown,
        close_without_tray=state.close_without_tray,
        on_tray_hint=lambda: _remember_tray_hint(cfg, state, cell),
        on_close_policy=lambda policy: _remember_close_policy(cfg, state, policy),
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
        # Authoritative synced total for the dashboard stat card —
        # counts dated entries in state.uploaded so the number survives
        # restarts instead of resetting to 0 every launch.
        synced_count_provider=lambda: count_synced(state),
        on_pause=lambda paused: _handle_pause(cfg, state, cell.upload, paused, ui=cell.ui),
        on_resync=lambda: _request_desktop_resync(cfg, state, cell),
        on_choose_folder=lambda picked: _handle_choose_folder_gui(
            cfg, state, picked, cell, log,
        ),
        on_check_updates=lambda: _check_updates_with_notice(cell),
        on_obs_probe=lambda host, port, password: _handle_obs_probe(
            host=host, port=port, password=password, log=log,
        ),
        on_obs_build=lambda request: _handle_obs_build(
            cfg=cfg, state=state, request=request, log=log,
        ),
        stream_status_provider=stream_service.status if stream_service else None,
        on_stream_action=stream_service.action if stream_service else None,
        recent_games_enabled=True,
        on_recent_retry=lambda paths, reason: _retry_desktop_replays(cfg, state, cell, paths, reason, log),
        on_import_current_season=lambda: _handle_save_settings(cfg, state,
            SettingsPayload(sync_filter_preset="current_season", sync_filter_since="", sync_filter_until=""), cell, log),
        on_companion_action=companion_action,
        on_save_settings=lambda payload: _handle_save_settings(
            cfg, state, payload, cell, log,
        ),
        on_quit=request_stop,
        start_minimized=start_minimized,
        window_geometry=state.window_geometry,
        window_information_layout=state.window_information_layout,
        on_window_information_layout=lambda layout: _remember_information_layout(cfg.state_dir, state, layout),
        window_skin=state.companion_skin,
        window_animations=state.companion_animations,
        on_window_appearance=lambda skin, animations: _remember_window_appearance(cfg.state_dir, state, skin, animations),
        window_page=state.window_page,
        on_window_state=lambda geometry, page: _remember_window_state(
            cfg.state_dir, state, geometry, page,
        ),
        # The check-in controller rides on the live bridge.
        build_checkin_available=not no_live,
        build_checkin_positions=dict(state.build_checkin_card_positions),
        build_checkin_preview_race=lambda: state.last_known_race,
        on_build_checkin_reset=lambda: _reset_build_checkin_positions(cfg.state_dir, state),
        on_build_checkin_moved=lambda kind, x, y: _remember_build_checkin_position(
            cfg.state_dir, state, kind, x, y,
        ),
    )
    cell.gui = gui
    _announce_updated_version(cfg,state,cell,None)

    tray: Optional[TrayUI] = None
    if can_use_tray():
        tray = TrayUI(
            initial_paused=state.paused, initial_paused_until=state.paused_until,
            dashboard_url=_dashboard_url_from_api(cfg.api_base),
            log_dir=log_dir,
            replay_folders=initial_folders,
            on_pause=lambda paused: _handle_pause(cfg, state, cell.upload, paused, ui=cell.ui),
            on_pause_for=lambda until: _handle_pause(cfg, state, cell.upload, True, ui=cell.ui, until=until),
            on_resync=gui.request_resync,
            on_choose_folder=lambda _picked: gui.choose_folder(),
            on_check_updates=gui.check_updates,
            on_install_update=lambda: cell.update_scheduler.tick(explicit=True) if cell.update_scheduler else None,
            # Route back to the Qt window after a hide-to-tray close —
            # first menu item and the icon's double-click default.
            on_show_window=lambda: cell.gui.show_window() if cell.gui else None,
            on_build_checkin=lambda: _open_build_checkin(
                cell, _dashboard_url_from_api(cfg.api_base),
            ),
            synced_count_provider=lambda: count_synced(state),
        )
        cell.tray = tray
        tray.start(on_quit=request_stop)

    gui._tray_available = tray is not None

    console = ConsoleUI()
    cell.console = console

    multiplex = _Multiplexer(console, tray, gui)
    cell.ui = multiplex
    active_filter=SyncFilter.from_state(preset=state.sync_filter_preset,since_iso=state.sync_filter_since,until_iso=state.sync_filter_until)
    multiplex.on_filter_label(active_filter.short_label() if active_filter.is_active() else "")
    multiplex.on_paused(state.paused, state.paused_until)
    _start_pause_expiry(cfg, state, lambda: cell.upload, lambda: multiplex, stop_event)
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
            "no_live": no_live,
            "no_obs": no_obs,
        },
        name="sc2tools-boot",
        daemon=True,
    )
    worker.start()
    if stream_service:
        stream_service.start()

    rc = gui.run()

    log.info("agent_stopping rc=%s", rc)
    request_stop()
    if stream_service:
        stream_service.close()
    if getattr(cell, "obs_scene", None):
        cell.obs_scene.shutdown()
    if getattr(cell, "obs_client", None):
        cell.obs_client.shutdown()
    if getattr(cell, "live_metrics_logger", None):
        cell.live_metrics_logger.stop()
    if getattr(cell, "build_checkin", None):
        cell.build_checkin.stop()
    if getattr(cell, "live_poller", None):
        cell.live_poller.stop()
    if getattr(cell, "live_bridge", None):
        cell.live_bridge.stop()
    if getattr(cell, "live_transport", None):
        cell.live_transport.shutdown()
    if getattr(cell, "socket_client", None):
        cell.socket_client.stop()
    if getattr(cell, "import_ctl", None):
        cell.import_ctl.stop()
    if cell.heartbeat:
        cell.heartbeat.stop()
    if cell.updater:
        cell.updater.stop()
    if cell.watcher:
        cell.watcher.stop()
    if cell.upload:
        cell.upload.stop()
    if cell.recent_history:
        cell.recent_history.close()
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
    no_live: bool = False,
    no_obs: bool = False,
) -> None:
    """Run the agent's startup sequence outside the Qt thread."""
    try:
        api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)

        ui.on_status("connecting...")

        ui.on_phase("connecting")

        if not state.is_paired:
            ui.on_status("waiting for pairing")
            ui.on_phase("waiting_pairing")
            paired = ensure_paired(
                cfg=cfg,
                state=state,
                api=api,
                on_code=ui.show_pairing_code,
                on_state=ui.on_pairing_state,
                controls=cell.pairing_controls,
                stop_event=stop_event,
            )
            if not paired:
                return  # Pairing stops only when the application stops.
            api = ApiClient(
                base_url=cfg.api_base, device_token=state.device_token,
            )
            ui.on_paired(state.user_id or "")

        probe_ok, probe_diag = probe_analyzer()
        ui.on_analyzer_probe(probe_ok, probe_diag)
        if not probe_ok:
            log.error(
                "analyzer_probe_failed_at_startup — replays will not be "
                "parsed until the analyzer can be loaded. Diagnostic: %s",
                probe_diag,
            )

        folders_for_detect = _discover_replay_folders(cfg, state)
        _ensure_player_handle(api, cfg, state, folders_for_detect, log)

        # Forward-declared so the upload/watcher callbacks (constructed
        # first) can late-bind it; assigned right after the watcher.
        import_ctl: Optional[ImportController] = None

        cell.api = api
        cell.activity_gate = GameActivityGate(enabled=not no_live)
        recovery = RuntimeRecovery(cell=cell, cfg=cfg, state=state, ui=ui,
                                   stop_event=stop_event, controls=cell.pairing_controls)
        cell.recovery = recovery
        cell.recent_history = _start_desktop_history(cfg, state, ui)
        upload = UploadQueue(
            on_connection_state=ui.on_connection_state,
            on_auth_failure=recovery.watchdog.failure,
            on_auth_success=recovery.watchdog.success,
            cfg=cfg,
            state=state,
            api=api,
            on_success=lambda p: (
                ui.on_upload_success(p.name),
                import_ctl.on_upload_success(p) if import_ctl else None,
            ),
            on_failure=lambda p, exc: _desktop_upload_failed(ui, import_ctl, p, exc),
            on_pending_changed=ui.on_pending,
            on_game_synced=ui.on_game_synced,
            # Late-bound: the build check-in starts with the live bridge.
            on_game_accepted=lambda *accepted: _handle_checkin_game_accepted(
                cfg.state_dir, state, cell, *accepted,
            ),
        )
        upload.set_activity_gate(cell.activity_gate)
        upload.set_paused(state.paused)
        watcher = ReplayWatcher(
            activity_gate=cell.activity_gate,
            cfg=cfg,
            state=state,
            upload=upload,
            on_capture_notice=lambda message: _notify_replay_capture(
                cell.tray, cell.console, cell.gui, message, log,
            ),
            on_replay_skipped=lambda p, reason: _desktop_replay_skipped(ui, import_ctl, p, reason),
            on_roots_changed=lambda folders: _show_replay_folders(
                cell, folders,
            ),
        )
        import_ctl = ImportController(
            api=api,
            watcher=watcher,
            full_resync=lambda: _handle_replay_archive_resync(
                cfg, state, upload,
            ),
            list_folders=lambda: [
                str(p) for p in _discover_replay_folders(cfg, state)
            ],
            on_change=ui.on_import_progress,
        )
        def _request_stop_for_update() -> None:
            # GUI mode shuts down by ending the Qt loop; the caller then
            # runs the ordered service teardown (see _run_gui cleanup).
            stop_event.set()
            if cell.gui:
                cell.gui.request_quit()

        cell.update_scheduler = _make_update_scheduler(cfg,state,cell,cell.activity_gate,
            stop_event,_request_stop_for_update,log)
        updater = Updater(cfg=cfg,state=state,on_update_available=cell.update_scheduler.offer,
                          on_check=lambda release: _announce_updated_version(cfg,state,cell,release))
        heartbeat = Heartbeat(api, on_success=recovery.connected,
                              on_failure=recovery.watchdog.failure)

        cell.upload = upload
        cell.watcher = watcher
        cell.updater = updater
        cell.heartbeat = heartbeat
        cell.import_ctl = import_ctl
        ui._import_ctl = import_ctl
        import_ctl.set_hold(paused=state.paused)

        socket_client: Optional[SocketClient] = None
        if state.device_token:
            on_macro, on_opp, on_full_resync = make_recompute_handlers(
                state_dir=cfg.state_dir,
                notify_capture_start=lambda message: _notify_replay_capture(
                    cell.tray, cell.console, cell.gui, message, log,
                ),
                queue_resync_for_paths=lambda paths: _queue_replays_for_resync(
                    state, upload, paths, log, state_dir=cfg.state_dir,
                ),
                full_resync=lambda: _handle_replay_archive_resync(
                    cfg, state, upload,
                ),
            )
            socket_client = SocketClient(
                base_url=cfg.api_base,
                device_token=state.device_token,
                on_recompute_games=on_macro,
                on_recompute_opp_build=on_opp,
                on_full_resync=on_full_resync,
                on_import_scan=import_ctl.handle_scan_request,
                on_import_start=import_ctl.handle_start_request,
                on_import_cancel=import_ctl.handle_cancel_request,
                on_import_pick_folder=import_ctl.handle_pick_folder_request,
                on_bot_lab=BotLabController(cfg.state_dir, state).handle,
                overlay_token_provider=lambda token: ApiClient(base_url=cfg.api_base, device_token=token).get_overlay_token(interactive=True),
                session_enabled=state.companion_session_enabled,
                on_build_intent_changed=lambda ping: (
                    cell.build_checkin.on_intent_changed(ping)
                    if getattr(cell, "build_checkin", None) else None
                ),
                on_scouting_brief=lambda brief: (
                    cell.build_checkin.on_scouting_brief(brief)
                    if getattr(cell, "build_checkin", None) else None
                ),
            )
        _publish_companion_socket(cell, state, socket_client)

        if not no_live:
            (
                live_bus,
                live_poller,
                live_bridge,
                live_transport,
                live_metrics_logger,
            ) = _build_live_bridge(
                user_name_hint=resolve_player_handle(cfg.state_dir),
                state_dir=cfg.state_dir,
                replay_folders=folders_for_detect,
                log=log,
                api=api,
                device_token=state.device_token,
            )
            live_bus.subscribe(cell.activity_gate.on_event)
            cell.live_bus = live_bus
            cell.live_poller = live_poller
            cell.live_bridge = live_bridge
            cell.live_transport = live_transport
            cell.live_metrics_logger = live_metrics_logger
            # Subscribed before the bridge starts so no envelope is missed.
            cell.build_checkin = start_build_checkin(
                api=api,
                bus=live_bridge.bus,
                state=state,
                state_dir=cfg.state_dir,
                dashboard_url=_dashboard_url_from_api(cfg.api_base),
                view=build_checkin_view_for(cell.gui),
            )
        else:
            log.info("live_bridge_disabled_via_flag")
            cell.live_bus = None
            cell.live_poller = None
            cell.live_bridge = None
            cell.live_transport = None
            cell.live_metrics_logger = None
            cell.build_checkin = None

        # Settings remains interactive while this boot worker is starting.
        # Serialize construction with the checkbox's hot-apply path so an
        # enable click cannot create one subscribed controller here and a
        # second one in _apply_obs_settings (leaving the first alive after a
        # later disable). Re-read the persisted gate before leaving the lock to
        # close the inverse race: a disable that landed during construction.
        with cell.obs_lock:
            if cell.obs_scene is None:
                cell.obs_client, cell.obs_scene = _build_obs_switcher(
                    state=state,
                    bridge=cell.live_bridge,
                    log=log,
                    no_obs=no_obs,
                )
            if cell.obs_scene is not None:
                cell.obs_scene.set_config(
                    scene_map=_effective_scene_map(state),
                    enabled=state.obs_scene_switch_enabled,
                    debounce_sec=state.obs_switch_debounce_sec,
                    switch_on_replays=state.obs_switch_on_replays,
                )

        upload.start()
        watcher.start()
        # Register the startup sweep as a visible import job when the
        # un-uploaded backlog is large. Threaded: sizing the job walks
        # every replay folder and boot must not wait on it.
        threading.Thread(
            target=import_ctl.maybe_start_auto_backfill,
            name="sc2tools-auto-backfill",
            daemon=True,
        ).start()
        updater.start()
        heartbeat.start()
        if socket_client is not None:
            socket_client.start()
        if cell.live_bridge is not None:
            cell.live_bridge.start()
        if cell.live_poller is not None:
            cell.live_poller.start()
            log.info("live_poller_started base_url=http://localhost:6119")
        if cell.live_metrics_logger is not None:
            cell.live_metrics_logger.start()
        if cell.obs_client is not None:
            cell.obs_client.start()
        if cell.obs_scene is not None:
            cell.obs_scene.start()
        ui.on_status(
            "watching for replays" + (" (paused)" if state.paused else ""),
        )
        threading.Thread(
            target=_surface_replay_archive_prompt,
            args=(api, ui, log),
            name="sc2tools-replay-archive-status",
            daemon=True,
        ).start()
        ui.on_phase("ready")
        log.info("agent_ready (gui worker) paused=%s", state.paused)
    except Exception as exc:  # noqa: BLE001
        log.exception("agent_boot_worker_failed")
        ui.on_phase("boot_error", str(exc))
        ui.on_status(f"error: {exc}")
        capture_exception(exc)


# ---------------- callbacks ----------------


def _start_pause_expiry(cfg, state, get_upload, get_ui, stop_event):
    def run():
        refresh_at=time.monotonic()+30
        while not stop_event.wait(1):
            if time.monotonic() >= refresh_at:
                get_ui().refresh_status()
                refresh_at=time.monotonic()+30
            if state.paused and state.paused_until and state.paused_until <= time.time():
                _handle_pause(cfg, state, get_upload(), False, ui=get_ui())
    thread = threading.Thread(target=run, name="sc2tools-pause-expiry", daemon=True)
    thread.start()
    return thread


def _remember_tray_hint(cfg, state, cell):
    state.tray_hint_shown = True
    save_state(cfg.state_dir, state)
    if cell.tray:
        cell.tray.show_notice("SC2 Tools is still running. Right-click the tray icon to quit.")


def _remember_close_policy(cfg, state, policy):
    state.close_without_tray = policy
    save_state(cfg.state_dir, state)


def _handle_pause(
    cfg: AgentConfig,
    state: AgentState,
    upload: Optional[UploadQueue],
    paused: bool,
    *, ui=None, until=None,
) -> None:
    state.paused = paused
    state.paused_until = until if paused else None
    save_state(cfg.state_dir, state)
    if upload:
        upload.set_paused(paused)
    if ui is not None:
        ui.on_paused(paused, state.paused_until)
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


def _start_desktop_history(cfg, state, ui):
    from .companion import CompanionClient
    from .desktop_history import DesktopHistory

    def session():
        with _STATE_SAVE_LOCK:
            return (state.user_id, state.device_token) if state.is_paired else (None, None)

    def connection():
        with _STATE_SAVE_LOCK:
            return cfg.api_base, state.device_token if state.is_paired else None

    def inventory():
        with _STATE_SAVE_LOCK:
            return {"uploaded": state.uploaded.copy(), "paths_by_id": state.path_by_game_id.copy()}

    client = CompanionClient(connection)
    history = DesktopHistory(
        cfg.state_dir,
        owner_provider=lambda: session()[0],
        session_provider=session,
        state_provider=inventory,
        game_reader=lambda game_id: client.action({"action": "game_summary", "gameId": game_id}),
        on_snapshot=ui.on_recent_snapshot,
    )
    ui._recent_history = history
    ui._game_notifications = lambda: state.notify_every_game
    history.start()
    return history


def _desktop_upload_failed(ui, import_ctl, path, exc):
    error = classify(exc)
    ui.on_upload_failed(path.name, error)
    if ui._recent_history:
        ui._recent_history.problem(path, error)
    import_ctl.on_upload_failure(path, exc)


def _desktop_replay_skipped(ui, import_ctl, path, reason):
    if ui._recent_history:
        ui._recent_history.skipped(path, reason or "parse_failed")
    import_ctl.on_replay_skipped(path, reason)


def _request_desktop_resync(cfg, state, cell):
    """The confirmation is on Qt; cursor writes and inventory never are."""
    if not cell.resync_lock.acquire(blocking=False):
        return

    def run():
        try:
            _handle_replay_archive_resync(cfg, state, cell.upload)
            if cell.watcher:
                cell.watcher.request_immediate_sweep()
            if cell.recent_history:
                cell.recent_history.refresh()
            if cell.import_ctl:
                cell.import_ctl.maybe_start_auto_backfill(force_display=True)
        except Exception:
            logging.getLogger(__name__).warning("desktop_resync_failed")
            if cell.ui:
                cell.ui._notice("Could not start Re-sync. Your existing synced games are safe. Try again from Maintenance.")
        finally:
            cell.resync_lock.release()

    threading.Thread(target=run, name="sc2tools-desktop-resync", daemon=False).start()


def _retry_desktop_replays(cfg, state, cell, paths, reason, log):
    """Called by the Recent games action worker, with the active filter intact."""
    if cell.upload is None:
        raise RuntimeError("Replay syncing is still starting. Try again shortly.")
    retried = cell.upload.retry_selected(paths, reason=reason)
    if cell.watcher:
        cell.watcher.request_immediate_sweep()
    if cell.recent_history:
        cell.recent_history.refresh()
    log.info("desktop_replay_retry_requested count=%d", len(retried))
    if cell.ui:
        cell.ui._notice(f"Retry requested for {len(retried):,} replay files. Your saved import date filter still applies.")


def _handle_replay_archive_resync(
    cfg: AgentConfig,
    state: AgentState,
    upload: Optional[UploadQueue],
) -> None:
    """Start a real full sweep, then acknowledge this versioned backfill.

    The local request is made first. The acknowledgement runs off the UI
    thread and only persists server-side when replay storage is enabled; a
    rolling-deploy 404/503 is deliberately a quiet no-op.
    """
    _handle_resync(cfg, state, upload)
    if upload is None:
        logging.getLogger(__name__).info(
            "replay_archive_resync_ack_skipped reason=queue_unavailable",
        )
        return
    if not state.device_token:
        return
    if not _replay_archive_ack_allowed(state):
        logging.getLogger(__name__).info(
            "replay_archive_resync_ack_skipped reason=active_sync_filter",
        )
        return
    api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)

    def _acknowledge() -> None:
        try:
            marked = api.mark_replay_archive_resync_started(
                agent_version=__version__,
            )
            logging.getLogger(__name__).info(
                "replay_archive_resync_acknowledged marked=%s",
                marked,
            )
        except Exception as exc:  # noqa: BLE001
            # The local full sweep is already in motion. A failed optional
            # acknowledgement must not stop uploads; the dashboard can ask
            # again on the next launch.
            logging.getLogger(__name__).warning(
                "replay_archive_resync_ack_failed err=%s",
                exc,
            )

    threading.Thread(
        target=_acknowledge,
        name="sc2tools-replay-archive-ack",
        daemon=True,
    ).start()


def _replay_archive_ack_allowed(state: AgentState) -> bool:
    """Only a running, All-time sweep can satisfy the archive backfill."""
    if state.paused:
        return False
    active_filter = SyncFilter.from_state(
        preset=state.sync_filter_preset,
        since_iso=state.sync_filter_since,
        until_iso=state.sync_filter_until,
    )
    return not active_filter.is_active()


def _surface_replay_archive_prompt(
    api: ApiClient,
    ui: Any,
    log: logging.Logger,
) -> None:
    """Fetch and surface the one-time backfill action without blocking boot."""
    try:
        status = api.get_replay_archive_status()
    except Exception as exc:  # noqa: BLE001
        log.warning("replay_archive_status_failed err=%s", exc)
        return
    if not status or status.get("enabled") is not True:
        return
    if status.get("requiresResync") is not True:
        return
    try:
        missing_games = max(0, int(status.get("missingGames") or 0))
        total_games = max(0, int(status.get("totalGames") or 0))
    except (TypeError, ValueError):
        log.warning("replay_archive_status_invalid payload=%r", status)
        return
    if missing_games <= 0 or total_games <= 0:
        return
    callback = getattr(ui, "on_replay_archive_status", None)
    if callable(callback):
        callback(missing_games, total_games)


def _queue_replays_for_resync(
    state: AgentState,
    upload: Optional[UploadQueue],
    paths: List[Path],
    log: logging.Logger,
    *,
    state_dir: Optional[Path] = None,
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
    if state_dir is not None:
        save_state(state_dir, state)
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
    """Tray / dashboard "Choose replay folder…" — adds one folder.

    The folder joins the detected ones rather than replacing them: the
    list used to start empty in auto mode, so after a restart only the
    picked folder was watched. Picking a detected folder the user had
    removed in Settings watches it again.

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
    key = path_key(picked)
    state.replay_folders_excluded = [
        p for p in state.replay_folders_excluded if path_key(Path(p)) != key
    ]
    detected = {path_key(p) for p in detected_replay_folders(cfg.replay_folder)}
    added = {path_key(Path(p)) for p in state.replay_folders_override}
    if key not in detected and key not in added:
        state.replay_folders_override.append(raw)
    # Keep the legacy single-string field aligned so a downgrade to an
    # older agent build still finds *something* to watch.
    state.replay_folder_override = (
        state.replay_folders_override[0]
        if state.replay_folders_override else None
    )
    save_state(cfg.state_dir, state)
    folders = _discover_replay_folders(cfg, state)
    log.info("replay_folder_added path=%s total=%d", picked, len(folders))
    if tray:
        tray.set_replay_folders(folders)
    if upload:
        upload.request_full_resync()


def _show_replay_folders(cell, folders: List[Path]) -> None:
    """Show the watcher's new folder list in the tray and dashboard."""
    if getattr(cell, "ui", None):
        cell.ui.on_folders(folders)
        return
    if cell.tray:
        cell.tray.set_replay_folders(folders)
    if cell.gui:
        cell.gui.set_replay_folders(folders)


def _folder_snapshot(state):
    return {"added":list(state.replay_folders_override),
            "excluded":list(state.replay_folders_excluded),
            "legacy":state.replay_folder_override}


def _restore_folder_snapshot(cfg,state,cell,snapshot):
    state.replay_folders_override = list(snapshot["added"])
    state.replay_folders_excluded = list(snapshot["excluded"])
    state.replay_folder_override = snapshot["legacy"]
    save_state(cfg.state_dir,state)
    if cell.upload:
        cell.upload.request_full_resync()
    _show_replay_folders(cell,_discover_replay_folders(cfg,state))


def _handle_choose_folder_gui(
    cfg: AgentConfig,
    state: AgentState,
    picked: Optional[Path],
    cell,
    log: logging.Logger,
) -> None:
    """Same as ``_handle_choose_folder`` but updates BOTH tray and GUI."""
    snapshot = _folder_snapshot(state)
    _handle_choose_folder(
        cfg, state, picked, cell.tray, log, upload=cell.upload,
    )
    if picked:
        _show_replay_folders(cell,_discover_replay_folders(cfg,state))
    return snapshot


def _notify_replay_capture(tray, console, gui, message: str, log) -> None:
    """Announce each new engine recording, including while minimised."""
    if gui is not None:
        try:
            gui.show_transient_notice(message)
        except Exception:
            log.exception("replay_capture_gui_notice_failed")
    if tray is not None:
        try:
            tray.show_notice(message, title="Accurate replay capture")
        except Exception:
            log.exception("replay_capture_tray_notice_failed")
    if console is not None:
        try:
            console.on_status(message)
        except Exception:
            log.exception("replay_capture_console_notice_failed")


def _remember_window_state(state_dir, state, geometry, page):
    state.window_geometry = geometry
    state.window_page = page
    save_state(state_dir, state)


def _remember_information_layout(state_dir, state, layout):
    if layout not in {"compact", "standard", "detailed", "full"}:
        return
    previous = state.window_information_layout
    state.window_information_layout = layout
    try:
        save_state(state_dir, state)
    except OSError:
        state.window_information_layout = previous
        raise


def _remember_window_appearance(state_dir, state, skin, animations):
    if not isinstance(skin, str) or skin not in COMPANION_SKINS or type(animations) is not bool:
        raise ValueError("Choose a supported Companion skin and an on/off animation setting.")
    with _STATE_SAVE_LOCK:
        previous = state.companion_skin, state.companion_animations
        state.companion_skin, state.companion_animations = skin, animations
        try:
            save_state(state_dir, state)
        except Exception:
            state.companion_skin, state.companion_animations = previous
            raise


def _remember_companion_session(state_dir, state, enabled):
    if type(enabled) is not bool:
        raise ValueError("Choose an on/off Session panel setting.")
    with _STATE_SAVE_LOCK:
        previous = state.companion_session_enabled
        state.companion_session_enabled = enabled
        try:
            save_state(state_dir, state)
        except Exception:
            state.companion_session_enabled = previous
            raise


def _set_companion_session(state_dir, state, cell, enabled):
    with _STATE_SAVE_LOCK:
        _remember_companion_session(state_dir, state, enabled)
        if cell.socket_client:
            cell.socket_client.set_session_enabled(enabled)


def _publish_companion_socket(cell, state, socket_client):
    with _STATE_SAVE_LOCK:
        cell.socket_client = socket_client
        if socket_client:
            socket_client.set_session_enabled(state.companion_session_enabled)


def _handle_save_settings(
    cfg: AgentConfig,
    state: AgentState,
    payload: SettingsPayload,
    cell,
    log: logging.Logger,
) -> None:
    """Persist Settings-tab edits and apply the registry-side changes."""
    folder_before = _folder_snapshot(state) if payload.replay_folders is not None else None
    if payload.background_import_speed in ("gentle","balanced","maximum"):
        state.background_import_speed = payload.background_import_speed
    if payload.pause_history_in_game is not None:
        state.pause_history_in_game = payload.pause_history_in_game
    if payload.pause_on_battery is not None:
        state.pause_on_battery = payload.pause_on_battery
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
        # Clamp into [1, PARSE_CONCURRENCY_USEFUL_MAX] so a malformed
        # JSON edit can't slip a 0 / negative through, AND so values
        # above the useful ceiling (set when the v0.5.8 cap was
        # introduced) get normalised on save instead of round-
        # tripping through state and back into a misleading runtime
        # config. Stored on state so the next ``_bootstrap`` call
        # promotes it into the env var before AgentConfig reads it.
        from .config import PARSE_CONCURRENCY_USEFUL_MAX
        n = int(payload.parse_concurrency)
        state.parse_concurrency_override = max(
            1, min(PARSE_CONCURRENCY_USEFUL_MAX, n),
        )
    if payload.upload_concurrency is not None:
        # Same clamp-on-save rationale as parse_concurrency above.
        from .config import UPLOAD_CONCURRENCY_USEFUL_MAX
        n = int(payload.upload_concurrency)
        clamped_upload_conc = max(
            1, min(UPLOAD_CONCURRENCY_USEFUL_MAX, n),
        )
        state.upload_concurrency_override = clamped_upload_conc
        # Hot-swap the live upload queue so the user's button-group
        # click takes effect immediately. ``set_concurrency`` is
        # idempotent when the count already matches (so a re-click
        # of the already-selected button is cheap), and stops/starts
        # workers cleanly without losing in-flight jobs. ``cell.upload``
        # is the runtime ``UploadQueue`` instance; in unit tests it
        # may be a stub without ``set_concurrency`` — guard with
        # ``hasattr`` so those tests don't have to mock it.
        live_upload = getattr(cell, "upload", None)
        if live_upload is not None and hasattr(live_upload, "set_concurrency"):
            try:
                live_upload.set_concurrency(clamped_upload_conc)
            except Exception:
                log.exception("upload_concurrency_hotswap_failed")
    if payload.upload_batch_size is not None:
        from .config import UPLOAD_BATCH_SIZE_USEFUL_MAX
        n = int(payload.upload_batch_size)
        clamped_upload_batch = max(
            1, min(UPLOAD_BATCH_SIZE_USEFUL_MAX, n),
        )
        state.upload_batch_size_override = clamped_upload_batch
        # Hot-swap the live upload queue's per-batch ceiling. Workers
        # read ``self._cfg.upload_batch_size`` once at the top of
        # ``_run`` so we mutate the cfg in place via ``replace``.
        live_upload = getattr(cell, "upload", None)
        if live_upload is not None and hasattr(live_upload, "set_batch_size"):
            try:
                live_upload.set_batch_size(clamped_upload_batch)
            except Exception:
                log.exception("upload_batch_size_hotswap_failed")
    filter_changed = False
    if payload.sync_filter_preset is not None:
        # Date-range filter. The watcher resolves this fresh every
        # sweep, but we ALSO trigger an immediate sweep + drain the
        # already-queued uploads below if the value actually changed,
        # so the user's "save = stop uploading right now" mental
        # model is true to the millisecond rather than waiting for
        # the next 10-second poll.
        new_preset = payload.sync_filter_preset.strip() or None
        new_since = (payload.sync_filter_since or "").strip() or None
        new_until = (payload.sync_filter_until or "").strip() or None
        # Treat "all" the same as None — the filter is fully open.
        if new_preset == "all":
            new_preset = None
            new_since = None
            new_until = None
        if (
            new_preset != state.sync_filter_preset
            or new_since != state.sync_filter_since
            or new_until != state.sync_filter_until
        ):
            filter_changed = True
            state.sync_filter_preset = new_preset
            state.sync_filter_since = new_since
            state.sync_filter_until = new_until
    folders_changed = payload.replay_folders is not None
    if folders_changed:
        cleaned: list[str] = []
        seen: set[str] = set()
        for entry in payload.replay_folders:
            raw = str(entry).strip()
            if not raw or raw in seen:
                continue
            seen.add(raw)
            cleaned.append(raw)
        removed = [
            str(entry).strip()
            for entry in (payload.replay_folders_removed or [])
            if str(entry).strip()
        ]
        _apply_saved_replay_folders(cfg, state, cleaned, removed)
    if payload.start_minimized is not None:
        state.start_minimized = bool(payload.start_minimized)
    if payload.notify_every_game is not None:
        state.notify_every_game = payload.notify_every_game is True
    if payload.auto_update_enabled is not None:
        # Hot-applies: the updater reads this flag from state on every
        # poll (``_handle_update_available``'s consent gate), so no
        # restart is needed for the opt-in/opt-out to take effect.
        state.auto_update_enabled = bool(payload.auto_update_enabled)
    _apply_obs_settings(state, payload, cell, log)
    if payload.autostart_enabled is not None:
        ok = autostart.set_enabled(bool(payload.autostart_enabled))
        if ok:
            state.autostart_enabled = bool(payload.autostart_enabled)
        else:
            log.warning(
                "autostart_toggle_unsupported_or_failed enabled=%s",
                payload.autostart_enabled,
            )

    # Filter enforcement happens BEFORE ``save_state`` so the on-disk
    # state matches the in-memory state after a Save click — without
    # this, the agent's previous behaviour persisted the new filter
    # but kept the old "filtered" markers, so an agent restart would
    # reload them and never re-evaluate against the new window.
    filter_apply_summary: Optional[dict] = None
    resync_already_requested = False
    if filter_changed:
        new_filter = SyncFilter.from_state(
            preset=state.sync_filter_preset,
            since_iso=state.sync_filter_since,
            until_iso=state.sync_filter_until,
        )
        # Step 1: drop "filtered" markers from the previous filter so
        # the next sweep re-evaluates those replays against the new
        # window. Don't touch "skipped" / "rejected" / real timestamp
        # values — those are durable outcomes the filter change has
        # no bearing on.
        cleared_filtered = 0
        for path_key in list(state.uploaded.keys()):
            if state.uploaded.get(path_key) == "filtered":
                del state.uploaded[path_key]
                cleared_filtered += 1
        # Step 2: drain the upload queue's already-parsed jobs that
        # fall outside the new window. This is what stops the "I
        # clicked Save and it kept uploading" complaint — without
        # this, a queue depth of 5–100 would keep flying out for ~30
        # seconds after the Save click before the watcher's filter
        # caught up.
        dropped_queued = 0
        if cell.upload is not None and hasattr(
            cell.upload, "drain_outside_filter",
        ):
            try:
                dropped_queued = cell.upload.drain_outside_filter()
            except Exception:  # noqa: BLE001
                log.exception("drain_outside_filter_failed")
        # Step 3: trigger an immediate watcher sweep so newly-eligible
        # replays (the cleared "filtered" set) get picked up without
        # waiting for the 10-second poll. ``request_full_resync`` is
        # the existing flag the watcher reads at the top of
        # ``_sweep_once``; always trigger on filter change, regardless
        # of how many entries we cleared (otherwise a Save with zero
        # cleared entries — typical when transitioning from "all" to
        # "Current season" on a fresh-ish state — never wakes the
        # watcher and the user waits the full poll interval).
        if cell.upload is not None:
            cell.upload.request_full_resync()
            resync_already_requested = True
        if cell.watcher is not None and hasattr(
            cell.watcher, "request_immediate_sweep",
        ):
            try:
                cell.watcher.request_immediate_sweep()
            except Exception:  # noqa: BLE001
                log.exception("request_immediate_sweep_failed")
        filter_apply_summary = {
            "cleared_filtered": cleared_filtered,
            "dropped_queued": dropped_queued,
            "active": int(new_filter.is_active()),
        }
        log.info(
            "sync_filter_changed preset=%s since=%s until=%s "
            "cleared=%d dropped_queued=%d",
            state.sync_filter_preset, state.sync_filter_since,
            state.sync_filter_until, cleared_filtered, dropped_queued,
        )

    # ATOMIC: every in-memory mutation for this user action is now
    # complete. A single ``save_state`` commits the whole thing.
    previous_capture_enabled = state.replay_capture_enabled
    if payload.replay_capture_enabled is not None:
        state.replay_capture_enabled = payload.replay_capture_enabled is True
    try:
        save_state(cfg.state_dir, state)
    except Exception:
        # A failed opt-in save must not leave the running agent enabled.
        state.replay_capture_enabled = previous_capture_enabled
        raise

    if folders_changed:
        folders = _discover_replay_folders(cfg, state)
        if cell.tray:
            cell.tray.set_replay_folders(folders)
        if cell.gui:
            cell.gui.set_replay_folders(folders)
        # Force the live watcher to rediscover roots on its next
        # sweep so the new list takes effect without a restart. Skip
        # if the filter branch above already requested it — the
        # watcher only honours one resync per sweep cycle anyway and
        # double-calling does no harm, but it logs noisily.
        if cell.upload and not resync_already_requested:
            cell.upload.request_full_resync()

    # Surface the apply summary in the GUI's settings status bar so
    # the user gets confirmation that the filter actually took effect
    # — and how many in-flight uploads were dropped because of it.
    status_msg = "Saved."
    if filter_changed and filter_apply_summary is not None:
        n_drop = filter_apply_summary["dropped_queued"]
        n_clear = filter_apply_summary["cleared_filtered"]
        preset_label = SyncFilter.from_state(
            preset=state.sync_filter_preset,
            since_iso=state.sync_filter_since,
            until_iso=state.sync_filter_until,
        ).short_label()
        bits = [f"Syncing {preset_label}" + (" only" if preset_label != "All time" else "")]
        if n_drop > 0:
            bits.append(
                f"{n_drop} queued upload"
                f"{'s' if n_drop != 1 else ''} skipped",
            )
        if n_clear > 0:
            bits.append(
                f"{n_clear} older replay"
                f"{'s' if n_clear != 1 else ''} will sync again",
            )
        status_msg = "Saved. " + "; ".join(bits) + "."
    if cell.gui is not None and hasattr(cell.gui, "show_settings_status"):
        try:
            cell.gui.show_settings_status(status_msg)
        except Exception:  # noqa: BLE001
            log.exception("show_settings_status_failed")

    if getattr(cell,"ui",None):
        active_filter=SyncFilter.from_state(preset=state.sync_filter_preset,since_iso=state.sync_filter_since,until_iso=state.sync_filter_until)
        cell.ui.on_filter_label(active_filter.short_label() if active_filter.is_active() else "")
    log.info(
        "settings_saved api_base=%s log_level=%s autostart=%s minimised=%s "
        "folders_added=%d folders_excluded=%d filter=%s",
        bool(state.api_base_override),
        state.log_level_override,
        state.autostart_enabled,
        state.start_minimized,
        len(state.replay_folders_override),
        len(state.replay_folders_excluded),
        state.sync_filter_preset or "all",
    )
    return folder_before


def _check_updates_with_notice(cell):
    release=cell.updater.check_now() if cell.updater else None
    if cell.tray:
        message="Update check failed. Open the activity log for details."
        if release:
            message=f"Version {release.latest} is ready." if release.update_available else "SC2 Tools is up to date."
        cell.tray.show_notice(message)
    return release


def _make_update_scheduler(cfg,state,cell,gate,stop_event,request_stop,log):
    def install(release):
        if not _running_frozen():
            raise RuntimeError("Use Download installer to update this source install.")
        host=urllib.parse.urlparse(cfg.api_base).hostname
        install_release(release,trusted_hosts=[host] if host else [])
        request_stop()
    def notify(release,phase,detail):
        if getattr(cell,"ui",None):
            cell.ui.on_update_available(release.latest)
        if cell.gui:
            cell.gui.show_update_state(release,phase,detail)
        if phase=="failed":
            log.warning("update_install_failed: %s",detail)
    scheduler=UpdateScheduler(gate=gate,state=state,state_dir=cfg.state_dir,
        install=install,notify=notify,automatic_allowed=_running_frozen,
        streaming=lambda: outputs_active(getattr(getattr(cell,"stream_service",None),"reader",None)),
        capturing=lambda: _capture_running(cell))
    scheduler.start(stop_event)
    return scheduler


def _capture_running(cell):
    from .socket_client import _ENGINE_REBUILD_LOCK
    return _ENGINE_REBUILD_LOCK.locked() or bool(cell.watcher and cell.watcher.capture_running)


def _announce_updated_version(cfg,state,cell,release):
    if release is not None:
        if cell.gui:
            cell.gui.show_site_notice(release.notice)
        if cell.tray:
            cell.tray.on_site_notice(release.notice)
    if state.last_run_version != __version__:
        state.last_run_version = __version__
        save_state(cfg.state_dir,state)
        if cell.gui:
            cell.gui.show_transient_notice(f"Updated to v{__version__}")
    if cell.gui:
        notes = release.release_notes if release else ""
        if not notes:
            from .release_notes import bundled_notes
            notes = bundled_notes()
        cell.gui.set_release_notes(notes)


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

    The list is every detected folder (or the ``SC2TOOLS_REPLAY_FOLDER``
    env override, used by tests and headless runs), minus the detected
    folders the user removed in Settings, plus the folders they added.
    Until 0.17.6 a saved list replaced detection entirely, so a toon
    folder created later (a first PTR game's) was never watched.
    """
    return watched_replay_folders(
        added=state.replay_folders_override,
        excluded=state.replay_folders_excluded,
        env_folder=cfg.replay_folder,
    )


def _apply_saved_replay_folders(
    cfg: AgentConfig,
    state: AgentState,
    listed: List[str],
    removed: List[str],
) -> None:
    """Store the Settings folder list as additions and exclusions.

    Detected folders are always watched, so the list itself is not stored:
    that replaced detection, and a folder SC2 created after the Save was
    never watched. A detected folder only becomes an exclusion when the
    user removed it from the list (``removed``); one that appeared after
    Settings opened is simply absent from ``listed`` and stays watched.
    An empty list resets the agent to detection alone.
    """
    if not listed and not removed:
        state.replay_folders_override = []
        state.replay_folders_excluded = []
        state.replay_folder_override = None
        return
    detected = {path_key(p) for p in detected_replay_folders(cfg.replay_folder)}
    listed_keys = {path_key(Path(raw)) for raw in listed}
    previously_added = {
        path_key(Path(raw)) for raw in state.replay_folders_override
    }
    state.replay_folders_override = [
        raw for raw in listed if path_key(Path(raw)) not in detected
    ]
    excluded: List[str] = []
    seen: set[str] = set()
    for raw in [*state.replay_folders_excluded, *removed]:
        key = path_key(Path(raw))
        if key in seen or key in listed_keys:
            continue
        # Removing a folder the user added themselves just drops it.
        if key in previously_added and key not in detected:
            continue
        seen.add(key)
        excluded.append(raw)
    state.replay_folders_excluded = excluded
    # Kept for a downgrade: pre-0.17.6 builds read it as "the" folder.
    state.replay_folder_override = (
        state.replay_folders_override[0]
        if state.replay_folders_override else None
    )


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


def _open_build_checkin(cell: "_RuntimeCell", dashboard_url: str) -> None:
    """Tray "Build check-in…": the newest unanswered end card, or the
    web queue when this session has no check-in controller."""
    controller = getattr(cell, "build_checkin", None)
    if controller is not None:
        controller.reopen()
        return
    webbrowser.open(web_queue_url(dashboard_url), new=2)


def _reset_build_checkin_positions(state_dir: Path, state: AgentState) -> None:
    state.build_checkin_card_positions = {}
    def save() -> None:
        try:
            save_state(state_dir, state)
        except OSError:
            logging.getLogger("sc2tools_agent").warning("build_checkin_position_reset_failed", exc_info=True)
    threading.Thread(target=save, name="sc2tools-checkin-reset", daemon=True).start()


_CHECKIN_PREVIEW_RACE_LOCK = threading.Lock()


def _handle_checkin_game_accepted(state_dir: Path, state: AgentState, cell: Any, path: Any, game: Any, *accepted: Any) -> None:
    """Remember the latest replay race on the upload worker, not Qt/controller."""
    from datetime import datetime, timezone
    from .build_checkin.models import canonical_race
    def timestamp(raw):
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
        except (ValueError, TypeError, AttributeError):
            return None
    race = canonical_race(getattr(game, "my_race", None))
    played = getattr(game, "date_iso", None)
    with _CHECKIN_PREVIEW_RACE_LOCK:
        instant, previous = timestamp(played), timestamp(state.last_known_race_at)
        if race in ("Protoss", "Terran", "Zerg") and instant is not None and (previous is None or instant > previous):
            state.last_known_race, state.last_known_race_at = race, played
            try:
                save_state(state_dir, state)
            except OSError:
                logging.getLogger("sc2tools_agent").warning("checkin_preview_race_save_failed")
    controller = getattr(cell, "build_checkin", None)
    if controller is not None:
        controller.on_game_accepted(path, game, *accepted)


def _remember_build_checkin_position(
    state_dir: Path,
    state: AgentState,
    kind: str,
    x: int,
    y: int,
) -> None:
    """Persist where the player dragged a check-in card (GUI thread).

    The write runs on a short-lived thread so a large ``agent.json``
    never stalls the window that is being dragged.
    """
    positions = dict(state.build_checkin_card_positions)
    positions[kind] = [int(x), int(y)]
    state.build_checkin_card_positions = positions

    def save() -> None:
        try:
            save_state(state_dir, state)
        except OSError:
            logging.getLogger("sc2tools_agent").warning(
                "build_checkin_position_save_failed", exc_info=True,
            )

    threading.Thread(
        target=save, name="sc2tools-checkin-position", daemon=True,
    ).start()


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
    obs_sdk = logging.getLogger("obsws_python")
    obs_sdk.handlers.clear()
    obs_sdk.addHandler(logging.NullHandler())
    obs_sdk.propagate = False
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
    _prune_worker_logs(log_dir)
    return log_dir


def _prune_worker_logs(log_dir: Path) -> None:
    """Delete parse-worker log files left behind by previous sessions.

    Workers write per-process ``agent-worker-<pid>.log`` files (see
    watcher._install_worker_log_handler) so the parent's agent.log can
    always rotate. The PIDs change every session, so without this sweep
    the logs directory would accumulate a few small files per run
    forever. Files from THIS session aren't open yet at logging-setup
    time, so deleting everything matching the pattern is safe; a file
    that's somehow still locked is skipped silently.
    """
    try:
        candidates = list(log_dir.glob("agent-worker-*.log*"))
    except OSError:
        return
    for path in candidates:
        try:
            path.unlink()
        except OSError:
            continue


def _log_level_from_env() -> int:
    raw = os.environ.get("SC2TOOLS_LOG_LEVEL", "INFO").upper()
    return getattr(logging, raw, logging.INFO)


def _running_frozen() -> bool:
    return getattr(sys, "frozen", False) is True


def _build_live_bridge(
    *,
    user_name_hint: Optional[str],
    log: logging.Logger,
    api: Optional[ApiClient] = None,
    overlay_base_url: Optional[str] = None,
    device_token: Optional[str] = None,
    state_dir: Optional[Path] = None,
    replay_folders: Optional[List[Path]] = None,
) -> tuple[
    EventBus[LiveLifecycleEvent],
    LiveClientPoller,
    LiveBridge,
    Optional[FanOutTransport],
    PeriodicMetricsLogger,
]:
    """Construct the Live Game Bridge stack: lifecycle bus + poller +
    bridge (which fuses with Pulse and emits enriched envelopes on its
    own output bus).

    Default transports
    ------------------

    Cloud-only by default. The agent POSTs every envelope to
    ``/v1/agent/live`` and the cloud's ``LiveGameBroker`` fans it out
    to (a) every ``overlay:<token>`` Socket.io room belonging to this
    user — driving the OBS Browser Source widgets at
    ``sc2tools.com/overlay/<token>/widget/<name>`` — and (b) the
    user's web tabs via the ``GET /v1/me/live`` SSE stream.

    The legacy "local overlay backend" path (POST to
    ``http://localhost:3000/api/agent/live``) is preserved for the
    self-hosted ``reveal-sc2-opponent-main/stream-overlay-backend``
    product but is OFF by default. Set the
    ``SC2TOOLS_LOCAL_OVERLAY_URL`` env var (or pass an explicit
    ``overlay_base_url``) to enable it. With nothing set the agent
    sends zero traffic to localhost:3000 — the default install ships
    pure cloud.

    Logging
    -------

    The structured-log subscriber sits on the bridge's output bus so
    operators see one grep-friendly line per emitted envelope (with
    Pulse enrichment) rather than per raw lifecycle event.
    """
    if state_dir is not None:
        user_name_hint = resolve_player_handle(state_dir)
    replay_name_hint: Optional[str] = None
    if replay_folders:
        try:
            # Cloud BattleTags can differ from the regional SC2 character
            # name. Recover that local name once before polling starts;
            # scanning/parsing a replay must not block each live event.
            replay_name_hint = auto_detect_from_replays(replay_folders)
        except Exception:  # noqa: BLE001
            log.exception("live_player_name_auto_detect_failed")
    lifecycle_bus: EventBus[LiveLifecycleEvent] = EventBus()
    pulse = PulseClient()
    bridge = LiveBridge(
        lifecycle_bus=lifecycle_bus,
        pulse=pulse,
        user_name_hint=user_name_hint,
    )

    def _log_subscriber(payload: dict) -> None:
        opp = payload.get("opponent") or {}
        profile = opp.get("profile") or {}
        log.info(
            "live_emit phase=%s game_key=%s opp=%s race=%s "
            "mmr=%s region=%s confidence=%s",
            payload.get("phase", "-"),
            payload.get("gameKey", "-"),
            opp.get("name") or "-",
            opp.get("race") or "-",
            profile.get("mmr") if profile else "-",
            profile.get("region") if profile else "-",
            profile.get("confidence") if profile else "-",
        )

    bridge.bus.subscribe(_log_subscriber)

    # Resolve the legacy local-overlay URL: explicit arg wins, then
    # env var, then nothing (cloud-only — the supported default).
    effective_overlay_url = overlay_base_url
    if not effective_overlay_url:
        env_url = os.environ.get("SC2TOOLS_LOCAL_OVERLAY_URL", "").strip()
        if env_url:
            effective_overlay_url = env_url

    # Wire transports onto the bridge's output bus. Each transport
    # runs independently — failure of one (overlay backend down,
    # cloud unreachable) does not block the other from broadcasting.
    transports: list = []
    if api is not None and device_token:
        transports.append(CloudTransport(api_client=api))
    if effective_overlay_url:
        transports.append(
            OverlayBackendTransport(
                base_url=effective_overlay_url,
                device_token=device_token,
            ),
        )
        log.info(
            "live_transport_local_overlay_enabled url=%s",
            effective_overlay_url,
        )
    else:
        log.info("live_transport_cloud_only=true")
    fanout: Optional[FanOutTransport] = None
    if transports:
        fanout = FanOutTransport(*transports)
        bridge.bus.subscribe(fanout.listener)

    poller = LiveClientPoller(
        bus=lifecycle_bus, user_name_hint=user_name_hint,
    )
    if state_dir is not None or replay_name_hint:
        def _refresh_player_identity(event: LiveLifecycleEvent) -> None:
            # Replay parsing can repair a stale profile name, and Settings
            # can replace or clear it while this stack is running. Register
            # before bridge.start() so this event uses the latest identity.
            name = (
                resolve_player_handle(state_dir)
                if state_dir is not None else user_name_hint
            )
            if replay_name_hint and event.game_state is not None:
                humans = [
                    player for player in event.game_state.players
                    if player.is_user
                ]
                if (
                    len(humans) == 2
                    and _unique_player_name_match(humans, name) is None
                ):
                    matched = _unique_player_name_match(humans, replay_name_hint)
                    if matched is not None:
                        name = matched.name
            poller.set_user_name_hint(name)
            bridge.set_user_name_hint(name)

        lifecycle_bus.subscribe(_refresh_player_identity)
    metrics_logger = PeriodicMetricsLogger()
    return lifecycle_bus, poller, bridge, fanout, metrics_logger


def _effective_scene_map(state: AgentState) -> Dict[str, str]:
    """The phase → scene map the switcher should actually run.

    The GUI's Save always writes all six phase keys, so a user who
    ticked the enable box without touching the dropdowns persists a
    map of six empty strings. To the controller that is "configured:
    never switch anything" — the whole feature silently does nothing
    while the checkbox says on. A map with no real value in it is
    indistinguishable from "never configured", so treat it the same
    way ``AgentState.obs_scene_map`` documents the empty dict: use the
    defaults. A map with at least one non-blank value is honoured
    verbatim, blanks included — those are deliberate per-phase
    "don't switch" choices.
    """
    stored = dict(state.obs_scene_map)
    if any(v.strip() for v in stored.values()):
        return stored
    return dict(DEFAULT_SCENE_MAP)


def _apply_obs_settings(
    state: AgentState,
    payload: SettingsPayload,
    cell,
    log: logging.Logger,
) -> None:
    """Serialize OBS settings with the GUI boot worker's construction path."""
    obs_lock = getattr(cell, "obs_lock", None)
    if obs_lock is None:
        _apply_obs_settings_unlocked(state, payload, cell, log)
        return
    with obs_lock:
        _apply_obs_settings_unlocked(state, payload, cell, log)


def _apply_obs_settings_unlocked(
    state: AgentState,
    payload: SettingsPayload,
    cell,
    log: logging.Logger,
) -> None:
    """Persist the Settings tab's OBS fields and hot-apply them.

    Follows the ``upload.set_concurrency`` precedent: a Save click
    takes effect on the running switcher rather than waiting for a
    restart. Reconnecting is only done when the connection details
    actually changed — a Save that only re-mapped a scene shouldn't
    drop a healthy socket mid-stream.
    """
    previous_obs = {
        "obs_scene_switch_enabled": state.obs_scene_switch_enabled,
        "obs_host": state.obs_host,
        "obs_port": state.obs_port,
        "obs_password": state.obs_password,
        "obs_scene_map": dict(state.obs_scene_map),
        "obs_switch_debounce_sec": state.obs_switch_debounce_sec,
        "obs_switch_on_replays": state.obs_switch_on_replays,
    }
    previous_enabled = bool(state.obs_scene_switch_enabled)
    desired_enabled = (
        bool(payload.obs_scene_switch_enabled)
        if payload.obs_scene_switch_enabled is not None
        else previous_enabled
    )
    master_changed = desired_enabled != previous_enabled
    forced_no_obs = bool(getattr(cell, "no_obs", False))
    if forced_no_obs and master_changed and desired_enabled:
        raise RuntimeError(
            "Could not enable automatic OBS scene switching while "
            "--no-obs is active",
        )

    def restore_previous_obs_state() -> None:
        for field_name, value in previous_obs.items():
            setattr(
                state,
                field_name,
                dict(value) if field_name == "obs_scene_map" else value,
            )

    conn_changed = False
    if payload.obs_host is not None and payload.obs_host != state.obs_host:
        state.obs_host = payload.obs_host
        conn_changed = True
    if payload.obs_port is not None and int(payload.obs_port) != state.obs_port:
        state.obs_port = int(payload.obs_port)
        conn_changed = True
    if payload.obs_password is not None:
        # Empty string clears a saved password rather than meaning
        # "no change" — otherwise there'd be no way to remove one
        # without hand-editing agent.json.
        new_password = payload.obs_password or None
        if new_password != state.obs_password:
            state.obs_password = new_password
            conn_changed = True
    if payload.obs_scene_map is not None:
        state.obs_scene_map = {
            str(k): str(v) for k, v in dict(payload.obs_scene_map).items()
        }
    if payload.obs_switch_debounce_sec is not None:
        state.obs_switch_debounce_sec = max(
            0.0, float(payload.obs_switch_debounce_sec),
        )
    if payload.obs_switch_on_replays is not None:
        state.obs_switch_on_replays = bool(payload.obs_switch_on_replays)

    controller = getattr(cell, "obs_scene", None)
    client = getattr(cell, "obs_client", None)
    if controller is None:
        # Nothing running yet — the feature was off at boot. If the
        # user just switched it ON, build and start the switcher now:
        # "Save, queue a game, nothing happened" was the old behaviour,
        # because the enable used to silently require an agent restart.
        if not desired_enabled:
            state.obs_scene_switch_enabled = False
            return
        if forced_no_obs:
            # A persisted preference may remain on while this particular run
            # was explicitly launched without OBS. Never let a later Settings
            # save bypass that command-line safety boundary.
            log.info("obs_scene_switch_disabled_via_flag")
            return
        bridge = getattr(cell, "live_bridge", None)
        if bridge is None:
            # --no-live, or the bridge failed to boot: no phase events
            # exist to react to, so a restart (with live enabled) is
            # genuinely required.
            state.obs_scene_switch_enabled = desired_enabled
            log.info("obs_settings_saved_restart_required=true")
            return
        # _build_obs_switcher reads the shared state gate. This assignment is
        # provisional until construction and both runtime starts succeed.
        state.obs_scene_switch_enabled = desired_enabled
        try:
            client, controller = _build_obs_switcher(
                state=state,
                bridge=bridge,
                log=log,
                no_obs=forced_no_obs,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("obs_switcher_late_build_failed")
            if master_changed:
                restore_previous_obs_state()
                raise RuntimeError(
                    "Could not enable automatic OBS scene switching",
                ) from exc
            return
        if controller is None:
            if master_changed:
                restore_previous_obs_state()
                raise RuntimeError(
                    "Could not enable automatic OBS scene switching",
                )
            return
        try:
            if client is not None:
                client.start()
            controller.start()
        except Exception as exc:  # noqa: BLE001
            log.exception("obs_switcher_late_start_failed")
            try:
                controller.set_config(enabled=False)
                controller.shutdown()
            except Exception:  # noqa: BLE001
                log.exception("obs_switcher_late_start_cleanup_failed")
            if client is not None:
                try:
                    client.shutdown()
                except Exception:  # noqa: BLE001
                    log.exception("obs_client_late_start_cleanup_failed")
            if master_changed:
                restore_previous_obs_state()
                raise RuntimeError(
                    "Could not enable automatic OBS scene switching",
                ) from exc
            return
        cell.obs_client = client
        cell.obs_scene = controller
        log.info("obs_scene_switch_started_from_settings")
        return

    try:
        controller.set_config(
            scene_map=_effective_scene_map(state),
            enabled=desired_enabled,
            debounce_sec=state.obs_switch_debounce_sec,
            switch_on_replays=state.obs_switch_on_replays,
        )
    except Exception as exc:  # noqa: BLE001
        log.exception("obs_controller_reconfigure_failed")
        if master_changed:
            restore_previous_obs_state()
            try:
                controller.set_config(
                    scene_map=_effective_scene_map(state),
                    enabled=previous_enabled,
                    debounce_sec=state.obs_switch_debounce_sec,
                    switch_on_replays=state.obs_switch_on_replays,
                )
            except Exception:  # noqa: BLE001
                log.exception("obs_controller_toggle_rollback_failed")
            action = "enable" if desired_enabled else "disable"
            raise RuntimeError(
                f"Could not {action} automatic OBS scene switching",
            ) from exc
    else:
        state.obs_scene_switch_enabled = desired_enabled
    if conn_changed and client is not None:
        try:
            client.reconfigure(
                host=state.obs_host,
                port=state.obs_port,
                password=state.obs_password,
            )
            log.info(
                "obs_reconnect_requested host=%s port=%s",
                state.obs_host,
                state.obs_port,
            )
        except Exception:  # noqa: BLE001
            log.exception("obs_client_reconfigure_failed")


def _handle_obs_probe(
    *,
    host: str,
    port: int,
    password: str,
    log: logging.Logger,
) -> dict:
    """GUI "Test connection": connect once and report what we found.

    Deliberately synchronous and short-lived — it opens its own
    throwaway client rather than borrowing the long-running one, so a
    user typing a wrong password into the form can't knock the live
    switcher off its connection.
    """
    from .live.obs_layout import (
        discover_sources,
        manual_override_scenes_needing_update,
    )

    client = ObsClient(
        host=host,
        port=port,
        password=password or None,
        subscribe_events=False,
    )
    try:
        client.connect_now()
    except ObsAuthFailed:
        return {
            "ok": False,
            "message": (
                "OBS rejected the password. Copy it from OBS → Tools → "
                "WebSocket Server Settings → Show Connect Info."
            ),
        }
    except Exception as exc:  # noqa: BLE001
        log.info("obs_probe_failed host=%s port=%s err=%s", host, port, exc)
        return {
            "ok": False,
            "message": (
                f"Could not reach OBS at {host}:{port}. Check that OBS is "
                "running and the WebSocket server is enabled."
            ),
        }

    try:
        version = client.get_version()
        scenes = client.refresh_scenes()
        sources = discover_sources(client)
    except Exception as exc:  # noqa: BLE001
        log.info("obs_probe_partial err=%s", exc)
        client.shutdown()
        return {"ok": False, "message": f"Connected, but OBS errored: {exc}"}

    manual_update_scenes: list[str] = []
    try:
        manual_update_scenes = manual_override_scenes_needing_update(client)
    except Exception as exc:  # noqa: BLE001
        # Connection testing and source discovery remain useful even when an
        # older OBS build cannot expose its scene-item inventory.
        log.info("obs_manual_override_probe_failed err=%s", exc)
    finally:
        client.shutdown()

    log.info(
        "obs_probe_ok host=%s port=%s scenes=%d", host, port, len(scenes),
    )
    return {
        "ok": True,
        "message": (
            f"Connected to OBS {version.get('obs_version') or '?'} — "
            f"{len(scenes)} scene(s) found."
            + (
                " Your SC2 Tools scenes need a BRB / Starting Soon "
                "priority update; use Update my scenes below."
                if manual_update_scenes
                else ""
            )
        ),
        "scenes": scenes,
        "webcams": sources.get("webcam", []),
        "games": sources.get("game", []),
        "manual_override_update_scenes": manual_update_scenes,
    }


def _handle_obs_build(
    *,
    cfg: AgentConfig,
    state: AgentState,
    request: dict,
    log: logging.Logger,
) -> dict:
    """GUI Build/Update: create or safely upgrade the two OBS layouts.

    Needs a paired overlay token — the backdrop, chat and stats panels
    are all Browser Sources pointed at the user's own overlay URLs, so
    there is nothing meaningful to build without one.
    """
    from .live.obs_layout import (
        BuildPlan,
        PlannedScene,
        SceneBuildError,
        build_scenes,
        plan_scenes,
        repair_broll_audio_roles,
        repair_chat_alert_audio_roles,
        repair_manual_scene_overrides,
    )

    token = _overlay_token_for_build(cfg, state, log)
    if not token:
        return {
            "ok": False,
            "message": (
                "No overlay token yet. Sign in and pair the agent first "
                "— the backdrop and chat panels need your overlay URL."
            ),
        }

    client = ObsClient(
        host=str(request.get("host") or "127.0.0.1"),
        port=int(request.get("port") or 4455),
        password=(request.get("password") or None),
        subscribe_events=False,
    )
    try:
        client.connect_now()
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": f"Could not reach OBS: {exc}"}

    try:
        plan = plan_scenes(
            client,
            overlay_base_url=_dashboard_url_from_api(cfg.api_base),
            overlay_token=token,
            webcam_source=request.get("webcam_source") or None,
            game_source=request.get("game_source") or None,
        )
        manual_url = next(
            item.browser_path
            for scene in plan.scenes
            for item in scene.items
            if item.share_key == "manual_scene_override"
            and item.browser_path
        )
        rebuild = bool(request.get("rebuild"))
        repaired: list[str] = []
        missing_generated: list[str] = []
        raw_authorized_updates = request.get("update_existing_scenes") or []
        if isinstance(raw_authorized_updates, str):
            raw_authorized_updates = [raw_authorized_updates]
        authorized_updates = list(dict.fromkeys(
            str(name) for name in raw_authorized_updates
        ))
        planned_names = {scene.name for scene in plan.scenes}
        foreign_updates = [
            name for name in authorized_updates if name not in planned_names
        ]
        if foreign_updates:
            raise SceneBuildError(
                "Refusing an update request for non-generated OBS scenes: "
                + ", ".join(foreign_updates),
            )

        if rebuild:
            created = build_scenes(client, plan, rebuild=True)
        elif authorized_updates:
            # Test connection grants update permission for exact scene names.
            # Never infer permission merely because a generated name exists:
            # the inventory read may have failed or OBS may have changed after
            # the confirmation dialog was shown.
            created = []
            authorized_existing = [
                scene.name for scene in plan.scenes
                if scene.exists and scene.name in authorized_updates
            ]
            missing_generated = [
                scene.name for scene in plan.scenes if not scene.exists
            ]
            if authorized_existing:
                repaired = repair_manual_scene_overrides(
                    client,
                    browser_url=manual_url,
                    scene_names=authorized_existing,
                )
        elif plan.conflicts:
            # A normal Build may create a missing counterpart, but it has no
            # authority to alter an existing generated scene. Keeping this
            # separate keeps scene creation out of the non-destructive repair
            # transaction the user just confirmed.
            missing_scenes = [
                PlannedScene(
                    name=scene.name,
                    exists=False,
                    items=list(scene.items),
                )
                for scene in plan.scenes
                if not scene.exists
            ]
            missing_plan = BuildPlan(
                canvas_width=plan.canvas_width,
                canvas_height=plan.canvas_height,
                scenes=missing_scenes,
                webcam_source=plan.webcam_source,
                game_source=plan.game_source,
                warnings=list(plan.warnings),
            )
            created = build_scenes(client, missing_plan) if missing_scenes else []
            if not created:
                raise SceneBuildError(
                    "These SC2 Tools scenes already exist. Run Test "
                    "connection and use Update my scenes, or explicitly "
                    "choose Replace in the confirmation dialog.",
                )
        else:
            created = build_scenes(client, plan)
        (
            chat_alert_audio_owners,
            chat_alert_role_updates,
            chat_alert_geometry_updates,
        ) = repair_chat_alert_audio_roles(
            client,
            browser_url=manual_url,
        )
        audio_owner, audio_role_updates = repair_broll_audio_roles(
            client,
            browser_url=manual_url,
        )
    except SceneBuildError as exc:
        return {"ok": False, "message": str(exc)}
    except Exception as exc:  # noqa: BLE001
        log.exception("obs_scene_build_failed")
        return {"ok": False, "message": f"Build failed: {exc}"}
    finally:
        client.shutdown()

    log.info(
        "obs_scene_build_ok created=%s repaired=%s "
        "chat_alert_audio_owners=%s chat_alert_audio_role_updates=%s "
        "chat_alert_geometry_updates=%s "
        "broll_audio_owner=%s broll_audio_role_updates=%s",
        ",".join(created),
        ",".join(repaired),
        chat_alert_audio_owners,
        len(chat_alert_role_updates),
        len(chat_alert_geometry_updates),
        audio_owner or "none",
        len(audio_role_updates),
    )
    note = " ".join(plan.warnings) if plan.warnings else ""
    updated_existing = [name for name in repaired if name not in created]
    outcomes: list[str] = []
    if updated_existing:
        outcomes.append(
            "Updated the BRB / Starting Soon priority in "
            f"{len(updated_existing)} existing scene(s) without changing "
            f"their layout: {', '.join(updated_existing)}."
        )
    if created:
        outcomes.append(
            f"Created {len(created)} missing scene(s): {', '.join(created)}."
        )
    if missing_generated:
        outcomes.append(
            "Update left the missing generated scene(s) untouched: "
            f"{', '.join(missing_generated)}. Click Build my scenes to "
            "create them separately."
        )
    if not outcomes:
        outcomes.append("Your SC2 Tools scenes are already up to date.")
    outcome = " ".join(outcomes) + " "
    next_step = (
        "After building the missing scene, click Save to turn on switching."
        if missing_generated
        else "They're selected in the dropdowns below — click Save to "
        "turn on switching."
    )
    return {
        "ok": True,
        "message": (
            outcome +
            next_step + " " + note
        ).strip(),
        "scenes": client.scene_names or created,
    }


def _overlay_token_for_build(
    cfg: AgentConfig, state: AgentState, log: logging.Logger,
) -> Optional[str]:
    """Fetch the user's overlay token from the cloud.

    The agent doesn't cache one today — the website owns overlay
    tokens — so this is a live lookup, and it failing is a normal
    "not paired yet" outcome rather than an error.
    """
    if not state.device_token:
        return None
    try:
        api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)
        getter = getattr(api, "get_overlay_token", None)
        if getter is None:
            return None
        return getter() or None
    except Exception as exc:  # noqa: BLE001
        log.info("obs_overlay_token_lookup_failed err=%s", exc)
        return None


def _build_obs_switcher(
    *,
    state: AgentState,
    bridge: Optional[LiveBridge],
    log: logging.Logger,
    no_obs: bool = False,
) -> tuple[Optional[ObsClient], Optional[ObsSceneController]]:
    """Construct the OBS auto-scene-switcher and hang it off the bridge.

    Returns ``(None, None)`` whenever switching shouldn't run — the
    feature is off, the Live Game Bridge is disabled (there'd be no
    phase events to react to), or ``--no-obs`` was passed.

    Why this is a separate builder rather than more returns from
    ``_build_live_bridge``: OBS is the one subsystem here that talks to
    a process on the user's desktop rather than to the cloud, and it is
    opt-in. Keeping it out of the bridge's tuple means the bridge's
    contract — and its five existing call-site unpackings — stay put.

    Config precedence matches the rest of the agent: environment
    variables win over the state file, so a power user can point a
    single install at a different OBS without touching the GUI.
    """
    if no_obs:
        log.info("obs_scene_switch_disabled_via_flag")
        return None, None
    if not state.obs_scene_switch_enabled:
        return None, None
    if bridge is None:
        # Nothing publishes phases, so there is nothing to react to.
        log.info("obs_scene_switch_skipped reason=live_bridge_disabled")
        return None, None

    host = os.environ.get("SC2TOOLS_OBS_HOST", "").strip() or state.obs_host
    port_env = os.environ.get("SC2TOOLS_OBS_PORT", "").strip()
    try:
        port = int(port_env) if port_env else int(state.obs_port)
    except ValueError:
        log.warning("obs_port_invalid value=%r falling_back=4455", port_env)
        port = 4455
    password = (
        os.environ.get("SC2TOOLS_OBS_PASSWORD")
        or state.obs_password
        or None
    )
    scene_map = _effective_scene_map(state)

    # Built in two steps: the controller needs the client to issue
    # requests, and the client needs the controller's callback to
    # report manual scene changes. Neither can be constructed first,
    # so the controller goes up bare and takes the client after.
    controller = ObsSceneController(
        scene_map=scene_map,
        debounce_sec=state.obs_switch_debounce_sec,
        switch_on_replays=state.obs_switch_on_replays,
        transition_name=state.obs_transition_name,
        transition_duration_ms=state.obs_transition_duration_ms,
    )
    client: ObsClient

    def _repair_generated_manual_covers() -> None:
        """Upgrade legacy generated layouts after each OBS connection.

        This callback is best-effort by design: scene switching must stay
        available even if an older OBS build cannot inventory or edit items.
        The generated repair is restricted to the two exact builder scenes and
        only their authenticated manual-cover/chat-alert routes. A separate
        portrait exception only references Live's existing alert renderer when
        exact scene, route, token, and portrait fingerprints all match. Neither
        changes existing camera, capture, or custom sources. A throwaway
        request connection keeps failures away from the switcher's long-lived
        request and event sockets.
        """
        repair_host, repair_port, repair_password = client.connection_settings
        repair_client = ObsClient(
            host=repair_host,
            port=repair_port,
            password=repair_password,
            subscribe_events=False,
        )
        try:
            from .live.obs_layout import (
                discover_manual_override_url,
                discover_widget_only_broll_url,
                repair_broll_audio_roles,
                repair_chat_alert_audio_roles,
                repair_manual_scene_overrides,
                repair_vertical_scene_chat_alerts,
            )

            if not repair_client.connect_now():
                raise RuntimeError("OBS repair connection did not stay healthy")
            try:
                if repair_vertical_scene_chat_alerts(repair_client):
                    log.info("obs_vertical_chat_alert_auto_repaired")
            except Exception as exc:  # noqa: BLE001 - independent repair
                log.warning(
                    "obs_vertical_chat_alert_auto_repair_failed err=%s; "
                    "will retry on next OBS connection",
                    exc,
                )

            manual_url = None
            try:
                manual_url = discover_manual_override_url(repair_client)
            except Exception as exc:  # noqa: BLE001 - independent discovery
                log.warning(
                    "obs_manual_override_url_discovery_failed err=%s; "
                    "will retry on next OBS connection",
                    exc,
                )

            audio_identity_url = manual_url
            if audio_identity_url is None:
                try:
                    audio_identity_url = discover_widget_only_broll_url(
                        repair_client,
                    )
                except Exception as exc:  # noqa: BLE001 - independent discovery
                    log.warning(
                        "obs_broll_url_discovery_failed err=%s; "
                        "will retry on next OBS connection",
                        exc,
                    )

            manual_repaired: list[str] = []
            if manual_url is None:
                log.debug(
                    "obs_manual_override_auto_repair_skipped "
                    "reason=no_generated_overlay_url",
                )
            else:
                try:
                    manual_repaired = repair_manual_scene_overrides(
                        repair_client,
                        browser_url=manual_url,
                    )
                    if manual_repaired:
                        log.info(
                            "obs_manual_override_auto_repaired scenes=%r",
                            manual_repaired,
                        )
                except Exception as exc:  # noqa: BLE001 - independent repair
                    log.warning(
                        "obs_manual_override_auto_repair_failed err=%s; "
                        "will retry on next OBS connection",
                        exc,
                    )

            if audio_identity_url is not None:
                try:
                    audio_owners, audio_updates, geometry_scenes = (
                        repair_chat_alert_audio_roles(
                            repair_client,
                            browser_url=audio_identity_url,
                        )
                    )
                    if audio_updates or geometry_scenes:
                        log.info(
                            "obs_chat_alert_audio_roles_auto_repaired "
                            "owners=%r sources=%r scenes=%r",
                            audio_owners,
                            audio_updates,
                            geometry_scenes,
                        )
                except Exception as exc:  # noqa: BLE001 - independent repair
                    log.warning(
                        "obs_chat_alert_audio_roles_auto_repair_failed err=%s; "
                        "will retry on next OBS connection",
                        exc,
                    )

            if audio_identity_url is not None:
                try:
                    owner, updated = repair_broll_audio_roles(
                        repair_client,
                        browser_url=audio_identity_url,
                    )
                    if updated:
                        log.info(
                            "obs_broll_audio_roles_auto_repaired owner=%s "
                            "sources=%r",
                            owner or "none",
                            updated,
                        )
                except Exception as exc:  # noqa: BLE001 - independent repair
                    log.warning(
                        "obs_broll_audio_roles_auto_repair_failed err=%s; "
                        "will retry on next OBS connection",
                        exc,
                    )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "obs_startup_repair_failed err=%s; "
                "will retry on next OBS connection",
                exc,
            )
        finally:
            repair_client.shutdown()

    client = ObsClient(
        host=host,
        port=port,
        password=password,
        on_connected=_repair_generated_manual_covers,
        on_program_scene_changed=controller.on_program_scene_changed,
    )
    controller.attach_client(client)

    bridge.bus.subscribe(controller.listener)
    log.info(
        "obs_scene_switch_configured host=%s port=%s debounce_sec=%.1f",
        host,
        port,
        state.obs_switch_debounce_sec,
    )
    return client, controller


def _build_stream_service(cfg, state, *, no_obs=False):
    """Independent lifecycle worker; never subscribes to scene/game events."""
    try:
        from .streaming.service import StreamService

        def obs_settings():
            port = os.environ.get("SC2TOOLS_OBS_PORT", "").strip()
            return {
                "host": os.environ.get("SC2TOOLS_OBS_HOST", "").strip() or state.obs_host,
                "port": int(port) if port else int(state.obs_port),
                "password": os.environ.get("SC2TOOLS_OBS_PASSWORD") or state.obs_password or None,
            }

        from .streaming.cloud_client import CloudStreamingClient
        cloud = CloudStreamingClient(lambda: (cfg.api_base, state.device_token))
        return StreamService(cfg.state_dir, obs_settings, no_obs=no_obs, cloud_client=cloud)
    except Exception:
        # Do not put credentials, callback URLs or platform responses in the
        # agent logger / crash reporter. Replay sync and switching continue.
        logging.getLogger("sc2tools_agent").warning("stream_controls_unavailable")
        return None


class _RuntimeCell:
    """Mutable container shared between the GUI thread and the boot
    worker. Kept as a plain class (no dataclass) so it never tries to
    deepcopy the live thread/queue handles."""

    __slots__ = (
        "api", "recovery", "pairing_controls", "activity_gate", "update_scheduler", "stream_service",
        "recent_history",
        "resync_lock",
        "gui",
        "tray",
        "console",
        "ui",
        "upload",
        "watcher",
        "updater",
        "heartbeat",
        "socket_client",
        "import_ctl",
        "live_bus",
        "live_poller",
        "live_bridge",
        "live_transport",
        "live_metrics_logger",
        "build_checkin",
        "obs_client",
        "obs_scene",
        "obs_lock",
        "no_obs",
    )

    def __init__(self) -> None:
        self.recent_history = None
        self.resync_lock = threading.Lock()
        self.stream_service = None
        self.activity_gate = None
        self.update_scheduler = None
        self.api = None
        self.recovery = None
        self.pairing_controls = PairingControls()
        self.gui = None
        self.tray = None
        self.console = None
        self.ui = None
        self.upload = None
        self.watcher = None
        self.updater = None
        self.heartbeat = None
        self.socket_client = None
        self.import_ctl = None
        self.live_bus = None
        self.live_poller = None
        self.live_bridge = None
        self.live_transport = None
        self.live_metrics_logger = None
        self.build_checkin = None
        self.obs_client = None
        self.obs_scene = None
        # The GUI thread can toggle OBS while the boot worker is constructing
        # the controller. One lock prevents duplicate EventBus subscriptions
        # and makes the persisted gate authoritative at startup.
        self.obs_lock = threading.RLock()
        self.no_obs = False


class _Multiplexer:
    """Forward UI events to every wired-up sink (console + tray + gui)."""

    def __init__(
        self,
        console: ConsoleUI,
        tray: Optional[TrayUI] = None,
        gui: Optional[GuiUI] = None,
        *, facts=None,
    ) -> None:
        self._status_lock = threading.RLock()
        initial_folders=getattr(gui,"_replay_folders",None)
        self._status_facts = facts or StatusFacts(
            paired=getattr(gui, "_initial_paired", False),
            paused=getattr(gui, "_initial_paused", False),
            folders=list(initial_folders) if isinstance(initial_folders,(list,tuple)) else None,
        )
        self._offline_since = 0.0
        self._offline_toasted = False
        self._recovered_count = 0
        self._recent_history = None
        self._import_ctl = None
        self._game_notifications = lambda: False
        self._notified_games = []
        self._sinks: List[Any] = [console]
        if tray:
            self._sinks.append(tray)
        if gui:
            self._sinks.append(gui)

    def refresh_status(self):
        self._change_status()

    def on_update_available(self, latest):
        for sink in self._sinks:
            callback=getattr(sink,"on_update_available",None)
            if callback: callback(latest)
        self._change_status(update_pending=latest)

    def _change_status(self, **changes):
        with self._status_lock:
            self._status_facts.terminal_failure_times[:] = [stamp for stamp in self._status_facts.terminal_failure_times if time.time()-stamp <= 600]
            for key, value in changes.items():
                setattr(self._status_facts, key, value)
            view = derive_status(self._status_facts, time.time())
        for sink in self._sinks:
            callback = getattr(sink, "on_status_view", None)
            if callback:
                callback(view)

    def on_phase(self, phase, detail=""):
        for sink in self._sinks:
            callback = getattr(sink, "on_phase", None)
            if callback: callback(phase, detail)
        changes = {"phase":phase}
        if phase=="boot_error": changes["boot_error"]=detail
        self._change_status(**changes)

    def on_analyzer_probe(self, ok, diag):
        for sink in self._sinks:
            callback = getattr(sink, "on_analyzer_probe", None)
            if callback: callback(ok, diag)
        self._change_status(analyzer_ok=ok, analyzer_diag=diag)

    def on_paused(self, paused, until=None):
        if self._import_ctl:
            self._import_ctl.set_hold(paused=paused)
        for sink in self._sinks:
            callback = getattr(sink, "on_paused", None)
            if callback: callback(paused, until)
        self._change_status(paused=paused, paused_until=until)

    def on_folders(self, folders):
        for sink in self._sinks:
            callback=getattr(sink,"set_replay_folders",None)
            if callback: callback(folders)
        self._change_status(folders=list(folders))

    def on_filter_label(self, label):
        self._change_status(filter_label=label)

    def on_pairing_state(self, state) -> None:
        if state.kind in ("requesting", "showing"):
            self._change_status(unlinked=False, paired=False)
        for sink in self._sinks:
            callback = getattr(sink, "on_pairing_state", None)
            if callback:
                callback(state)

    def on_unlinked(self) -> None:
        self._change_status(unlinked=True, paired=False)
        if self._recent_history:
            self._recent_history.refresh()
        for sink in self._sinks:
            callback = getattr(sink, "on_unlinked", None)
            if callback:
                callback()

    def on_connection_state(self, kind, since, next_retry_at, waiting_count) -> None:
        import time
        if self._import_ctl:
            self._import_ctl.set_hold(connection=kind)
        if kind == "online":
            if self._offline_since:
                self._notice(f"Back online: {self._recovered_count:,} replays synced")
            self._offline_since = 0.0
            self._offline_toasted = False
            self._recovered_count = 0
        else:
            self._offline_since = self._offline_since or since
            if waiting_count and not self._offline_toasted and time.time() - self._offline_since >= 600:
                self._notice(f"Sync is waiting for a connection. {waiting_count:,} replays are safely queued.")
                self._offline_toasted = True
        self._change_status(connection=ConnectionFacts(kind,waiting_count,next_retry_at))
        for sink in self._sinks:
            callback = getattr(sink, "on_connection_state", None)
            if callback:
                callback(kind, since, next_retry_at, waiting_count)

    def _notice(self, message):
        for sink in self._sinks:
            callback = getattr(sink, "show_notice", None) or getattr(sink, "show_transient_notice", None)
            if callback:
                callback(message)

    def show_pairing_code(self, code: str) -> None:
        for s in self._sinks:
            s.show_pairing_code(code)

    def on_paired(self, user_id: str) -> None:
        self._change_status(paired=True, unlinked=False)
        if self._recent_history:
            self._recent_history.refresh()
        for s in self._sinks:
            s.on_paired(user_id)

    def on_status(self, status: str) -> None:
        for s in self._sinks:
            s.on_status(status)

    def on_upload_success(self, name: str) -> None:
        self._change_status(last_upload_at=time.time())
        if self._offline_since:
            self._recovered_count += 1
        for s in self._sinks:
            s.on_upload_success(name)

    def on_game_synced(self, path, summary):
        owner = summary.get("_owner")
        if self._recent_history and owner != self._recent_history.owner_provider():
            return
        if self._recent_history:
            self._recent_history.game_synced(path, summary)
        for sink in self._sinks:
            callback = getattr(sink, "on_game_synced", None)
            if callback:
                callback(path, summary)
        identifier = summary.get("gameId")
        notification_key = (owner, identifier)
        if (self._game_notifications() and identifier and notification_key not in self._notified_games
                and not summary.get("isHistory") and not summary.get("isResumed") and summary.get("result")):
            self._notified_games = (self._notified_games + [notification_key])[-200:]
            race = (summary.get("races") or {}).get("opponent")
            race_copy = f" ({race[0]})" if race else ""
            self._notice(f"{summary['result']} vs {summary.get('oppName') or 'Unknown opponent'}{race_copy} on {summary.get('map') or 'Unknown map'}")

    def on_recent_snapshot(self, snapshot):
        for sink in self._sinks:
            callback = getattr(sink, "on_recent_snapshot", None)
            if callback:
                callback(snapshot)

    def on_import_progress(self, snapshot):
        for sink in self._sinks:
            callback = getattr(sink, "on_import_progress", None)
            if callback:
                callback(snapshot)

    def on_upload_failed(self, name: str, reason) -> None:
        if getattr(reason, "counts_as_error", True):
            with self._status_lock:
                self._status_facts.terminal_failure_times.append(time.time())
            self._change_status(latest_failure_title=reason if isinstance(reason,str) else reason.title)
        for s in self._sinks:
            s.on_upload_failed(name, reason)

    def on_pending(self, count: int) -> None:
        old=self._status_facts.connection
        self._change_status(pending_count=count, connection=ConnectionFacts(old.kind,count,old.next_retry_at))
        for s in self._sinks:
            s.on_pending(count)

    def on_replay_archive_status(
        self,
        missing_games: int,
        total_games: int,
    ) -> None:
        for sink in self._sinks:
            callback = getattr(sink, "on_replay_archive_status", None)
            if callable(callback):
                callback(missing_games, total_games)


__all__ = ["run_agent"]
