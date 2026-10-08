"""Desktop stream controls, isolated from replay processing and scene switching.

Constructing the service never opens OAuth, sends RTMP, or changes a cloud
broadcast. Account setup and preparation are explicit GUI actions. The worker
only rearms a previously prepared session after both outputs and events end.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import threading
import time

from .obs_reader import OutputReader, DEFAULT_OUTPUTS
from .youtube_pair_backend import PairBackend, atomic_json
from .tiktok_studio import TikTokStudio

DEFAULT_CONFIG = {
    "mode": "separate-events", "runtime_enabled": False, "auto_rearm": False,
    "user_approved_separate_events": False, "existing_reusable_keys_confirmed": False,
    "expected_channel_id": "", "streams": {}, "output_names": DEFAULT_OUTPUTS,
    "metadata": {"title": "StarCraft II live", "description": "", "vertical_suffix": " | Vertical"},
}


def shared_title(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 70 or any(ord(c) < 32 or c in "<>" for c in value):
        raise ValueError("Use a stream title of 1–70 characters without line breaks or angle brackets.")
    return value.strip()


class StreamService:
    def __init__(self, state_dir, settings_provider, *, no_obs=False, backend=None,
                 output_reader=None, adapters=None, cloud_client=None, tiktok_studio=None):
        self.directory = Path(state_dir) / "streaming"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.config_path = self.directory / "youtube-button-helper.config.private.json"
        config = json.loads(self.config_path.read_text(encoding="utf-8")) if self.config_path.exists() else copy.deepcopy(DEFAULT_CONFIG)
        self.backend = backend or PairBackend(self.directory, config=config)
        self.reader = output_reader or OutputReader(settings_provider, disabled=no_obs)
        self.backend.output_reader = self._outputs
        self.cloud_client = cloud_client
        self.account_mode = config.get("account_mode", "sc2tools" if cloud_client else "local")
        self.adapters = adapters or {}
        self.operations = threading.RLock()
        self.snapshot_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.thread = None
        self.catalog = {"channels": [], "streams": []}
        self.message = "Connect YouTube once, choose your two reusable keys, then prepare a session."
        self.platform_results = {}
        self.platform_status = {}
        self.next_platform_check = 0
        self.tiktok_studio = tiktok_studio or TikTokStudio()
        self.next_tiktok_check = 0
        self.tiktok_status = {"installed": None, "running": None, "version": None,
            "virtual_camera_active": None, "main_width": None, "main_height": None,
            "reason": "Check setup to inspect LIVE Studio and your horizontal OBS feed."}
        self.prompt = ""
        self._cached = {}
        self._publish()

    def _publish(self):
        youtube = self.backend.public_status()
        for scope, row in youtube.get("channels", {}).items():
            row["url"] = youtube.get("watch_urls", {}).get(scope)
        platforms = {}
        for name in ("twitch", "kick"):
            adapter = self.adapters.get(name)
            platforms[name] = copy.deepcopy(self.platform_status.get(name)) if name in self.platform_status else {
                "platform": name, "connected": False, "reason": "Connect your streaming account.",
            }
        platforms["tiktok"] = {"platform": "tiktok", "connected": False,
            "reason": "Set title and Go LIVE in LIVE Studio using your horizontal OBS feed."}
        snapshot = {
            "youtube": youtube, "platforms": platforms, "platform_results": copy.deepcopy(self.platform_results),
            "metadata": copy.deepcopy(self.backend.metadata), "message": self.message,
            "catalog": copy.deepcopy(self.catalog), "configured": bool(self.backend.config.get("runtime_enabled")),
            "account_mode": self.account_mode,
            "tiktok": copy.deepcopy(self.tiktok_status),
            "configuration": {"privacy": self.backend.config.get("streams", {}).get("horizontal", {}).get("privacy", "public"),
                "channel_id": self.backend.config.get("expected_channel_id"),
                "horizontal_id": self.backend.config.get("streams", {}).get("horizontal", {}).get("reusable_stream_id"),
                "portrait_id": self.backend.config.get("streams", {}).get("portrait", {}).get("reusable_stream_id"),
                "made_for_kids": self.backend.config.get("streams", {}).get("horizontal", {}).get("made_for_kids"),
                "auto_rearm": self.backend.config.get("auto_rearm", False),
                "output_names": copy.deepcopy(self.backend.config.get("output_names", DEFAULT_OUTPUTS))},
        }
        with self.snapshot_lock:
            self._cached = snapshot
        return copy.deepcopy(snapshot)

    def status(self):
        # The Qt thread reads a cached snapshot, never waits on network/OAuth.
        with self.snapshot_lock:
            result = copy.deepcopy(self._cached)
            result["auth_prompt"] = self.prompt
            return result

    def authorization_prompt(self):
        with self.snapshot_lock:
            return self.prompt

    def _authorization_prompt(self, prompt):
        code = prompt.get("user_code", "") if isinstance(prompt, dict) else ""
        if isinstance(code, str) and 1 <= len(code) <= 32 and all(c.isalnum() or c == "-" for c in code):
            with self.snapshot_lock:
                self.prompt = "Enter Twitch activation code " + code + " in the browser to connect this account."

    def _outputs(self):
        return self.reader(self.backend.config.get("output_names", DEFAULT_OUTPUTS))

    def _attach_youtube(self):
        if self.account_mode == "sc2tools":
            if not self.cloud_client:
                raise ValueError("Pair this agent with your SC2Tools account first.")
            from .cloud_client import CloudGoogleAPI
            statuses = self.cloud_client.statuses()
            if statuses.get("youtube", {}).get("streamingReady") is not True:
                raise ValueError("Connect YouTube and approve stream-control permission first.")
            self.backend.api = CloudGoogleAPI(self.cloud_client, lambda: self.backend.config.get("expected_channel_id"))
            self.backend.writes_enabled = self.backend.connected = True
            self.backend.reset_poll_backoff()
            return
        from .youtube_google_oauth import GoogleAPI, OwnDesktopCredentials
        credentials = OwnDesktopCredentials(self.directory)
        self.backend.api = GoogleAPI(credentials, write_enabled=True)
        self.backend.writes_enabled = True
        self.backend.connected = True
        self.backend.reset_poll_backoff()

    def _youtube_catalog(self):
        api = self.backend.api
        channel = api.owned_channel()
        streams = api.discover_reusable_streams_for_channel(channel["id"])
        self.catalog = {
            "channels": [{"id": channel["id"], "title": channel["title"]}],
            "streams": [{"id": row["id"], "title": row["title"], "channel_id": row["channel"]}
                        for row in streams],
        }

    def action(self, payload):
        with self.operations:
            if self.stop_event.is_set():
                raise ValueError("Stream controls are shutting down.")
            kind = payload.get("action")
            with self.snapshot_lock:
                self.prompt = ""
            if kind == "set_metadata":
                title = shared_title(payload.get("title"))
                description = payload.get("description", self.backend.metadata["description"])
                result = self.backend.dispatch({"action": "set_metadata", "title": title, "description": description})
                if result.get("code") == "metadata_invalid":
                    raise ValueError("Use a description within 4,808 UTF-8 bytes without angle brackets; space is reserved for the horizontal stream link.")
                if result.get("future_template_saved") is False:
                    raise ValueError("The title could not be saved locally. Check free disk space, then try again. Platform titles were not changed.")
                self.platform_results = {"youtube": {"ok": result.get("ok", False), "message": " ".join(result.get("messages", []))}}
                for name in ("twitch", "kick"):
                    adapter = self.adapters.get(name)
                    if adapter is None:
                        self.platform_results[name] = {"ok": False, "message": "Account connection required."}
                    else:
                        try:
                            status = adapter.update_title(title)
                            self.platform_status[name] = status
                            self.platform_results[name] = {"ok": status.get("title") == title, "message": "Title verified." if status.get("title") == title else "Title has not been verified."}
                        except Exception:
                            self.platform_status[name] = {"platform": name, "connected": False, "reason": "Connection could not be verified."}
                            self.platform_results[name] = {"ok": False, "message": "Title was not verified. Check this platform connection."}
                self.platform_results["tiktok"] = {"ok": False, "message": "Copy the title into LIVE Studio."}
                self.message = "Title saved for future YouTube sessions. See each platform below for the current save result."
            elif kind in {"prepare", "recover"}:
                result = self.backend.dispatch({"action": kind}, outputs=self._outputs())
                self.message = " ".join(result.get("messages", []))
            elif kind == "check_tiktok":
                self._check_tiktok()
                self.message = "TikTok setup checked. Verify the camera preview and audio meters in LIVE Studio before Go LIVE."
            elif kind == "launch_tiktok":
                self.tiktok_studio.launch()
                self._check_tiktok()
                self.message = "LIVE Studio launch requested. Select Landscape and OBS Virtual Camera, then verify audio."
            elif kind in {"start_virtual_camera", "stop_virtual_camera"}:
                camera_action = getattr(self.reader, "set_virtual_camera", None)
                if camera_action is None:
                    raise ValueError("OBS virtual-camera controls are unavailable. Check the OBS connection.")
                camera_action(kind == "start_virtual_camera")
                self._check_tiktok()
                self.message = "OBS virtual camera " + ("started. Select Main Output in OBS and check LIVE Studio's landscape preview." if kind == "start_virtual_camera" else "stopped.")
            elif kind in {"use_local_connections", "use_sc2tools_connections"}:
                self._change_account_mode("local" if kind == "use_local_connections" else "sc2tools")
            elif kind == "refresh_accounts":
                self._refresh_cloud_connections()
                if self.backend.connected:
                    self.backend.reset_poll_backoff()
                self.message = "SC2Tools account connections checked."
            elif kind == "import_youtube_client":
                if self.account_mode != "local":
                    raise ValueError("Choose advanced local account setup first.")
                from .youtube_google_oauth import import_desktop_client
                import_desktop_client(payload["path"], self.directory, explicit=True)
                self.message = "Desktop client saved privately. Connect YouTube to authorize your channel."
            elif kind == "connect_youtube":
                if self.account_mode == "sc2tools":
                    self._connect_cloud("youtube")
                    return self._publish()
                from .youtube_google_oauth import authorize_desktop, CLIENT_FILE
                if not (self.directory / CLIENT_FILE).exists():
                    raise ValueError("Import your own Google Desktop OAuth client JSON first.")
                authorize_desktop(self.directory, explicit=True)
                self._attach_youtube()
                self._youtube_catalog()
                self.message = "YouTube connected. Choose the channel and distinct horizontal and vertical keys."
            elif kind == "refresh_keys":
                if not self.backend.connected:
                    self._attach_youtube()
                self._youtube_catalog()
                self.message = "Reusable keys refreshed. Keys stay private; this page shows their names."
            elif kind == "configure_youtube":
                self._configure(payload)
            elif kind in {"pause_auto", "resume_auto"}:
                config = copy.deepcopy(self.backend.config)
                config["auto_rearm"] = kind == "resume_auto"
                atomic_json(self.config_path, config)
                self.backend.config = config
                self.message = "Automatic next-session preparation is " + ("enabled. Prepare the first session if it is not already armed." if config["auto_rearm"] else "paused.")
            elif kind in {"connect_twitch", "connect_kick"}:
                try:
                    if self.account_mode == "sc2tools":
                        self._connect_cloud(kind.removeprefix("connect_"))
                    else:
                        self._connect_title_platform(kind.removeprefix("connect_"), payload)
                finally:
                    with self.snapshot_lock:
                        self.prompt = ""
            else:
                raise ValueError("This stream action is unavailable.")
            return self._publish()

    def _change_account_mode(self, mode):
        if mode == "sc2tools" and not self.cloud_client:
            raise ValueError("SC2Tools account connections are unavailable in this agent session.")
        if self.backend.state.get("pair"):
            try:
                self.backend.verify_future_configuration(self.backend.config, self._outputs())
            except Exception:
                raise ValueError("Finish both broadcasts, stop both outputs and verify the current account before changing connection setup.") from None
        config = copy.deepcopy(self.backend.config)
        config["account_mode"] = mode
        atomic_json(self.config_path, config)
        self.backend.config = config
        self.account_mode = mode
        self.backend.connected = self.backend.writes_enabled = False
        self.backend.api = None
        self.adapters = {}
        self.platform_status = {}
        self.platform_results = {}
        self.catalog = {"channels": [], "streams": []}
        self.next_platform_check = 0
        self.message = ("Advanced local account setup enabled. Import an OAuth client you own." if mode == "local"
                        else "SC2Tools account setup enabled. Refresh connections or connect your streaming accounts.")

    def _check_tiktok(self):
        try:
            local = self.tiktok_studio.status()
        except Exception:
            local = {"installed": None, "running": None, "version": None}
        camera_reader = getattr(self.reader, "virtual_camera_status", None)
        try:
            camera = camera_reader() if camera_reader else {}
        except Exception:
            camera = {}
        self.tiktok_status = {**local,
            "virtual_camera_active": camera.get("virtual_camera_active"),
            "main_width": camera.get("main_width"), "main_height": camera.get("main_height"),
            "reason": camera.get("reason", "Check the agent's OBS connection settings.")}
        if local.get("installed") is False:
            self.tiktok_status["reason"] = "Install TikTok LIVE Studio from TikTok, then check setup again."
        self.next_tiktok_check = time.monotonic() + 30

    def _configure(self, payload):
        if not self.backend.connected:
            raise ValueError("Connect YouTube first.")
        if any(value is not False for value in self._outputs().values()):
            raise ValueError("Connect OBS and stop both YouTube outputs before changing keys.")
        self._youtube_catalog()
        channel = payload.get("channel_id")
        selected = [payload.get("horizontal_id"), payload.get("portrait_id")]
        if channel not in {row["id"] for row in self.catalog["channels"]} or not all(selected) or selected[0] == selected[1]:
            raise ValueError("Choose your authorized channel and two different reusable stream keys.")
        for selected_id in selected:
            if len([row for row in self.catalog["streams"] if row["id"] == selected_id and row["channel_id"] == channel]) != 1:
                raise ValueError("A selected reusable key does not belong to this channel.")
        privacy = payload.get("privacy")
        if privacy not in {"private", "unlisted", "public"} or not isinstance(payload.get("made_for_kids"), bool):
            raise ValueError("Choose visibility and the audience setting.")
        names = payload.get("output_names", DEFAULT_OUTPUTS)
        if not isinstance(names, dict) or any(not isinstance(names.get(scope), str) or not names[scope].strip() for scope in DEFAULT_OUTPUTS) or names["horizontal"] == names["portrait"]:
            raise ValueError("Choose two different OBS output names.")
        config = copy.deepcopy(self.backend.config)
        config.update(expected_channel_id=channel, runtime_enabled=True,
            account_mode=self.account_mode,
            user_approved_separate_events=True, existing_reusable_keys_confirmed=True,
            auto_rearm=payload.get("auto_rearm") is True, output_names=names)
        config["streams"] = {scope: {"reusable_stream_id": selected_id, "privacy": privacy,
            "made_for_kids": payload["made_for_kids"]} for scope, selected_id in zip(DEFAULT_OUTPUTS, selected)}
        if self.backend.state.get("pair"):
            try:
                self.backend.verify_future_configuration(config, self._outputs())
            except Exception:
                raise ValueError("Finish both YouTube broadcasts and stop both outputs before changing future visibility. The current channel and keys are preserved.") from None
        atomic_json(self.config_path, config)
        self.backend.config = config
        self.message = "YouTube configured. Prepare session before starting the two Aitum YouTube outputs."

    def _connect_cloud(self, platform):
        if not self.cloud_client:
            raise ValueError("Pair this agent with your SC2Tools account first.")
        import webbrowser
        url = self.cloud_client.connect(platform)
        if not webbrowser.open(url, new=1):
            raise ValueError("The browser could not open. Try connecting again.")
        self.next_platform_check = time.monotonic() + 5
        self.message = "Complete " + platform.title() + " authorization in your browser, then refresh connections."

    def _refresh_cloud_connections(self):
        if self.account_mode != "sc2tools" or not self.cloud_client:
            raise ValueError("SC2Tools account connections are unavailable in local setup.")
        from .cloud_client import CloudGoogleAPI, CloudTitleAdapter
        try:
            statuses = self.cloud_client.statuses()
        except Exception:
            self.backend.connected = False
            self.platform_status = {name: {"connected": False, "reason": "SC2Tools connection could not be verified."} for name in ("twitch", "kick")}
            self._publish()
            raise
        for platform in ("twitch", "kick"):
            row = statuses.get(platform, {})
            self.platform_status[platform] = {**row, "connected": row.get("streamingReady") is True}
            self.adapters[platform] = CloudTitleAdapter(self.cloud_client, platform)
        self.backend.connected = statuses.get("youtube", {}).get("streamingReady") is True
        if self.backend.connected:
            self.backend.api = CloudGoogleAPI(self.cloud_client, lambda: self.backend.config.get("expected_channel_id"))
            self.backend.writes_enabled = True

    def _connect_title_platform(self, platform, payload):
        from .title_platforms import connect_twitch, connect_kick, load_adapter
        client_id = payload.get("client_id")
        expected = payload.get("expected_account")
        if not isinstance(client_id, str) or not client_id.strip() or not isinstance(expected, str) or not expected.strip():
            raise ValueError("Enter your own app client ID and the streaming account name to verify.")
        client = {"platform": platform, "ownership": "own-app", "client_id": client_id.strip()}
        if platform == "twitch":
            client["client_type"] = "public"
            connect_twitch(client, self.directory, explicit=True, expected_login=expected.strip(), on_prompt=self._authorization_prompt)
        else:
            secret = payload.get("client_secret")
            if not isinstance(secret, str) or not secret:
                raise ValueError("Enter the client secret for your own Kick OAuth app.")
            client.update(client_secret=secret, redirect_uri="http://localhost:8768/oauth/kickcallback")
            connect_kick(client, self.directory, explicit=True, expected_login=expected.strip())
        self.adapters[platform] = load_adapter(platform, self.directory, write_enabled=True)
        self.platform_status[platform] = self.adapters[platform].public_status()
        with self.snapshot_lock:
            self.prompt = ""
        self.message = platform.title() + " connected. Save title to apply and verify the current stream title."

    def start(self):
        if self.thread and self.thread.is_alive():
            return
        self.stop_event.clear()
        self.thread = threading.Thread(target=self._run, name="sc2tools-streams", daemon=True)
        self.thread.start()

    def _run(self):
        # Reconnect only credentials created by this feature. No consent flow
        # or client discovery occurs automatically on app startup.
        with self.operations:
            self._check_tiktok()
            self._publish()
            if self.account_mode == "sc2tools":
                try:
                    self._refresh_cloud_connections()
                    self.message = "SC2Tools streaming connections restored."
                except Exception as error:
                    self.message = str(error) if isinstance(error, ValueError) else "Reconnect SC2Tools before preparing streams."
                self.next_platform_check = time.monotonic() + 60
                self._publish()
            else:
                self._restore_local_connections()
        while not self.stop_event.wait(2):
            if not self.operations.acquire(blocking=False):
                continue
            try:
                if time.monotonic() >= self.next_tiktok_check:
                    self._check_tiktok()
                if self.backend.connected and self.backend.config.get("runtime_enabled"):
                    result = self.backend.runtime_tick(self._outputs())
                    if not result.get("ok", False):
                        self.message = " ".join(result.get("messages", []))
                if time.monotonic() >= self.next_platform_check:
                    if self.account_mode == "sc2tools":
                        self._refresh_cloud_connections()
                    else:
                        for platform, adapter in self.adapters.items():
                            self.platform_status[platform] = adapter.public_status()
                    self.next_platform_check = time.monotonic() + 60
                self._publish()
            except Exception:
                self.message = "Stream status could not be verified. Existing sessions are preserved."
                self.next_platform_check = time.monotonic() + 30
                self._publish()
            finally:
                self.operations.release()

    def _restore_local_connections(self):
        from .title_platforms import load_adapter
        for platform in ("twitch", "kick"):
            if platform not in self.adapters:
                try:
                    self.adapters[platform] = load_adapter(platform, self.directory, write_enabled=True)
                except Exception:
                    pass
            if platform in self.adapters:
                self.platform_status[platform] = self.adapters[platform].public_status()
        self.next_platform_check = time.monotonic() + 60
        if self.backend.config.get("runtime_enabled"):
            try:
                self._attach_youtube()
                self.message = "YouTube session automation restored."
            except Exception:
                self.message = "Reconnect YouTube before preparing another session."
        self._publish()

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=4)
        # A bounded cloud call may still be unwinding. Do not release the
        # lifecycle lock while a worker can still modify the tracked pair.
        if self.operations.acquire(timeout=4):
            try:
                self.reader.close()
                self.backend.close()
            finally:
                self.operations.release()
