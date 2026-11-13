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
from contextlib import ExitStack, nullcontext
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
from .sync_report import SyncReportTracker
from .sync_retry import SyncRetryController, replay_ticket, publish_owned_toons, publish_local_hint, current_identity_source, settings_identity_origin
from .instance_lock import AgentInstanceLock
from .live import EventBus, LiveBridge, LiveLifecycleEvent, PulseClient
from .live.client_api import LiveClientPoller
from .live.metrics import PeriodicMetricsLogger
from .live.types import _unique_player_name_match
from .live.obs_client import ObsAuthFailed, ObsClient
from .live.obs_scene import DEFAULT_SCENE_MAP, ObsSceneController, SCENE_BETWEEN_GAMES, SCENE_IN_GAME
from .live.transport import (
    CloudTransport,
    FanOutTransport,
    OverlayBackendTransport,
)
from .pairing import ensure_paired
from .pairing.flow import PairingControls
from .pairing.recovery import RuntimeRecovery
from .errors import classify
from .health import HealthMonitor, classify_boot_error
from .recent_games import parse_time
from .milestone_notices import MilestoneNotices
from .relaunch import AgentRelaunch, take_restart_marker
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
    read_settings_hint,
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
from .state import (AgentState, COMPANION_SKINS, _STATE_SAVE_LOCK, count_synced, load_state, save_state,
    migrate_legacy_state, commit_state_credentials, credential_revision, credential_status)
from .agent_credentials import CredentialIntent, CredentialStorageError
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
    # Before _bootstrap edits the environment, so a restart reads fresh settings.
    relaunch = AgentRelaunch(argv)

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
        try:
            migrate_legacy_state(cfg.state_dir, instance_lock)
        except Exception:
            _secure_state_startup_failure(args)
            return 1
        return _run_locked_agent(cfg, args, argv, relaunch=relaunch)
    finally:
        instance_lock.release()
        # Only now: a copy started while the lock was held would hand off to this one and exit.
        relaunch.start_if_requested()


def _secure_state_startup_failure(args):
    message = ("SC2 Tools could not open secure credential storage and did not start syncing. "
        "Restart the app and try again. If this continues, use the desktop support guide.")
    print(message, file=sys.stderr)
    if args.no_gui or not can_use_gui():
        return
    try:
        from .ui.gui import _qt
        _core, _gui, widgets = _qt()
        application = widgets.QApplication.instance() or widgets.QApplication([])
        widgets.QMessageBox.critical(None, "SC2 Tools could not start", message)
        del application
    except Exception:
        pass  # The fixed console message remains available without Qt.


def _auth_epoch_current(state, expected, stop_event=None):
    with _STATE_SAVE_LOCK:
        return (expected is not None and getattr(state, "_owner_epoch", None) is expected
            and (stop_event is None or not stop_event.is_set()))


