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

DEFAULT_DESCRIPTION = "Live StarCraft II games, ranked matches, and practice.\n\nThanks for watching! Join the chat and enjoy the stream."

DEFAULT_CONFIG = {
    "mode": "separate-events", "runtime_enabled": False, "auto_rearm": False,
    "user_approved_separate_events": False, "existing_reusable_keys_confirmed": False,
    "expected_channel_id": "", "streams": {}, "output_names": DEFAULT_OUTPUTS,
    "metadata": {"title": "StarCraft II live", "description": DEFAULT_DESCRIPTION, "vertical_suffix": " | Vertical"},
}
# Automatic channel/key discovery retries after a failure are bounded. After
# the last delay the worker stops retrying until the user refreshes explicitly.
# While a YouTube consent the user just started is still pending, attempts are
# spaced by CONSENT_RETRY_SECONDS and never spend the budget, so the first
# attempt after the consent completes loads the catalog without a click.
CATALOG_RETRY_DELAYS = (15, 60, 180)
CONSENT_RETRY_SECONDS = 15
CONSENT_POLL_SECONDS = 5
CONSENT_POLL_WINDOW = 180
PLATFORM_CHECK_SECONDS = 60
CATALOG_IDLE_MESSAGE = "Connect YouTube to load your channel and reusable keys."
CATALOG_LOADING_MESSAGE = "Loading your YouTube channel and reusable keys…"
PLATFORM_TITLES = {"youtube": "YouTube", "twitch": "Twitch", "kick": "Kick"}


