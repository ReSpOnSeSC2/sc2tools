"""Top-level agent runner.

Wires together: config → state → API → pairing → uploader → watcher → UI.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from .api_client import ApiClient
from .config import AgentConfig, load_config
from .pairing import ensure_paired
from .state import AgentState, load_state
from .ui import ConsoleUI, TrayUI, can_use_tray
from .uploader.queue import UploadQueue
from .watcher import ReplayWatcher


def run_agent() -> int:
    """Main entry. Returns the process exit code."""
    _configure_logging()
    log = logging.getLogger("sc2tools_agent")

    cfg = load_config()
    state = load_state(cfg.state_dir)
    api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)

    console = ConsoleUI()
    tray: TrayUI | None = None
    if can_use_tray():
        tray = TrayUI(dashboard_url=_dashboard_url_from_api(cfg.api_base))

    stop_event = threading.Event()
    ui = _Multiplexer(console, tray)

    def request_stop() -> None:
        stop_event.set()
        console.request_stop()

    if tray:
        tray.start(on_quit=request_stop)

    log.info("agent_starting api=%s state_dir=%s", cfg.api_base, cfg.state_dir)
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
        # Refresh the API client with the new token.
        api = ApiClient(base_url=cfg.api_base, device_token=state.device_token)
        ui.on_paired(state.user_id or "")

    upload = UploadQueue(
        cfg=cfg,
        state=state,
        api=api,
        on_success=lambda p: ui.on_upload_success(p.name),
        on_failure=lambda p, exc: ui.on_upload_failed(p.name, str(exc)),
    )
    watcher = ReplayWatcher(cfg=cfg, state=state, upload=upload)

    try:
        upload.start()
        watcher.start()
        ui.on_status("watching for replays")
        log.info("agent_ready")
        console.wait_for_exit()
    except KeyboardInterrupt:
        pass
    finally:
        log.info("agent_stopping")
        watcher.stop()
        upload.stop()
        if tray:
            tray.stop()
    return 0


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


class _Multiplexer:
    """Forward UI events to console + tray."""

    def __init__(self, console: ConsoleUI, tray: TrayUI | None) -> None:
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


def _configure_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