def _run_locked_agent(
    cfg: AgentConfig,
    args: argparse.Namespace,
    argv: Optional[List[str]],
    *,
    relaunch: Optional[AgentRelaunch] = None,
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
                relaunch=relaunch,
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

    # Restart agent brings the window back, whatever the saved setting says. The
    # marker is taken on every start, so it never outlives the one it was set for.
    restarted = take_restart_marker()
    if state.start_minimized and not restarted:
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
    """Keep the public entry seam and settle support on every boot exit."""
    with ExitStack() as support_lifetime:
        return _run_headless_runtime(cfg, log_dir, no_live=no_live, no_obs=no_obs,
            support_lifetime=support_lifetime)


def _run_headless_runtime(cfg, log_dir, *, no_live=False, no_obs=False, support_lifetime):
    """Legacy path - console + tray. Identical to the 0.2.x runner."""
    log = logging.getLogger("sc2tools_agent")
    state = load_state(cfg.state_dir)
    api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)

    recovery_cell = _RuntimeCell()
    recovery_cell.no_obs = no_obs
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
        if recovery_cell.support:
            recovery_cell.support.cancel()
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
                cfg, state, picked, tray, log, upload=upload, ui=ui,
            ),
            on_check_updates=lambda: _check_updates_with_notice(recovery_cell),
            on_install_update=lambda: recovery_cell.update_scheduler.tick(explicit=True) if recovery_cell.update_scheduler else None,
            notifications_enabled=lambda: not state.notifications_muted,
            # No GUI in this mode — the tray omits its window item.
            synced_count_provider=lambda: count_synced(state),
        )

    ui = _Multiplexer(console, tray, facts=StatusFacts(paired=state.is_paired,
        paused=state.paused,folders=list(initial_replay_folders)),
        auth_epoch_guard=lambda epoch: _auth_epoch_current(state, epoch, stop_event))
    recovery_cell.api, recovery_cell.ui = api, ui
    recovery_cell.support = _make_support_service(cfg, state, recovery_cell, stop_event, log_dir)
    support_lifetime.callback(recovery_cell.support.close)
    ui._support = recovery_cell.support
    if tray:
        tray.set_support_service(recovery_cell.support)
    _push_feature_facts(ui, state, no_live)
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
        ui.on_paired_current(state.user_id or "", getattr(state, "_owner_epoch", None))

    probe_ok, probe_diag = probe_analyzer()
    ui.on_analyzer_probe(probe_ok, probe_diag)
    if not probe_ok:
        log.error(
            "analyzer_probe_failed_at_startup — replays will not be parsed "
            "until the analyzer can be loaded. Diagnostic: %s",
            probe_diag,
        )

    _ensure_player_handle(api, cfg, state, initial_replay_folders, log, on_source=ui.health.set_identity)

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
        on_auth_outcome=recovery.queue_auth_outcome,
        cfg=cfg,
        state=state,
        api=api,
        on_success=lambda p: ui.on_upload_success(p.name),
        on_owned_outcome=lambda context, path, exc: import_ctl.on_owned_upload(context, path, exc) if import_ctl else None,
        on_failure=lambda p, exc: _desktop_upload_failed(ui, import_ctl, p, exc),
        on_support_error=lambda context, code: recovery_cell.support.record_upload_error(context, code) if recovery_cell.support else None,
        on_pending_changed=ui.on_pending,
        on_archive_pending_changed=ui.health.set_archive_pending,
        on_game_synced_current=ui.on_game_synced,
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
        on_owned_skipped=lambda ticket, path, reason: import_ctl.on_owned_skipped(ticket, path, reason) if import_ctl else None,
        on_roots_changed=ui.on_folders,
        on_unresolved=lambda path, entries, *, ticket: _record_sync_unresolved(ui, state, path, entries, ticket),
    )
    import_ctl = ImportController(
        owner_epoch=replay_ticket(state).epoch,
        api=api,
        watcher=watcher,
        full_resync=lambda: _handle_replay_archive_resync(
            cfg, state, upload,
        ),
        list_folders=lambda: [
            str(p) for p in _discover_replay_folders(cfg, state)
        ],
        on_change_current=ui.on_import_progress_current,
    )

    recovery_cell.tray, recovery_cell.console, recovery_cell.ui = tray, console, ui
    recovery_cell.update_scheduler = _make_update_scheduler(cfg,state,recovery_cell,activity_gate,
        stop_event,request_stop,log)
    updater = Updater(cfg=cfg,state=state,on_update_available=recovery_cell.update_scheduler.offer,
                      on_check=lambda release: _announce_updated_version(cfg,state,recovery_cell,release))
    recovery_cell.updater = updater
    beat_ok, beat_failed = _health_heartbeat(ui, lambda: recovery.connected(auth=False), lambda _exc: None)
    heartbeat = Heartbeat(api, on_success=beat_ok, on_failure=beat_failed, state_dir=cfg.state_dir,
                          auth_context=recovery.auth_context, on_auth_outcome=recovery.auth_outcome,
                          support_error_context=lambda captured: recovery_cell.support.capture_error(captured) if recovery_cell.support else None,
                          sync_provider=_sync_report_provider(ui, state, cfg),
                          on_overlay_tokens=_obs_token_rotation_controller(cfg, state, recovery_cell).heartbeat)
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
            on_sync_retry=SyncRetryController(cfg=cfg, state=state, cell=recovery_cell, stop_event=stop_event).handle,
            **_reanalysis_callbacks(cfg, state, recovery_cell, stop_event),
            on_import_scan=import_ctl.handle_scan_request,
            on_import_start=import_ctl.handle_start_request,
            on_import_cancel=import_ctl.handle_cancel_request,
            on_import_pick_folder=import_ctl.handle_pick_folder_request,
            on_bot_lab=BotLabController(cfg.state_dir, state).handle,
            on_obs_add=_obs_website_controller(cfg, state, recovery_cell).handle,
            on_overlay_tokens_changed=_obs_token_rotation_controller(cfg, state, recovery_cell).changed,
            obs_add_enabled_provider=lambda: bool(_obs_website_scope(cfg, state, recovery_cell)),
            overlay_token_provider=lambda token: ApiClient(base_url=cfg.api_base, device_token=token).get_overlay_token(interactive=True),
            session_enabled=state.companion_session_enabled,
            on_connection=ui.health.set_socket,
            on_weekly_report=_weekly_report_signal(recovery_cell, state),
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
            on_contact=ui.health.live_contact,
            user_name_hint=resolve_player_handle(cfg.state_dir),
            state_dir=cfg.state_dir,
            replay_folders=initial_replay_folders,
            log=log,
            api=api,
            device_token=state.device_token,
        )
    else:
        log.info("live_bridge_disabled_via_flag")

    recovery_cell.live_metrics_logger = live_metrics_logger
    if live_bus is not None:
        live_bus.subscribe(activity_gate.on_event)
        notices = _start_milestone_notices(cfg, state, ui, tray, stop_event)
        if notices:
            live_bus.subscribe(notices.on_game_event)
            support_lifetime.callback(notices.close)
    obs_client, obs_scene = _build_obs_switcher(
        state=state, bridge=live_bridge, log=log, no_obs=no_obs, health=ui.health,
    )
    stream_service = _build_stream_service(cfg, state, no_obs=no_obs)
    recovery_cell.stream_service = stream_service
    if live_bus is not None and stream_service:
        live_bus.subscribe(stream_service.on_game_event)
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
        recovery_cell.support.close()
        log.info("agent_stopping")
        if ui._milestone_notices:
            ui._milestone_notices.close()
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
    relaunch: Optional[AgentRelaunch] = None,
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
        if cell.support:
            cell.support.cancel()
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
        notify_milestones=state.notify_milestones,
        notify_weekly_report=state.notify_weekly_report,
        notifications_muted=state.notifications_muted,
        close_to_tray=state.close_to_tray,
        # Only an explicit override attributed to this account is prefilled.
        # Legacy/cloud flat cache contents never become Settings provenance.
        player_handle=read_settings_hint(cfg.state_dir, state.user_id) or "",
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
        obs_password=None,
        obs_credential_revision=credential_revision(state, "obs"),
        obs_credential_status=credential_status(state, "obs"),
        obs_scene_map=dict(state.obs_scene_map),
        obs_switch_debounce_sec=state.obs_switch_debounce_sec,
        obs_switch_on_replays=state.obs_switch_on_replays,
        obs_website_add_enabled=state.obs_website_add_enabled,
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

    def companion_connection():
        with _STATE_SAVE_LOCK:
            return cfg.api_base, state.device_token

    companion = CompanionClient(
        companion_connection,
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
        from .session_stats import session_account_key

        with _STATE_SAVE_LOCK:
            account_key = preferences.get("accountKey")
            if account_key is not None and (not state.device_token or
                    account_key != session_account_key(cfg.api_base, state.device_token)):
                raise ValueError("The linked account changed. Refresh Ghost and try again.")
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
        connection_provider=companion_connection,
    )

    def companion_action(request):
        if isinstance(request, dict) and str(request.get("action", "")).startswith("ghost_"):
            if request.get("action") == "ghost_local_target":
                from .ghost_replay import load_local_ghost_replay

                return load_local_ghost_replay(request.get("path"))
            result = ghost.action(request)
            if request.get("action") == "ghost_state":
                from .practice_hud import read_display_mode
                from .replay_finder import candidate_documents_dirs

                result["replayFolders"] = [str(folder) for folder in _discover_replay_folders(cfg, state)]
                result["displayMode"] = read_display_mode(folder / "StarCraft II" / "Variables.txt" for folder in candidate_documents_dirs())
            return result
        return companion.action(request)

    gui = GuiUI(
        settings_identity_provider=lambda: settings_identity_origin(state),
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
        auth_epoch_guard=lambda epoch: _auth_epoch_current(state, epoch, stop_event),
        initial_auth_epoch=replay_ticket(state).epoch,
        obs_credential_provider=lambda: _obs_credential_metadata(state),
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
        on_obs_probe_candidate=lambda host, port, password, intent, revision: _test_obs_candidate(
            state, host, port, password, intent, revision, log),
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
        on_restart_agent=(lambda: _restart_agent(relaunch, request_stop)) if relaunch else None,
        start_minimized=start_minimized,
        window_geometry=state.window_geometry,
        window_information_layout=state.window_information_layout,
        on_window_information_layout=lambda layout: _remember_information_layout(cfg.state_dir, state, layout),
        window_skin=state.companion_skin,
        window_animations=state.companion_animations,
        on_window_appearance=lambda skin, animations: _remember_window_appearance(cfg.state_dir, state, skin, animations),
        companion_panel_positions=dict(state.companion_panel_positions),
        on_companion_panel_positions=lambda positions: _remember_companion_panel_positions(cfg.state_dir, state, positions),
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
            on_move_practice_hud=gui.toggle_practice_hud_move,
            notifications_enabled=lambda: not state.notifications_muted,
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

    multiplex = _Multiplexer(console, tray, gui,
        auth_epoch_guard=lambda epoch: _auth_epoch_current(state, epoch, stop_event))
    cell.ui = multiplex
    cell.support = _make_support_service(cfg, state, cell, stop_event, log_dir)
    gui.set_support_service(cell.support)
    if tray:
        tray.set_support_service(cell.support, on_help=gui.show_help, on_copy=gui.copy_support_info)
    multiplex._support = cell.support
    _push_feature_facts(multiplex, state, no_live)
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
    if not no_live:
        _start_milestone_notices(cfg, state, multiplex, tray, stop_event)
    worker.start()
    if stream_service:
        stream_service.start()

    try:
        rc = gui.run()
    finally:
        if multiplex._milestone_notices:
            multiplex._milestone_notices.close()
        cell.support.close()

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


def _save_first_run(cfg, state, choices, initial_folders, ui):
    from .first_run import setup_range

    replay_range = setup_range(choices.preset)
    folder_keys = {path_key(Path(path)) for path in choices.folders}
    removed = [str(path) for path in initial_folders if path_key(path) not in folder_keys]
    fields = ("replay_folders_override", "replay_folders_excluded", "replay_folder_override", "sync_filter_preset",
              "sync_filter_since", "sync_filter_until", "autostart_enabled", "setup_pending", "setup_completed_at")
    with _STATE_SAVE_LOCK:
        previous = {name: getattr(state, name) for name in fields}
        original_startup = autostart.is_enabled() if choices.start_with_windows is not None else None
        changed_startup = original_startup is not None and original_startup != choices.start_with_windows
        try:
            _apply_saved_replay_folders(cfg, state, list(choices.folders), removed)
            if changed_startup and not autostart.set_enabled(choices.start_with_windows):
                raise OSError("Windows did not accept the start-up setting.")
            if choices.start_with_windows is not None:
                state.autostart_enabled = choices.start_with_windows
            state.sync_filter_preset = replay_range.preset
            state.sync_filter_since = replay_range.since_iso
            state.sync_filter_until = replay_range.until_iso
            state.setup_pending = False
            state.setup_completed_at = time.time()
            save_state(cfg.state_dir, state)
        except Exception:
            for name, value in previous.items():
                setattr(state, name, value)
            if changed_startup:
                autostart.set_enabled(original_startup)
            raise
    try:
        ui.on_filter_label(replay_range.short_label() if replay_range.is_active() else "")
    except Exception:
        pass  # The saved choice remains authoritative when a window closes.
    return replay_range


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
        from .first_run import FirstRunSetup, prepare_first_run

        gui = getattr(cell, "gui", None)
        setup_pending = bool(gui and prepare_first_run(state, lambda: save_state(cfg.state_dir, state)))
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
            ui.on_paired_current(state.user_id or "", getattr(state, "_owner_epoch", None))

        if setup_pending:
            discovered = _discover_replay_folders(cfg, state)
            setup = FirstRunSetup(
                folders=discovered,
                start_with_windows=autostart.is_enabled() if autostart.is_supported() else None,
                save=lambda choices: _save_first_run(cfg, state, choices, discovered, ui),
            )
            gui._dispatch("setupRequested", setup)
            if not setup.wait(stop_event):
                return

        probe_ok, probe_diag = probe_analyzer()
        ui.on_analyzer_probe(probe_ok, probe_diag)
        if not probe_ok:
            log.error(
                "analyzer_probe_failed_at_startup — replays will not be "
                "parsed until the analyzer can be loaded. Diagnostic: %s",
                probe_diag,
            )

        folders_for_detect = _discover_replay_folders(cfg, state)
        _ensure_player_handle(api, cfg, state, folders_for_detect, log, on_source=ui.health.set_identity)

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
            on_auth_outcome=recovery.queue_auth_outcome,
            cfg=cfg,
            state=state,
            api=api,
            on_success=lambda p: ui.on_upload_success(p.name),
            on_owned_outcome=lambda context, path, exc: import_ctl.on_owned_upload(context, path, exc) if import_ctl else None,
            on_failure=lambda p, exc: _desktop_upload_failed(ui, import_ctl, p, exc),
            on_support_error=lambda context, code: cell.support.record_upload_error(context, code) if cell.support else None,
            on_pending_changed=ui.on_pending,
            on_archive_pending_changed=ui.health.set_archive_pending,
            on_game_synced_current=ui.on_game_synced,
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
            on_owned_skipped=lambda ticket, path, reason: import_ctl.on_owned_skipped(ticket, path, reason) if import_ctl else None,
            on_roots_changed=lambda folders: _show_replay_folders(
                cell, folders,
            ),
            on_unresolved=lambda path, entries, *, ticket: _record_sync_unresolved(ui, state, path, entries, ticket),
        )
        import_ctl = ImportController(
            owner_epoch=replay_ticket(state).epoch,
            api=api,
            watcher=watcher,
            full_resync=lambda: _handle_replay_archive_resync(
                cfg, state, upload,
            ),
            list_folders=lambda: [
                str(p) for p in _discover_replay_folders(cfg, state)
            ],
            on_change_current=ui.on_import_progress_current,
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
        beat_ok, beat_failed = _health_heartbeat(ui, lambda: recovery.connected(auth=False), lambda _exc: None)
        heartbeat = Heartbeat(api, on_success=beat_ok, on_failure=beat_failed, state_dir=cfg.state_dir,
                              auth_context=recovery.auth_context, on_auth_outcome=recovery.auth_outcome,
                              support_error_context=lambda captured: cell.support.capture_error(captured) if cell.support else None,
                              sync_provider=_sync_report_provider(ui, state, cfg),
                              on_overlay_tokens=_obs_token_rotation_controller(cfg, state, cell).heartbeat)

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
            def intent_changed(ping):
                controller = getattr(cell, "build_checkin", None)
                if controller and not ping.get("ghostPrefs"):
                    controller.on_intent_changed(ping)
                if ping.get("ghostPrefs") or ping.get("gameKey"):
                    cell.gui._dispatch("practiceChanged", ping.get("gameKey"))

            socket_client = SocketClient(
                base_url=cfg.api_base,
                device_token=state.device_token,
                on_recompute_games=on_macro,
                on_recompute_opp_build=on_opp,
                on_full_resync=on_full_resync,
                on_sync_retry=SyncRetryController(cfg=cfg, state=state, cell=cell, stop_event=stop_event).handle,
                **_reanalysis_callbacks(cfg, state, cell, stop_event),
                on_import_scan=import_ctl.handle_scan_request,
                on_import_start=import_ctl.handle_start_request,
                on_import_cancel=import_ctl.handle_cancel_request,
                on_import_pick_folder=import_ctl.handle_pick_folder_request,
                on_bot_lab=BotLabController(cfg.state_dir, state).handle,
                on_obs_add=_obs_website_controller(cfg, state, cell).handle,
                on_overlay_tokens_changed=_obs_token_rotation_controller(cfg, state, cell).changed,
                obs_add_enabled_provider=lambda: bool(_obs_website_scope(cfg, state, cell)),
                overlay_token_provider=lambda token: ApiClient(base_url=cfg.api_base, device_token=token).get_overlay_token(interactive=True),
                session_enabled=state.companion_session_enabled,
                on_connection=ui.health.set_socket,
                on_weekly_report=_weekly_report_signal(cell, state),
                on_build_intent_changed=intent_changed,
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
                on_contact=ui.health.live_contact,
                user_name_hint=resolve_player_handle(cfg.state_dir),
                state_dir=cfg.state_dir,
                replay_folders=folders_for_detect,
                log=log,
                api=api,
                device_token=state.device_token,
            )
            live_bus.subscribe(cell.activity_gate.on_event)
            if notices := getattr(ui, "_milestone_notices", None):
                live_bus.subscribe(notices.on_game_event)
            if cell.stream_service:
                live_bus.subscribe(cell.stream_service.on_game_event)
            cell.live_bus = live_bus
            cell.live_poller = live_poller
            cell.live_bridge = live_bridge
            cell.live_transport = live_transport
            cell.live_metrics_logger = live_metrics_logger

            def checkin_connection():
                with _STATE_SAVE_LOCK:
                    return cfg.api_base, state.device_token

            def checkin_identity():
                with _STATE_SAVE_LOCK:
                    return cfg.api_base, state.device_token, state.user_id

            # Subscribed before the bridge starts so no envelope is missed.
            cell.build_checkin = start_build_checkin(
                api=api,
                bus=live_bridge.bus,
                state=state,
                state_dir=cfg.state_dir,
                dashboard_url=_dashboard_url_from_api(cfg.api_base),
                view=build_checkin_view_for(cell.gui),
                connection_provider=checkin_connection,
                identity_provider=checkin_identity,
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
                    health=ui.health,
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
        # Classified first so the health snapshot never shows a generic boot row.
        ui.health.set_boot_error(classify_boot_error(exc, state_dir=cfg.state_dir))
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
    with _STATE_SAVE_LOCK:
        state.uploaded.clear()
        save_state(cfg.state_dir, state)
    if upload:
        upload.request_full_resync()
    logging.getLogger(__name__).info("agent_resync_requested")


def _weekly_report_signal(cell, state):
    def received(socket, token):
        with _STATE_SAVE_LOCK:
            if cell.socket_client is not socket or not token or token != state.device_token:
                return
            notices = cell.ui._milestone_notices
            if notices is not None:
                notices.on_weekly_report(replay_ticket(state))
    return received


def _start_milestone_notices(cfg, state, ui, tray, stop_event):
    if tray is None:
        return None
    notices = MilestoneNotices(state=state, state_dir=cfg.state_dir, api_base=cfg.api_base,
                              notify=tray.show_notice, stop_event=stop_event)
    ui._milestone_notices = notices
    notices.start()
    return notices


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
    ui._game_notifications = lambda: state.notify_every_game and not state.notifications_muted
    history.start()
    return history


def _desktop_upload_failed(ui, import_ctl, path, exc):
    error = classify(exc)
    ui.on_upload_failed(path.name, error)
    if ui._recent_history:
        ui._recent_history.problem(path, error)


def _desktop_replay_skipped(ui, import_ctl, path, reason):
    if ui._recent_history:
        ui._recent_history.skipped(path, reason or "parse_failed")


def _health_heartbeat(ui, on_success, on_failure):
    """Run the recovery hooks first, then record the heartbeat for health.

    Authentication outcomes are delivered separately with their admitted scope.
    A success hook that raises is
    reported by Heartbeat as a failure, so health records it the same way.
    """
    def success():
        on_success()
        ui.health.heartbeat_ok()

    def failure(exc):
        on_failure(exc)
        ui.health.heartbeat_failed(classify(exc).kind)

    return success, failure


def _restart_agent(relaunch, request_stop):
    """Restart agent: the usual shutdown, then run_agent starts a fresh copy."""
    relaunch.request()
    request_stop()


def _sync_report_provider(ui, state, cfg):
    """Capture mutable state under its lock; derive from private copies only."""
    def missing():
        configured = [*state.replay_folders_override]
        if cfg.replay_folder:
            configured.append(str(cfg.replay_folder))
        return tuple(dict.fromkeys(str(path) for path in configured if not Path(path).is_dir()))

    ui._missing_folders = missing
    ui._identity_refresh = lambda: _reconcile_identity(ui, cfg.state_dir, state)
    def current(api=None):
        with _STATE_SAVE_LOCK:
            ticket = replay_ticket(state)
            if api is not None and getattr(api, "device_token", None) != ticket.token:
                return {}
            owner = (ticket.owner, ticket.token, ticket.epoch)
            ui.sync_report.set_owner(owner)
            generation = ui.sync_report.generation()
            uploaded = dict(state.uploaded)
            missing_paths = missing()
        ui._identity_refresh()
        ui.health.set_folders(ui.health.facts().folders, missing=missing_paths)
        facts = ui.health.facts()
        report = ui.sync_report.report(facts, uploaded, generation=generation, owner=owner)
        # An explicit env root stays in the discovery list even while missing.
        # Only existing directories can be watched; keep that list intact for UI.
        report["foldersWatched"] = sum(Path(path).is_dir() for path in facts.folders or ())
        return report
    current.for_api = current
    return current


def _record_sync_unresolved(ui, state, path, entries, ticket):
    # Actual publication is fenced, even when a callback was held after mark.
    # This audited tracker only acquires its own metadata lock, never a queue.
    with _STATE_SAVE_LOCK:
        if ticket.current(state):
            ui.sync_report.set_owner((ticket.owner, ticket.token, ticket.epoch))
            ui.sync_report.unresolved(path, entries, ticket=ticket)


def _reconcile_identity(ui, state_dir, state=None):
    """A parser's first toon-path repair can populate the cache after boot."""
    if state is not None:
        ui.health.set_identity(current_identity_source(state, state_dir))
        return
    if ui.health.facts().identity_source not in (None, "none"):
        return
    if read_player_handle_cache(state_dir):
        ui.health.set_identity("cache")
    elif resolve_player_handle(None):
        ui.health.set_identity("environment")


def _push_feature_facts(ui, state, no_live):
    """Feature gates feed the footer; continuing contact comes from the poller."""
    ui.health.set_auto_update(state.auto_update_enabled)
    ui.health.set_live(not no_live)


def _request_desktop_resync(cfg, state, cell):
    """The confirmation is on Qt; cursor writes and inventory never are."""
    if not cell.resync_lock.acquire(blocking=False):
        return

    def run():
        try:
            _handle_replay_archive_resync(cfg, state, cell.upload)
            if cell.ui and cell.upload is not None and _replay_archive_ack_allowed(state):
                cell.ui.health.set_archive_status(0, 0)  # the asked-for full Re-sync has started
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


def _reanalysis_callbacks(cfg, state, cell, stop_event):
    """Managed re-analysis: one worker per agent, shared across socket rebuilds."""
    controller = getattr(cell, "reanalysis", None)
    if controller is None:
        from .reanalysis import ReanalysisController
        controller = ReanalysisController(cfg=cfg, state=state, cell=cell, stop_event=stop_event)
        cell.reanalysis = controller
    return {"on_reanalyze": controller.handle_batch, "on_reanalyze_cancel": controller.handle_cancel}


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
    with _STATE_SAVE_LOCK:
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
    ui=None,
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
    if ui:
        ui.on_folders(folders)
    if upload:
        upload.request_full_resync()


def _show_replay_folders(cell, folders: List[Path]) -> None:
    """Show a new folder list in the tray, the dashboard and the health card."""
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
    if getattr(cell, "support", None):
        cell.support.invalidate()
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
    if state.window_geometry == geometry and state.window_page == page:
        return
    state.window_geometry = geometry
    state.window_page = page
    save_state(state_dir, state)


def _remember_information_layout(state_dir, state, layout):
    if layout not in {"compact", "standard", "detailed", "full"}:
        return
    if state.window_information_layout == layout:
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


def _remember_companion_panel_positions(state_dir, state, positions):
    from .panel_positions import normalize_panel_positions

    normalized = normalize_panel_positions(positions)
    with _STATE_SAVE_LOCK:
        previous = state.companion_panel_positions
        state.companion_panel_positions = normalized
        try:
            save_state(state_dir, state)
        except OSError:
            state.companion_panel_positions = previous
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
    if getattr(cell, "support", None):
        cell.support.invalidate()
    settings_ticket = replay_ticket(state)
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
            published_hint = False
            with _STATE_SAVE_LOCK:
                origin = getattr(payload, "player_handle_origin", None)
                if settings_ticket.current(state) and (origin is None or origin == (state.user_id, state._owner_epoch)):
                    write_player_handle_cache(cfg.state_dir, payload.player_handle or None,
                                              owner=settings_ticket.owner, source="settings")
                    publish_local_hint(state, payload.player_handle)
                    published_hint = True
            health = getattr(getattr(cell, "ui", None), "health", None)
            if health and published_hint:
                health.set_identity(current_identity_source(state, cfg.state_dir))
            if published_hint and not payload.player_handle:
                recovery = getattr(cell, "recovery", None)
                if recovery:
                    recovery.refresh_unknown_identity(force=True)
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
    if payload.close_to_tray is not None:
        state.close_to_tray = payload.close_to_tray is True
    if payload.auto_update_enabled is not None:
        # Hot-applies: the updater reads this flag from state on every
        # poll (``_handle_update_available``'s consent gate), so no
        # restart is needed for the opt-in/opt-out to take effect.
        state.auto_update_enabled = bool(payload.auto_update_enabled)
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
        with _STATE_SAVE_LOCK:
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
        obs_activated = _apply_obs_settings(state, payload, cell, log, state_dir=cfg.state_dir)
    except Exception:
        # A failed opt-in save must not leave the running agent enabled.
        state.replay_capture_enabled = previous_capture_enabled
        raise

    if folders_changed:
        # Save, instant Remove and Auto-detect all land here. The multiplexer
        # updates every sink and the health card's folders row together.
        _show_replay_folders(cell, _discover_replay_folders(cfg, state))
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
    if not obs_activated:
        status_msg += " OBS could not reconnect. Use Test connection and retry."
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
        if not obs_activated:
            status_msg += " OBS could not reconnect. Use Test connection and retry."
    if payload.show_summary and cell.gui is not None and hasattr(cell.gui, "show_settings_status"):
        try:
            cell.gui.show_settings_status(status_msg)
        except Exception:  # noqa: BLE001
            log.exception("show_settings_status_failed")

    if getattr(cell,"ui",None):
        client = getattr(cell, "obs_client", None)
        cell.ui.health.set_obs(state.obs_scene_switch_enabled and not getattr(cell, "no_obs", False)
            and getattr(cell, "live_bridge", None) is not None,
            connected=bool(client and client.is_connected), auth_failed=bool(client and client.auth_failed))
        active_filter=SyncFilter.from_state(preset=state.sync_filter_preset,since_iso=state.sync_filter_since,until_iso=state.sync_filter_until)
        cell.ui.on_filter_label(active_filter.short_label() if active_filter.is_active() else "")
        cell.ui.health.set_auto_update(state.auto_update_enabled)
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
            cell.ui.on_update_available(release.latest,required=update_is_mandatory(release),
                                        failed=phase=="failed")
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
    *, on_source=None,
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
    original_source = on_source
    on_source = lambda _source: _push_identity_source(original_source, current_identity_source(state, cfg.state_dir))
    ticket = replay_ticket(state)
    local_hint = read_settings_hint(cfg.state_dir, ticket.owner)
    if local_hint:
        with _STATE_SAVE_LOCK:
            if ticket.current(state):
                publish_local_hint(state, local_hint)
    try:
        cloud_handle = refresh_player_handle(api, cfg.state_dir,
            owner=ticket.owner,
            current_guard=lambda: ticket.current(state),
            on_profile=lambda profile: publish_owned_toons(state, profile, ticket))
    except Exception:  # noqa: BLE001
        log.exception("player_handle_refresh_unhandled")
        cloud_handle = None
    if not ticket.current(state):
        return None
    if cloud_handle:
        _push_identity_source(on_source, "settings" if local_hint else "cloud")
        log.info("player_handle_resolved source=cloud")
        return cloud_handle

    # 2. Disk cache (cloud was empty / offline / unreachable).
    cached = read_player_handle_cache(cfg.state_dir)
    if cached:
        _push_identity_source(on_source, "settings" if local_hint else "cache")
        log.info("player_handle_resolved source=cache")
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
        _push_identity_source(on_source, "auto_detect")
        try:
            with _STATE_SAVE_LOCK:
                if not ticket.current(state):
                    return None
                write_player_handle_cache(cfg.state_dir, detected)
        except OSError:
            log.warning("player_handle_cache_write_failed_post_autodetect")
        log.info("player_handle_resolved source=auto_detect")
        return detected

    fallback = resolve_player_handle(None)
    if fallback:
        _push_identity_source(on_source, "environment")
        return fallback
    log.warning(
        "player_handle_unresolved — uploads will be skipped until the "
        "user sets battleTag in Settings → Profile or plays a game in "
        "a watched folder so auto-detect has something to scan.",
    )
    _push_identity_source(on_source, "none")
    return None


def _push_identity_source(callback, source):
    if callback:
        try:
            callback(source)
        except Exception:
            pass  # Advisory status cannot interrupt identity resolution.


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
    with _CHECKIN_PREVIEW_RACE_LOCK, _STATE_SAVE_LOCK:
        row = accepted[1] if len(accepted) > 1 and isinstance(accepted[1], dict) else {}
        owner_key = row.get("_uploadAccountKey")
        if owner_key is not None:
            from .session_stats import session_account_key

            api = getattr(cell, "api", None)
            base = getattr(api, "base_url", None)
            token = getattr(api, "device_token", None)
            if (not isinstance(base, str) or not token or token != state.device_token
                    or owner_key != session_account_key(base.rstrip("/"), token)):
                return
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
        streams = getattr(cell, "stream_service", None)
        if streams is not None:
            streams.on_game_accepted(path, game, *accepted)


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
    on_contact=None,
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
        on_contact=on_contact,
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



def _obs_intent(payload):
    operation = getattr(payload, "obs_password_intent", None)
    value = payload.obs_password
    if value is not None and type(value) is not str:
        raise CredentialStorageError("invalid_intent")
    if operation is None:
        operation = "keep" if value is None else "clear" if value == "" else "set"
    if type(operation) is not str or operation not in ("keep", "set", "clear"):
        raise CredentialStorageError("invalid_intent")
    if operation != "set" and value not in (None, ""):
        raise CredentialStorageError("invalid_intent")
    return CredentialIntent(operation, value if operation == "set" else None)


def _obs_credential_metadata(state):
    with _STATE_SAVE_LOCK:
        try:
            revision, status = credential_revision(state, "obs"), credential_status(state, "obs")
        except CredentialStorageError:
            revision, status = None, "unreadable"
    value = os.environ.get("SC2TOOLS_OBS_PASSWORD")
    return revision, status, type(value) is str and len(value) > 0


def _obs_credentials_available(state):
    _revision, status, override = _obs_credential_metadata(state)
    return override or status in ("available", "cleared", "missing")


def _obs_revision_current(state, revision):
    with _STATE_SAVE_LOCK:
        try:
            return credential_revision(state, "obs") == revision
        except CredentialStorageError:
            return False


def _stage_obs_settings(state, payload, cell):
    if (getattr(cell, "no_obs", False) and payload.obs_scene_switch_enabled is True
        and state.obs_scene_switch_enabled is not True):
        raise RuntimeError("Could not enable automatic OBS scene switching while --no-obs is active")
    for name in ("obs_scene_switch_enabled", "obs_host", "obs_website_add_enabled", "obs_switch_on_replays"):
        value = getattr(payload, name)
        if value is not None:
            setattr(state, name, value)
    if payload.obs_port is not None:
        state.obs_port = int(payload.obs_port)
    if payload.obs_scene_map is not None:
        state.obs_scene_map = {str(key): str(value) for key, value in dict(payload.obs_scene_map).items()}
    if payload.obs_switch_debounce_sec is not None:
        state.obs_switch_debounce_sec = max(0.0, float(payload.obs_switch_debounce_sec))


def _stop_obs_runtime(cell, controller, client, log):
    for owner, method, arguments in ((controller, "set_config", {"enabled": False}),
        (controller, "shutdown", {}), (client, "shutdown", {})):
        callback = getattr(owner, method, None) if owner is not None else None
        if callable(callback):
            try:
                callback(**arguments)
            except Exception:
                log.warning("obs_runtime_cleanup_unavailable")
    if getattr(cell, "obs_scene", None) is controller:
        cell.obs_scene = None
    if getattr(cell, "obs_client", None) is client:
        cell.obs_client = None


def _activate_obs_settings(state, cell, log, previous_connection, revision):
    # All OBS, socket and health callbacks run after the durable state lock.
    controller, client = getattr(cell, "obs_scene", None), getattr(cell, "obs_client", None)
    if not _obs_revision_current(state, revision):
        return False
    if getattr(cell, "no_obs", False) or not _obs_credentials_available(state):
        if controller is not None or client is not None:
            _stop_obs_runtime(cell, controller, client, log)
        return not state.obs_scene_switch_enabled or bool(getattr(cell, "no_obs", False))
    connection = _effective_obs_connection(state, log)
    if controller is None:
        if not state.obs_scene_switch_enabled:
            return True
        bridge = getattr(cell, "live_bridge", None)
        if bridge is None:
            log.info("obs_settings_saved_restart_required=true")
            return True
        try:
            client, controller = _build_obs_switcher(state=state, bridge=bridge, log=log,
                no_obs=getattr(cell, "no_obs", False), health=getattr(getattr(cell, "ui", None), "health", None))
            if controller is None:
                return False
            if not _obs_revision_current(state, revision):
                _stop_obs_runtime(cell, controller, client, log)
                return False
            if client is not None:
                client.start()
            if not _obs_revision_current(state, revision):
                _stop_obs_runtime(cell, controller, client, log)
                return False
            controller.start()
            if not _obs_revision_current(state, revision):
                _stop_obs_runtime(cell, controller, client, log)
                return False
        except Exception:
            log.warning("obs_switcher_activation_unavailable")
            _stop_obs_runtime(cell, controller, client, log)
            return False
        cell.obs_client, cell.obs_scene = client, controller
        return True
    try:
        controller.set_config(scene_map=_effective_scene_map(state), enabled=state.obs_scene_switch_enabled,
            debounce_sec=state.obs_switch_debounce_sec, switch_on_replays=state.obs_switch_on_replays)
        if not _obs_revision_current(state, revision):
            return False
        if connection != previous_connection and client is not None:
            host, port, password = connection
            client.reconfigure(host=host, port=port, password=password if password is not None else "")
        return _obs_revision_current(state, revision)
    except Exception:
        log.warning("obs_settings_activation_unavailable")
        _stop_obs_runtime(cell, controller, client, log)
        return False


def _apply_obs_settings(state, payload, cell, log, *, state_dir):
    """Commit Settings before touching shared OBS clients."""
    intent = _obs_intent(payload)
    obs_lock = getattr(cell, "obs_lock", None)
    with (obs_lock if obs_lock is not None else nullcontext()):
        previous_connection = _effective_obs_connection(state)
        with _STATE_SAVE_LOCK:
            # Delivery checks these preferences under the same lock.
            notices = ("notify_milestones", "notify_weekly_report", "notifications_muted")
            names = ("obs_scene_switch_enabled", "obs_host", "obs_port", "obs_scene_map",
                "obs_switch_debounce_sec", "obs_switch_on_replays", "obs_website_add_enabled", *notices)
            previous = {name: dict(getattr(state, name)) if name == "obs_scene_map" else getattr(state, name) for name in names}
            expected = getattr(payload, "obs_credential_revision", None)
            if intent.operation != "keep" and expected is None and getattr(payload, "obs_password_intent", None) is None:
                expected = credential_revision(state, "obs")  # Legacy trusted callers admit now; GUI always supplies its captured revision.
            try:
                for name in notices:
                    value = getattr(payload, name, None)
                    if value is not None:
                        setattr(state, name, value is True)
                _stage_obs_settings(state, payload, cell)
                if intent.operation == "keep":
                    save_state(state_dir, state)
                else:
                    commit_state_credentials(state_dir, state, obs=intent, expected_obs_revision=expected)
            except Exception as error:
                if not (type(error) is CredentialStorageError and error.code == "indeterminate"):
                    for name, value in previous.items():
                        setattr(state, name, value)
                raise
            revision = credential_revision(state, "obs")
            weekly_catch_up = (state.notify_weekly_report and not state.notifications_muted
                               and (not previous["notify_weekly_report"] or previous["notifications_muted"]))
        result = _activate_obs_settings(state, cell, log, previous_connection, revision)
        socket = getattr(cell, "socket_client", None)
        if socket is not None and _obs_revision_current(state, revision):
            try:
                socket.publish_obs_capabilities()
            except Exception:
                log.warning("obs_capability_publication_unavailable")
            if weekly_catch_up and callable(request := getattr(socket, "request_weekly_report", None)):
                request()
        service = getattr(cell, "stream_service", None)
        reader = getattr(service, "reader", None) if service is not None else None
        if reader is not None and previous_connection != _effective_obs_connection(state):
            try:
                reader.close()
            except Exception:
                log.warning("obs_output_reader_retirement_unavailable")
        return result

def _obs_candidate_connection(state, host, port, password, operation, revision):
    """Resolve a private, disposable candidate; this never changes saved state."""
    intent = CredentialIntent(operation, password if operation == "set" else None)
    if type(host) is not str or type(port) is not int or not 1 <= port <= 65535:
        raise CredentialStorageError("invalid_intent")
    with _STATE_SAVE_LOCK:
        if type(revision) is not int or credential_revision(state, "obs") != revision:
            raise CredentialStorageError("conflict")
        status = credential_status(state, "obs")
        saved_password = state.obs_password
    override = os.environ.get("SC2TOOLS_OBS_PASSWORD")
    if intent.operation == "keep" and not override and status not in ("available", "cleared", "missing"):
        raise CredentialStorageError("unavailable")
    candidate = saved_password if intent.operation == "keep" else intent.value if intent.operation == "set" else ""
    return host, port, override or candidate or ""


class _CurrentObsClient:
    """Keep one explicitly approved desktop operation in its original scope."""
    def __init__(self, client, current):
        self._client, self._current = client, current

    def __getattr__(self, name):
        if not self._current():
            raise CredentialStorageError("conflict")
        value = getattr(self._client, name)
        if not callable(value):
            return value
        def invoke(*args, **kwargs):
            if not self._current():
                raise CredentialStorageError("conflict")
            result = value(*args, **kwargs)
            if not self._current():
                raise CredentialStorageError("conflict")
            return result
        return invoke


def _test_obs_candidate(state, host, port, password, operation, revision, log):
    try:
        host, port, effective = _obs_candidate_connection(state, host, port, password, operation, revision)
    except CredentialStorageError:
        return {"ok": False, "message": "OBS credentials changed or are unavailable. Re-enter the password and try again."}
    return _handle_obs_probe(host=host, port=port, password=effective, log=log,
        is_current=lambda: _obs_revision_current(state, revision))


def _handle_obs_probe(*, host: str, port: int, password: str, log: logging.Logger,
    is_current=lambda: True) -> dict:
    """Test one disposable connection, closing it on every completion path."""
    from .live.obs_layout import discover_sources, manual_override_scenes_needing_update
    if not is_current():
        return {"ok": False, "message": "OBS credentials changed. Test the connection again."}
    raw_client = ObsClient(host=host, port=port, password=password or None, subscribe_events=False)
    client = _CurrentObsClient(raw_client, is_current)
    try:
        client.connect_now()
        version = client.get_version()
        scenes = client.refresh_scenes()
        sources = discover_sources(client)
        manual_update_scenes = []
        try:
            manual_update_scenes = manual_override_scenes_needing_update(client)
        except CredentialStorageError:
            raise
        except Exception:
            log.info("obs_manual_override_probe_unavailable")
        if not is_current():
            raise CredentialStorageError("conflict")
        return {"ok": True,
            "message": f"Connected to OBS {version.get('obs_version') or '?'} — {len(scenes)} scene(s) found."
                + (" Your SC2 Tools scenes need a BRB / Starting Soon priority update; use Update my scenes below."
                    if manual_update_scenes else ""),
            "scenes": scenes, "webcams": sources.get("webcam", []), "games": sources.get("game", []),
            "manual_override_update_scenes": manual_update_scenes,
            "generated_update_scenes": [name for name in scenes if name in {SCENE_BETWEEN_GAMES, SCENE_IN_GAME}]}
    except ObsAuthFailed:
        return {"ok": False, "message": "OBS rejected the password. Check OBS → Tools → WebSocket Server Settings → Show Connect Info."}
    except CredentialStorageError:
        return {"ok": False, "message": "OBS credentials changed. Test the connection again."}
    except Exception:
        log.info("obs_probe_unavailable")
        return {"ok": False, "message": "Could not complete the OBS connection test. Check OBS and its WebSocket server settings."}
    finally:
        try:
            raw_client.shutdown()
        except Exception:
            log.warning("obs_probe_cleanup_unavailable")


def _effective_obs_connection(state, log=None):
    with _STATE_SAVE_LOCK:
        saved_host, saved_port, saved_password = state.obs_host, state.obs_port, state.obs_password
    host = os.environ.get("SC2TOOLS_OBS_HOST", "").strip() or saved_host
    port_env = os.environ.get("SC2TOOLS_OBS_PORT", "").strip()
    try:
        port = int(port_env) if port_env else int(saved_port)
    except (TypeError, ValueError):
        if log is not None:
            log.warning("obs_port_invalid falling_back=4455")
        port = 4455
    password = os.environ.get("SC2TOOLS_OBS_PASSWORD") or saved_password or None
    return host, port, password


def _obs_website_scope(cfg, state, cell):
    with _STATE_SAVE_LOCK:
        if (state.obs_website_add_enabled is not True or getattr(cell, "no_obs", False)
                or not state.device_token or not getattr(cell, "gui", None)):
            return None
        token, epoch = state.device_token, getattr(state, "_owner_epoch", None)
        revision = credential_revision(state, "obs")
    if not _obs_credentials_available(state):
        return None
    return (cfg.api_base, token, *_effective_obs_connection(state), revision, epoch)


def _obs_website_controller(cfg, state, cell):
    from .live.obs_website_add import ObsWebsiteAdd
    def client_factory():
        if not _obs_credentials_available(state):
            raise CredentialStorageError("unavailable")
        host, port, password = _effective_obs_connection(state)
        return ObsClient(host=host, port=port, password=password, subscribe_events=False)
    return ObsWebsiteAdd(
        scope=lambda: _obs_website_scope(cfg, state, cell),
        client_factory=client_factory,
        token_provider=lambda: _overlay_token_for_build(cfg, state, logging.getLogger(__name__)),
        confirm=lambda payload: cell.gui.confirm_obs_add_source(payload) if getattr(cell, "gui", None) else False,
        base_url=lambda: _dashboard_url_from_api(cfg.api_base),
    )


def _obs_token_rotation_controller(cfg, state, cell):
    from .live.obs_token_rotation import ObsTokenRotation
    def scope():
        with _STATE_SAVE_LOCK:
            if state.obs_scene_switch_enabled is not True or cell.no_obs or not state.device_token:
                return None
            token, epoch = state.device_token, getattr(state, "_owner_epoch", None)
            revision = credential_revision(state, "obs")
        if not _obs_credentials_available(state):
            return None
        return (cfg.api_base, token, *_effective_obs_connection(state), revision, epoch)
    with cell.obs_lock:
        if cell.obs_token_rotation is None:
            cell.obs_token_rotation = ObsTokenRotation(
                scope=scope,
                api_factory=lambda base, token: ApiClient(base_url=base, device_token=token),
                client_factory=lambda captured: ObsClient(
                    host=captured[2], port=captured[3], password=captured[4], subscribe_events=False),
                base_url=_dashboard_url_from_api,
            )
        return cell.obs_token_rotation


def _handle_obs_build(
    *, cfg: AgentConfig, state: AgentState, request: dict, log: logging.Logger,
) -> dict:
    from .live.obs_game_overlay import OBS_GAME_WRITE_LOCK
    with OBS_GAME_WRITE_LOCK:
        return _handle_obs_build_locked(cfg=cfg, state=state, request=request, log=log)


def _handle_obs_build_locked(
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
    revision = request.get("credential_revision")
    epoch = request.get("owner_epoch")
    scoped = "credential_revision" in request
    if scoped:
        def current():
            return _obs_revision_current(state, revision) and _auth_epoch_current(state, epoch)
        try:
            host, port, password = _obs_candidate_connection(state, request.get("host"), request.get("port"),
                request.get("password"), request.get("password_intent"), revision)
        except CredentialStorageError:
            return {"ok": False, "message": "OBS credentials changed or are unavailable. Test the connection again."}
        if not current():
            return {"ok": False, "message": "The paired account changed. Test the connection again."}
    else:  # Compatibility for trusted callers predating the private GUI contract.
        current = lambda: True
        host, port, password = str(request.get("host") or "127.0.0.1"), int(request.get("port") or 4455), request.get("password")
    token = _overlay_token_for_build(cfg, state, log)
    if not current():
        return {"ok": False, "message": "The paired account changed. Test the connection again."}
    if not token:
        return {
            "ok": False,
            "message": (
                "No overlay token yet. Sign in and pair the agent first "
                "— the backdrop and chat panels need your overlay URL."
            ),
        }

    raw_client = ObsClient(
        host=host,
        port=port,
        password=password or None,
        subscribe_events=False,
    )
    client = _CurrentObsClient(raw_client, current)
    try:
        client.connect_now()
        plan = plan_scenes(
            client,
            overlay_base_url=_dashboard_url_from_api(cfg.api_base),
            overlay_token=token,
            webcam_source=request.get("webcam_source") or None,
            game_source=request.get("game_source") or None,
            during_game_widgets=request.get("during_game_widgets"),
            show_overlay_credit=request.get("show_overlay_credit", True) is True,
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
        added_game_sources: list[str] = []
        additive_update = "during_game_widgets" in request and not rebuild
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
                if additive_update:
                    from .live.obs_game_overlay import add_missing_game_sources
                    added_game_sources = add_missing_game_sources(client, plan, authorized_existing)
                else:
                    repaired = repair_manual_scene_overrides(
                        client, browser_url=manual_url, scene_names=authorized_existing,
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
        chat_alert_audio_owners, chat_alert_role_updates, chat_alert_geometry_updates = [], [], []
        audio_owner, audio_role_updates = None, []
        if not (additive_update and authorized_updates):
            (chat_alert_audio_owners, chat_alert_role_updates,
             chat_alert_geometry_updates) = repair_chat_alert_audio_roles(client, browser_url=manual_url)
            audio_owner, audio_role_updates = repair_broll_audio_roles(client, browser_url=manual_url)
    except SceneBuildError:
        return {"ok": False, "message": "Could not safely build these scenes. Run Test connection, use Update my scenes, or explicitly choose Replace."}
    except CredentialStorageError:
        return {"ok": False, "message": "Settings or the paired account changed. Test the connection again."}
    except Exception:  # noqa: BLE001
        log.warning("obs_scene_build_unavailable")
        return {"ok": False, "message": "Could not finish building OBS scenes. Check OBS and try again."}
    finally:
        try:
            raw_client.shutdown()
        except Exception:
            log.warning("obs_build_cleanup_unavailable")

    if not current():
        return {"ok": False, "message": "Settings or the paired account changed. Test the connection again."}

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
    if added_game_sources:
        outcomes.append("Added during-game sources: " + ", ".join(added_game_sources) + ".")
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
        "scenes": raw_client.scene_names or created,
    }


def _overlay_token_for_build(
    cfg: AgentConfig, state: AgentState, log: logging.Logger,
) -> Optional[str]:
    """Fetch the user's overlay token from the cloud.

    The agent doesn't cache one today — the website owns overlay
    tokens — so this is a live lookup, and it failing is a normal
    "not paired yet" outcome rather than an error.
    """
    with _STATE_SAVE_LOCK:
        token, epoch = state.device_token, getattr(state, "_owner_epoch", None)
    if not token:
        return None
    def current():
        with _STATE_SAVE_LOCK:
            return state.device_token == token and getattr(state, "_owner_epoch", None) is epoch
    try:
        if not current():
            return None
        api = ApiClient(base_url=cfg.api_base, device_token=token, _auth_guard=current)
        getter = getattr(api, "get_overlay_token", None)
        if getter is None or not current():
            return None
        value = getter() or None
        return value if current() else None
    except Exception:  # noqa: BLE001
        log.info("obs_overlay_token_lookup_unavailable")
        return None


def _build_obs_switcher(
    *,
    state: AgentState,
    bridge: Optional[LiveBridge],
    log: logging.Logger,
    no_obs: bool = False,
    health=None,
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
    if health:
        health.set_obs(not no_obs and state.obs_scene_switch_enabled and bridge is not None, connected=False)
    if no_obs:
        log.info("obs_scene_switch_disabled_via_flag")
        return None, None
    if not state.obs_scene_switch_enabled:
        return None, None
    if bridge is None:
        # Nothing publishes phases, so there is nothing to react to.
        log.info("obs_scene_switch_skipped reason=live_bridge_disabled")
        return None, None

    if not _obs_credentials_available(state):
        log.warning("obs_credentials_unavailable")
        return None, None

    host, port, password = _effective_obs_connection(state, log)
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

    def _repair_generated_manual_covers_locked(scope, revision, epoch, connection) -> None:
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
        def current():
            with _STATE_SAVE_LOCK:
                admitted = (state.obs_scene_switch_enabled is True and credential_revision(state, "obs") == revision
                    and getattr(state, "_owner_epoch", None) is epoch)
            return (admitted and client.is_connection_current(scope)
                and _effective_obs_connection(state) == connection)
        repair_host, repair_port, repair_password = client.connection_settings
        if not current() or (repair_host, repair_port, repair_password or None) != connection:
            return
        raw_repair_client = ObsClient(
            host=repair_host,
            port=repair_port,
            password=repair_password,
            subscribe_events=False,
        )
        repair_client = _CurrentObsClient(raw_repair_client, current)
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
            except CredentialStorageError:
                raise
            except Exception:  # noqa: BLE001 - independent repair
                log.warning("obs_vertical_chat_alert_auto_repair_unavailable")

            manual_url = None
            try:
                manual_url = discover_manual_override_url(repair_client)
            except CredentialStorageError:
                raise
            except Exception:  # noqa: BLE001 - independent discovery
                log.warning("obs_manual_override_url_discovery_unavailable")

            audio_identity_url = manual_url
            if audio_identity_url is None:
                try:
                    audio_identity_url = discover_widget_only_broll_url(
                        repair_client,
                    )
                except CredentialStorageError:
                    raise
                except Exception:  # noqa: BLE001 - independent discovery
                    log.warning("obs_broll_url_discovery_unavailable")

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
                except CredentialStorageError:
                    raise
                except Exception:  # noqa: BLE001 - independent repair
                    log.warning("obs_manual_override_auto_repair_unavailable")

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
                except CredentialStorageError:
                    raise
                except Exception:  # noqa: BLE001 - independent repair
                    log.warning("obs_chat_alert_audio_roles_auto_repair_unavailable")

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
                except CredentialStorageError:
                    raise
                except Exception:  # noqa: BLE001 - independent repair
                    log.warning("obs_broll_audio_roles_auto_repair_unavailable")
        except CredentialStorageError:
            log.info("obs_startup_repair_retired")
        except Exception:  # noqa: BLE001
            log.warning("obs_startup_repair_unavailable")
        finally:
            try:
                raw_repair_client.shutdown()
            except Exception:
                log.warning("obs_startup_repair_cleanup_unavailable")

    def _repair_generated_manual_covers() -> None:
        # The token repair and explicit builder/Add paths share these inputs.
        # Inventory and writes must stay in one critical section so a stale
        # startup snapshot cannot restore an old bearer URL after rotation.
        from .live.obs_game_overlay import OBS_GAME_WRITE_LOCK
        scope = client.connection_scope()
        if scope is None:
            return
        with _STATE_SAVE_LOCK:
            revision, epoch = credential_revision(state, "obs"), replay_ticket(state).epoch
        connection = _effective_obs_connection(state)
        if not OBS_GAME_WRITE_LOCK.acquire(timeout=2.0):
            return  # Best effort; the next OBS connection retries startup repair.
        try:
            _repair_generated_manual_covers_locked(scope, revision, epoch, connection)
        finally:
            OBS_GAME_WRITE_LOCK.release()

    client = ObsClient(
        host=host,
        port=port,
        password=password,
        on_connected=_repair_generated_manual_covers,
        on_state=(lambda connected, failed: health.set_obs(state.obs_scene_switch_enabled,
            connected=connected, auth_failed=failed)) if health else None,
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
    """Independent stream workers; title updates wait for live game sync."""
    try:
        from .streaming.service import StreamService

        def obs_settings():
            if not _obs_credentials_available(state):
                raise CredentialStorageError("unavailable")
            host, port, password = _effective_obs_connection(state)
            return {"host": host, "port": port, "password": password}

        from .streaming.cloud_client import CloudStreamingClient

        def stream_connection():
            with _STATE_SAVE_LOCK:
                return cfg.api_base, state.device_token

        def stream_identity():
            with _STATE_SAVE_LOCK:
                return cfg.api_base, state.device_token, state.user_id

        cloud = CloudStreamingClient(stream_connection, identity_provider=stream_identity)
        return StreamService(cfg.state_dir, obs_settings, no_obs=no_obs, cloud_client=cloud)
    except Exception:
        # Do not put credentials, callback URLs or platform responses in the
        # agent logger / crash reporter. Replay sync and switching continue.
        logging.getLogger("sc2tools_agent").warning("stream_controls_unavailable")
        return None


def _make_support_service(cfg, state, cell, stop_event, log_dir):
    from .support_runtime import SupportService
    return SupportService(cfg=cfg, state=state, cell=cell, stop_event=stop_event, log_dir=log_dir,
        discover_folders=_support_folder_provider(cfg, state, cell),
        obs_connection=lambda: _effective_obs_connection(state))


def _support_folder_provider(cfg, state, cell):
    cwd = os.getcwd()
    def discover():
        from .support_probes import FolderRoots
        with _STATE_SAVE_LOCK:
            configured = tuple(state.replay_folders_override[:64])
            complete = len(state.replay_folders_override) <= 64
            explicit = cfg.replay_folder
            excluded = tuple(state.replay_folders_excluded[:64])
            exclusions_complete = len(state.replay_folders_excluded) <= 64 and all(type(value) is str for value in excluded)
            excluded_keys = {os.path.normcase(os.path.normpath(os.path.join(cwd, value)))
                for value in excluded if type(value) is str}
        # Only current, already-reported metadata: never restart the legacy
        # filesystem detector from a diagnostic or clipboard request.
        ui = cell.ui
        facts = ui.health.facts() if ui is not None else None
        reported = facts.folders if facts is not None else None
        automatic_available = type(reported) in (tuple, list)
        complete = complete and exclusions_complete and automatic_available and len(reported) <= 64
        watched = tuple(reported[:64]) if automatic_available else ()
        automatic = (*((explicit,) if explicit is not None else ()), *watched) if exclusions_complete else ()
        filtered = tuple(path for path in automatic if os.path.normcase(os.path.normpath(os.path.join(cwd, os.fspath(path)))) not in excluded_keys)
        candidates = (*configured, *filtered)
        roots, seen = [], set()
        for candidate in candidates:
            path = Path(os.path.normpath(os.path.join(cwd, os.fspath(candidate))))
            key = os.path.normcase(os.path.normpath(str(path)))
            if key not in seen:
                roots.append(path)
                seen.add(key)
            if len(roots) >= 64:
                complete = False
                break
        return FolderRoots(tuple(roots), complete, automatic_available)
    return discover


class _RuntimeCell:
    """Mutable container shared between the GUI thread and the boot
    worker. Kept as a plain class (no dataclass) so it never tries to
    deepcopy the live thread/queue handles."""

    __slots__ = (
        "api", "recovery", "pairing_controls", "activity_gate", "update_scheduler", "stream_service",
        "recent_history", "support",
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
        "obs_token_rotation",
        "no_obs",
        "reanalysis",
    )

    def __init__(self) -> None:
        self.reanalysis = None
        self.recent_history = None
        self.support = None
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
        self.obs_token_rotation = None
        self.no_obs = False


class _Multiplexer:
    """Forward UI events to every wired-up sink (console + tray + gui)."""

    def __init__(
        self,
        console: ConsoleUI,
        tray: Optional[TrayUI] = None,
        gui: Optional[GuiUI] = None,
        *, facts=None, health=None, auth_epoch_guard=None,
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
        self._milestone_notices = None
        self._import_ctl = None
        self._game_notifications = lambda: False
        self._notified_games = []
        self.sync_report = SyncReportTracker()
        self._missing_folders = lambda: ()
        self._identity_refresh = lambda: None
        self._support = None
        self._auth_epoch_guard = auth_epoch_guard
        self._sinks: List[Any] = [console]
        if tray:
            self._sinks.append(tray)
        if gui:
            self._sinks.append(gui)
        # One health monitor next to the status facts. Subscribed before the
        # seed pushes so the first snapshot reaches every sink.
        self.health = health or HealthMonitor()
        for sink in self._sinks:  # one subscriber per sink, so a failing sink never starves another
            callback = getattr(sink, "on_health", None)
            if callback:
                self.health.subscribe(callback)
        seeded = self._status_facts
        self.health.set_phase(seeded.phase)
        self.health.set_pairing(seeded.paired, unlinked=seeded.unlinked)
        self.health.set_paused(seeded.paused, seeded.paused_until)
        if seeded.folders is not None:
            self.health.set_folders(seeded.folders)

    def refresh_status(self):
        self._identity_refresh()
        self._change_status()
        self.health.refresh()

    def on_update_available(self, latest, *, required=False, failed=False):
        for sink in self._sinks:
            callback=getattr(sink,"on_update_available",None)
            if callback: callback(latest)
        self._change_status(update_pending=latest)
        self.health.set_update(latest, required=required, failed=failed)

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
        self.health.set_phase(phase)

    def on_analyzer_probe(self, ok, diag):
        for sink in self._sinks:
            callback = getattr(sink, "on_analyzer_probe", None)
            if callback: callback(ok, diag)
        self._change_status(analyzer_ok=ok, analyzer_diag=diag)
        self.health.set_analyzer(ok, diag)

    def on_paused(self, paused, until=None):
        if self._import_ctl:
            self._import_ctl.set_hold(paused=paused)
        for sink in self._sinks:
            callback = getattr(sink, "on_paused", None)
            if callback: callback(paused, until)
        self._change_status(paused=paused, paused_until=until)
        self.health.set_paused(paused, until)

    def on_folders(self, folders):
        for sink in self._sinks:
            callback=getattr(sink,"set_replay_folders",None)
            if callback: callback(folders)
        self._change_status(folders=list(folders))
        self.health.set_folders(folders, missing=self._missing_folders())

    def on_filter_label(self, label):
        self._change_status(filter_label=label)
        self.health.set_filter_label(label)

    def on_pairing_state(self, state) -> None:
        epoch = getattr(state, "owner_epoch", None)
        if not self._epoch_current(epoch):
            return
        if state.kind in ("requesting", "showing"):
            self._change_status(unlinked=False, paired=False)
            if not self._epoch_current(epoch): return
            self.health.set_pairing(False)
        for sink in self._sinks:
            if not self._epoch_current(epoch): return
            callback = getattr(sink, "on_pairing_state", None)
            if callback:
                callback(state)

    def _epoch_current(self, epoch):
        if self._auth_epoch_guard is None:
            return True
        try:
            return self._auth_epoch_guard(epoch) is True
        except Exception:
            return False

    def _invalidate_support_current(self, epoch):
        if self._support is None:
            return True
        if epoch is None and self._auth_epoch_guard is None:
            self._support.invalidate()
            return True
        method = getattr(type(self._support), "invalidate_for_epoch", None)
        return method(self._support, epoch) is True if callable(method) else self._epoch_current(epoch)

    def on_unlinked(self) -> None:
        if self._auth_epoch_guard is not None:
            return  # Guarded producers must supply their admitted epoch.
        self.on_unlinked_current(None)

    def on_unlinked_current(self, epoch) -> None:
        if not self._epoch_current(epoch) or not self._invalidate_support_current(epoch):
            return
        if not self._epoch_current(epoch): return
        self._change_status(unlinked=True, paired=False)
        if not self._epoch_current(epoch): return
        self.health.set_pairing(False, unlinked=True)
        if self._recent_history:
            if not self._epoch_current(epoch): return
            self._recent_history.refresh()
        for sink in self._sinks:
            if not self._epoch_current(epoch): return
            guarded = getattr(type(sink), "on_unlinked_current", None) if epoch is not None or self._auth_epoch_guard is not None else None
            if callable(guarded):
                guarded(sink, epoch)
            else:
                callback = getattr(sink, "on_unlinked", None)
                if callback: callback()

    def on_connection_state(self, kind, since, next_retry_at, waiting_count) -> None:
        import time
        self.sync_report.connection(kind)
        if kind != "online":
            self.health.set_transport_error(kind)
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
        self.health.set_connection(kind, since, next_retry_at)
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
        if self._auth_epoch_guard is not None:
            return
        self.on_paired_current(user_id, None)

    def on_paired_current(self, user_id: str, epoch) -> None:
        if not self._epoch_current(epoch) or not self._invalidate_support_current(epoch):
            return
        if not self._epoch_current(epoch): return
        self._change_status(paired=True, unlinked=False)
        if not self._epoch_current(epoch): return
        self.health.set_pairing(True)
        if not self._epoch_current(epoch): return
        self.health.set_connection("online")  # a new link retires the old token's signed-out hold
        if self._recent_history:
            if not self._epoch_current(epoch): return
            self._recent_history.refresh()
        for s in self._sinks:
            if not self._epoch_current(epoch): return
            guarded = getattr(type(s), "on_paired_current", None) if epoch is not None or self._auth_epoch_guard is not None else None
            if callable(guarded): guarded(s, user_id, epoch)
            else: s.on_paired(user_id)

    def on_status(self, status: str) -> None:
        for s in self._sinks:
            s.on_status(status)

    def on_upload_success(self, name: str) -> None:
        self.sync_report.upload_succeeded()
        self._identity_refresh()
        self._change_status(last_upload_at=time.time())
        self.health.upload_succeeded()
        if self._offline_since:
            self._recovered_count += 1
        for s in self._sinks:
            s.on_upload_success(name)

    def on_game_synced(self, path, summary, owner_epoch=None):
        owner = summary.get("_owner")
        if self._recent_history and owner != self._recent_history.owner_provider():
            return
        if self._milestone_notices:
            self._milestone_notices.on_game_synced(summary, owner_epoch)
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
        self._push_recent(snapshot)
        for sink in self._sinks:
            callback = getattr(sink, "on_recent_snapshot", None)
            if callback:
                callback(snapshot)

    def _push_recent(self, snapshot):
        """Skip counts, recent unresolved skips and the saved last upload, as the history thread sees them."""
        groups = snapshot.get("skipped") or []
        self.health.set_skipped({group.get("reason"): group.get("count", 0)
                                 for group in groups if isinstance(group, dict)})
        self.health.set_unresolved_skips(
            at.timestamp() for item in snapshot.get("rows") or [] if isinstance(item, dict)
            and item.get("status") == "skipped" and item.get("reason") == "player_unresolved"
            and (at := parse_time(item.get("updatedAt"))) is not None)
        last = parse_time((snapshot.get("facts") or {}).get("lastUploadAt"))
        if last is not None:
            self.health.upload_succeeded(last.timestamp())

    def on_import_progress(self, snapshot):
        if self._auth_epoch_guard is not None:
            return
        self.on_import_progress_current(snapshot, None)

    def on_import_progress_current(self, snapshot, epoch):
        for sink in self._sinks:
            if not self._epoch_current(epoch):
                return
            guarded = getattr(type(sink), "on_import_progress_current", None)
            if callable(guarded):
                guarded(sink, snapshot, epoch)
                continue
            callback = getattr(sink, "on_import_progress", None)
            if callback:
                callback(snapshot)

    def on_upload_failed(self, name: str, reason) -> None:
        if getattr(reason, "counts_as_error", True):
            self.sync_report.upload_failed(getattr(reason, "kind", "unknown"), transient=getattr(reason, "transient", False))
            with self._status_lock:
                self._status_facts.terminal_failure_times.append(time.time())
            self._change_status(latest_failure_title=reason if isinstance(reason,str) else reason.title)
            self.health.upload_failed()
        for s in self._sinks:
            s.on_upload_failed(name, reason)

    def on_pending(self, count: int) -> None:
        self.sync_report.pending(count)
        old=self._status_facts.connection
        self._change_status(pending_count=count, connection=ConnectionFacts(old.kind,count,old.next_retry_at))
        self.health.set_pending(count)
        for s in self._sinks:
            s.on_pending(count)

    def on_replay_archive_status(
        self,
        missing_games: int,
        total_games: int,
    ) -> None:
        self.health.set_archive_status(missing_games, total_games)
        for sink in self._sinks:
            callback = getattr(sink, "on_replay_archive_status", None)
            if callable(callback):
                callback(missing_games, total_games)


__all__ = ["run_agent"]