def shared_title(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 70 or any(ord(c) < 32 or c in "<>" for c in value):
        raise ValueError("Use a stream title of 1–70 characters without line breaks or angle brackets.")
    return value.strip()


def discovery_failure_message(http_status, account_mode="sc2tools"):
    """Actionable, provider-free explanation for a failed channel/key discovery."""
    local = account_mode == "local"
    if http_status in {401, 403}:
        if local:
            return "YouTube authorization through your own Google client is missing or expired. Connect YouTube again, then refresh keys."
        return "YouTube stream-control permission is missing or expired. Connect YouTube again in your browser, then refresh connections."
    if http_status == 404 and not local:
        return "This SC2Tools server does not provide YouTube stream controls yet."
    if http_status == 409:
        return "Another YouTube request for this account is still running. Your channel and keys were not loaded yet."
    if http_status == 429:
        return "YouTube request limit reached. Your channel and keys were not loaded yet."
    if local:
        return "Your YouTube channel and reusable keys could not be loaded from YouTube. Existing selections are unchanged."
    return "Your YouTube channel and reusable keys could not be loaded through SC2Tools. Existing selections are unchanged."


class StreamService:
    def __init__(self, state_dir, settings_provider, *, no_obs=False, backend=None,
                 output_reader=None, adapters=None, cloud_client=None, tiktok_studio=None):
        self.directory = Path(state_dir) / "streaming"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.config_path = self.directory / "youtube-button-helper.config.private.json"
        saved_config = self.config_path.exists()
        config = json.loads(self.config_path.read_text(encoding="utf-8")) if saved_config else copy.deepcopy(DEFAULT_CONFIG)
        self.backend = backend or PairBackend(self.directory, config=config)
        self.setup_saved = saved_config or backend is not None
        self.metadata_saved = bool((saved_config and "metadata" in config)
            or self.backend.template_path.exists()
            or self.backend.state.get("metadata_revision", 0) > 0
            or self.backend.state.get("pair")
            or self.backend.metadata.get("description") not in {"", DEFAULT_DESCRIPTION}
            or backend is not None)
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
        self.catalog_status = {"state": "idle", "message": CATALOG_IDLE_MESSAGE, "attempts": 0, "http_status": None, "retry_pending": False}
        self.next_catalog_attempt = 0
        self.catalog_reload_pending = False
        self.consent_poll_until = 0
        self.youtube_consent_until = 0
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
            "metadata": copy.deepcopy(self.backend.metadata), "metadata_saved": self.metadata_saved, "message": self.message,
            "catalog": copy.deepcopy(self.catalog), "configured": bool(self.backend.config.get("runtime_enabled")),
            "catalog_status": copy.deepcopy(self.catalog_status),
            "account_mode": self.account_mode,
            "tiktok": copy.deepcopy(self.tiktok_status),
            "configuration": {"privacy": self.backend.config.get("streams", {}).get("horizontal", {}).get("privacy", "public"),
                "channel_id": self.backend.config.get("expected_channel_id"),
                "horizontal_id": self.backend.config.get("streams", {}).get("horizontal", {}).get("reusable_stream_id"),
                "portrait_id": self.backend.config.get("streams", {}).get("portrait", {}).get("reusable_stream_id"),
                "made_for_kids": self.backend.config.get("streams", {}).get("horizontal", {}).get("made_for_kids"),
                "auto_rearm": self.backend.config.get("auto_rearm", False) if self.setup_saved else None,
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

    def _catalog_rows(self):
        api = self.backend.api
        read = getattr(api, "catalog", None)
        if callable(read):
            value = read()
            return value.get("channel"), value.get("streams")
        channel = api.owned_channel()
        return channel, api.discover_reusable_streams_for_channel(channel["id"])

    def _youtube_catalog(self):
        channel, streams = self._catalog_rows()
        invalid = ValueError("YouTube channel and reusable keys could not be verified. Refresh keys to try again.")
        if not isinstance(channel, dict) or not isinstance(channel.get("id"), str) or not channel["id"] or not isinstance(streams, list):
            raise invalid
        rows = []
        for row in streams:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"]:
                raise invalid
            title = row.get("title") if isinstance(row.get("title"), str) and row.get("title").strip() else "Untitled key"
            public = {"id": row["id"], "title": title, "channel_id": row.get("channel")}
            for field in ("eligible", "selectable", "available", "bound_elsewhere", "bound_broadcast_id", "stream_status"):
                if field in row:
                    public[field] = copy.deepcopy(row[field])
            if isinstance(row.get("status"), dict) and "streamStatus" in row["status"]:
                public["status"] = {"streamStatus": row["status"]["streamStatus"]}
            rows.append(public)
        self.catalog = {
            "channels": [{"id": channel["id"], "title": channel.get("title") if isinstance(channel.get("title"), str) else "YouTube"}],
            "streams": rows,
        }
        title = self.catalog["channels"][0]["title"]
        if not rows:
            message = "No reusable stream keys were found on this channel. Create two in YouTube Studio, then refresh keys."
        elif len(rows) == 1:
            message = "Loaded 1 reusable key for " + title + ". Two distinct keys are needed; create another in YouTube Studio, then refresh keys."
        else:
            message = "Loaded " + str(len(rows)) + " reusable keys for " + title + "."
        self.catalog_status = {"state": "ready", "attempts": 0, "http_status": None, "retry_pending": False, "message": message}
        self.next_catalog_attempt = 0
        self.catalog_reload_pending = False

    def _reset_catalog(self, message=CATALOG_IDLE_MESSAGE):
        self.catalog = {"channels": [], "streams": []}
        self.catalog_status = {"state": "idle", "message": message, "attempts": 0, "http_status": None, "retry_pending": False}
        self.next_catalog_attempt = 0
        self.catalog_reload_pending = False

    def _request_catalog_reload(self):
        """An explicit user action: reload even a loaded catalog and restart the retry budget."""
        self.catalog_reload_pending = True
        self.next_catalog_attempt = 0
        self.catalog_status["attempts"] = 0

    def _discover_youtube(self, *, explicit=False):
        """Load the authorized channel and its reusable keys; never choose any of them.

        Background callers get bounded retries and an actionable status instead
        of an exception. Explicit callers (Refresh keys, Save setup) restart the
        retry budget and receive the same actionable message as a ValueError.
        """
        if not self.backend.connected or self.backend.api is None:
            self._reset_catalog()
            if explicit:
                raise ValueError("Connect YouTube and approve stream-control permission first.")
            return False
        attempts = 0 if explicit else self.catalog_status.get("attempts", 0)
        self.catalog_status = {"state": "loading", "message": CATALOG_LOADING_MESSAGE, "attempts": attempts, "http_status": None, "retry_pending": False}
        self._publish()
        try:
            self._youtube_catalog()
            self._publish()
            return True
        except Exception as error:
            now = time.monotonic()
            status = getattr(error, "http_status", None)
            status = status if type(status) is int and 100 <= status <= 599 else None
            message = discovery_failure_message(status, self.account_mode)
            if now < self.youtube_consent_until and not explicit:
                # The user may still be approving in the browser: keep trying at
                # a steady pace without spending the bounded budget.
                attempts, delay = 1, CONSENT_RETRY_SECONDS
            else:
                attempts += 1
                delay = CATALOG_RETRY_DELAYS[attempts - 1] if attempts <= len(CATALOG_RETRY_DELAYS) else None
            if status == 404:
                delay = None  # A server without stream controls never heals on its own.
            self.next_catalog_attempt = now + delay if delay else float("inf")
            # Earlier names stay visible for a configured account; a never-loaded catalog stays empty.
            self.catalog_status = {"state": "failed", "attempts": attempts, "http_status": status, "retry_pending": bool(delay),
                "message": message + (" Retrying automatically." if delay else " Press Refresh keys to try again.")}
            self._publish()
            if explicit:
                raise ValueError(message) from None
            return False

    def _discovery_due(self, youtube_status):
        """True when a connected account needs its catalog loaded (or reloaded)."""
        if not self.backend.connected or time.monotonic() < self.next_catalog_attempt:
            return False
        if self.catalog_status.get("state") == "loading":
            return False
        if self.catalog_reload_pending or not self.catalog["channels"]:
            return True
        account = youtube_status.get("platformUserId") if isinstance(youtube_status, dict) else None
        return isinstance(account, str) and bool(account) and self.catalog["channels"][0]["id"] != account

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
                self.metadata_saved = True
                self.platform_results = {"youtube": {"ok": result.get("ok", False), "message": " ".join(result.get("messages", []))}}
                for name in ("twitch", "kick"):
                    adapter = self.adapters.get(name)
                    if adapter is None:
                        self.platform_results[name] = {"ok": False, "message": "Account connection required."}
                    else:
                        try:
                            status = adapter.update_title(title)
                            self.platform_status[name] = status
                            verified = status.get("title") == title and status.get("titleVerified") is not False
                            offline = (name == "kick" and status.get("titleStatus") == "accepted_offline"
                                and status.get("accepted") is True and status.get("titleVerified") is False
                                and status.get("title") == title and status.get("connected") is True)
                            messages = {"pending": "Title accepted; confirmation is pending.",
                                "rejected": "Title was rejected. Your account remains connected.",
                                "unverified": "Title request could not be verified. Check the platform before trying again."}
                            message = ("Title verified." if verified else
                                "Title accepted by Kick. Its API hides the title while offline." if offline else
                                messages.get(status.get("titleStatus"), "Title has not been verified."))
                            self.platform_results[name] = {"ok": verified or offline, "message": message,
                                "title_verified": verified, "title_status": status.get("titleStatus", "verified" if verified else "unverified")}
                        except Exception as error:
                            # An inconclusive write/readback is not evidence that
                            # OAuth was revoked. Only explicit authorization loss
                            # clears a previously verified connection.
                            if getattr(error, "connection_invalid", False) is True:
                                self.platform_status[name] = {"platform": name, "connected": False, "reason": "Stream-control permission must be reconnected."}
                            self.platform_results[name] = {"ok": False, "message": "Title request could not be verified. Check the platform before trying again."}
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
                # An explicit check reloads the catalog and restarts the bounded budget.
                self._request_catalog_reload()
                self._refresh_cloud_connections()
                if self.backend.connected:
                    self.backend.reset_poll_backoff()
                self.message = self._connections_message("SC2Tools account connections checked.")
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
                self._discover_youtube(explicit=True)
                self.message = "YouTube connected. Choose the channel and distinct horizontal and vertical keys."
            elif kind == "refresh_keys":
                if not self.backend.connected:
                    self._attach_youtube()
                self._discover_youtube(explicit=True)
                self.message = "Reusable keys refreshed. Keys stay private; this page shows their names."
            elif kind == "fetch_obs_connection":
                # This secret response goes directly to the requesting control.
                # It must never enter a status snapshot, config, or service cache.
                return {"obs_connection": self._obs_connection(payload)}
            elif kind == "configure_youtube":
                self._configure(payload)
            elif kind in {"pause_auto", "resume_auto"}:
                config = copy.deepcopy(self.backend.config)
                config["auto_rearm"] = kind == "resume_auto"
                atomic_json(self.config_path, config)
                self.backend.config = config
                self.setup_saved = True
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

    def _obs_connection(self, payload):
        scope = payload.get("scope")
        if not isinstance(scope, str) or scope not in DEFAULT_OUTPUTS:
            raise ValueError("Choose the horizontal or vertical YouTube destination.")
        channel = self.backend.config.get("expected_channel_id")
        stream_id = self.backend.config.get("streams", {}).get(scope, {}).get("reusable_stream_id")
        if scope not in DEFAULT_OUTPUTS or not self.backend.connected or not self.backend.config.get("runtime_enabled"):
            raise ValueError("Connect YouTube and save the selected reusable keys before fetching OBS connection details.")
        if not isinstance(channel, str) or not channel or not isinstance(stream_id, str) or not stream_id or payload.get("expected_channel_id") != channel or payload.get("stream_id") != stream_id:
            raise ValueError("The selected destination changed. Save its channel and key, then fetch again.")
        try:
            from .cloud_client import validated_obs_connection
            api = self.backend.api
            if self.account_mode == "sc2tools":
                details = api.obs_connection(channel, stream_id)
            else:
                if api.owned_channel()["id"] != channel:
                    raise ValueError("Selected stream ownership changed.")
                # mine=true excludes non-reusable streams. Omit CDN here so
                # only the exact ID read below obtains any ingestion secret.
                choices = api.paginated("liveStreams", {"part": "id,snippet,status", "mine": "true", "maxResults": 50})
                if len([row for row in choices if row.get("id") == stream_id and row.get("snippet", {}).get("channelId") == channel]) != 1:
                    raise ValueError("Selected stream ownership changed.")
                rows = api.streams_by_ids([stream_id])
                if len(rows) != 1 or rows[0].get("id") != stream_id or rows[0].get("snippet", {}).get("channelId") != channel:
                    raise ValueError("Selected stream ownership changed.")
                info = rows[0].get("cdn", {}).get("ingestionInfo", {})
                details = {"stream_id": stream_id, "server_url": info.get("rtmpsIngestionAddress"), "stream_key": info.get("streamName")}
            details = validated_obs_connection(details, stream_id)
            return {"scope": scope, "expected_channel_id": channel, **details}
        except Exception:
            raise ValueError("YouTube OBS connection details could not be verified. Refresh connections and the selected key, then fetch again.") from None

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
        self.setup_saved = True
        self.account_mode = mode
        self.backend.connected = self.backend.writes_enabled = False
        self.backend.api = None
        self.adapters = {}
        self.platform_status = {}
        self.platform_results = {}
        self._reset_catalog()
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
        self._discover_youtube(explicit=True)
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
        self.setup_saved = True
        self.message = "YouTube configured. Prepare session before starting the two Aitum YouTube outputs."

    def _connect_cloud(self, platform):
        if not self.cloud_client:
            raise ValueError("Pair this agent with your SC2Tools account first.")
        import webbrowser
        url = self.cloud_client.connect(platform)
        if not webbrowser.open(url, new=1):
            raise ValueError("The browser could not open. Try connecting again.")
        # Poll quickly for a bounded window so the page picks up the consent
        # result (and, for YouTube, loads the channel and keys) without a click.
        now = time.monotonic()
        self.next_platform_check = now + CONSENT_POLL_SECONDS
        self.consent_poll_until = now + CONSENT_POLL_WINDOW
        if platform == "youtube":
            # Reload the catalog once the new grant is in place; attempts made
            # before the consent completes do not spend the retry budget.
            self.youtube_consent_until = now + CONSENT_POLL_WINDOW
            self._request_catalog_reload()
        self.message = "Complete " + PLATFORM_TITLES[platform] + " authorization in your browser. This page updates automatically once SC2Tools confirms it."

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
        youtube = statuses.get("youtube", {})
        self.backend.connected = youtube.get("streamingReady") is True
        if self.backend.connected:
            self.backend.api = CloudGoogleAPI(self.cloud_client, lambda: self.backend.config.get("expected_channel_id"))
            self.backend.writes_enabled = True
            # Authorization alone leaves the setup dropdowns empty. Load the
            # channel and key names here so a restarted or newly consented
            # account gets an actionable setup screen without an extra click.
            if self._discovery_due(youtube):
                self._discover_youtube()
        elif self.catalog["channels"] or self.catalog_status.get("state") != "idle":
            self._reset_catalog()
        self._publish()

    def _connections_message(self, default):
        if self.backend.connected and self.catalog_status.get("state") == "failed":
            return self.catalog_status["message"]
        if self.backend.connected and self.catalog_status.get("state") == "ready" and not self.backend.config.get("runtime_enabled"):
            return default + " Choose your channel and both reusable keys in YouTube setup, then save."
        return default

    def _connection_flags(self):
        return {
            "youtube": bool(self.backend.connected),
            "twitch": self.platform_status.get("twitch", {}).get("connected") is True,
            "kick": self.platform_status.get("kick", {}).get("connected") is True,
            "catalog_ready": self.catalog_status.get("state") == "ready",
        }

    def _transition_message(self, before, after):
        """Headline for a connection or discovery change observed by a background check."""
        connected = [PLATFORM_TITLES[name] for name in ("youtube", "twitch", "kick") if after[name] and not before[name]]
        lost = [PLATFORM_TITLES[name] for name in ("youtube", "twitch", "kick") if before[name] and not after[name]]
        parts = []
        if connected:
            parts.append(" and ".join(connected) + " connected.")
        if lost:
            parts.append(" and ".join(lost) + " needs to be connected again.")
        if not parts and after["catalog_ready"] and not before["catalog_ready"] and after["youtube"]:
            parts.append("YouTube channel and reusable keys loaded.")
        return self._connections_message(" ".join(parts)) if parts else None

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
        # or OAuth client discovery occurs automatically on app startup; once
        # credentials are attached, read-only channel/key discovery may run.
        with self.operations:
            self._check_tiktok()
            self._publish()
            if self.account_mode == "sc2tools":
                try:
                    self._refresh_cloud_connections()
                    self.message = self._connections_message("SC2Tools streaming connections restored.")
                except Exception as error:
                    self.message = str(error) if isinstance(error, ValueError) else "Reconnect SC2Tools before preparing streams."
                self.next_platform_check = time.monotonic() + PLATFORM_CHECK_SECONDS
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
                    before = self._connection_flags()
                    if self.account_mode == "sc2tools":
                        self._refresh_cloud_connections()
                    else:
                        for platform, adapter in self.adapters.items():
                            self.platform_status[platform] = adapter.public_status()
                    # A consent completed in the browser (or a lost connection)
                    # must replace the headline that asked the user to wait.
                    transition = self._transition_message(before, self._connection_flags())
                    if transition:
                        self.message = transition
                    now = time.monotonic()
                    self.next_platform_check = now + (CONSENT_POLL_SECONDS if now < self.consent_poll_until else PLATFORM_CHECK_SECONDS)
                elif (self.backend.connected and self.catalog_status.get("state") == "failed"
                        and time.monotonic() >= self.next_catalog_attempt):
                    # Bounded automatic retry of a failed discovery; the UI
                    # shows the actionable message until it succeeds.
                    if self._discover_youtube():
                        self.message = self._connections_message("YouTube channel and reusable keys loaded.")
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
            else:
                self._discover_youtube()
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
