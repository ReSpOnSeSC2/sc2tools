"""Persistent agent state (pairing token, last-uploaded cursor, GUI prefs).

State lives in a single JSON file inside the per-user state dir. We
write atomically (write->fsync->rename) to match the project's wider
data-write protocol.

Credentials are runtime-only fields. A versioned selector in agent.json
chooses immutable encrypted generations. Ordinary loads are read-only and
ordinary saves preserve selected credentials; legacy migration is explicit
and requires the acquired instance guard. Older binaries do not understand
the selector, so downgrade/recovery requires a complete backup or re-pairing.
"""

from __future__ import annotations

import base64
import binascii
import os
import time
import threading
from dataclasses import dataclass, field, asdict, replace
from pathlib import Path
from typing import Dict, List, Optional
from .companion_modes import normalize_modes

STATE_FILENAME = "agent.json"
COMPANION_SKINS = frozenset({"default", "protoss", "terran", "zerg"})

# Every subsystem shares one mutable AgentState and persists the whole object.
# Atomic replace protects readers from partial JSON, but without writer
# serialization an older snapshot can replace a newer settings save after it.
# Keep snapshot + fsync + replace in one process-wide critical section so the
# last state mutation to call save_state is also the last durable write.
_STATE_SAVE_LOCK = threading.RLock()
UNCHANGED = object()


@dataclass(frozen=True, repr=False)
class _CredentialContext:
    mode: str
    raw: object
    snapshot: object
    storage: object
    crypto: object
    directory: Path


@dataclass(frozen=True, repr=False)
class _PendingCredentials:
    device: object
    obs: object
    prepared: object


@dataclass
class AgentState:
    """Mutable per-installation state."""

    device_token: Optional[str] = field(default=None, repr=False)
    user_id: Optional[str] = None
    paired_at: Optional[str] = None
    uploaded: Dict[str, str] = field(default_factory=dict)
    """Map of replay file path -> ISO timestamp it was uploaded."""

    path_by_game_id: Dict[str, str] = field(default_factory=dict)
    """Reverse lookup: cloud gameId -> local replay file path. Lets the
    Socket.io recompute handlers translate a gameId-keyed request from
    the cloud back into a file the watcher can re-parse without us
    having to walk every replay on disk. Populated incrementally on
    every successful upload; survives restarts (it's persisted to the
    same agent.json the rest of the state lives in)."""

    tray_hint_shown: bool = False
    close_without_tray: Optional[str] = None
    paused_until: Optional[float] = None
    background_import_speed: Optional[str] = None
    pause_history_in_game: bool = True
    pause_on_battery: bool = False
    update_pending_version: Optional[str] = None
    update_first_seen_at: Optional[float] = None
    update_snoozed_until: Optional[float] = None
    last_run_version: Optional[str] = None

    paused: bool = False
    """When True the watcher keeps observing but the upload queue is
    drained without sending - flipped by the tray/GUI "Pause syncing"
    action and persisted across restarts."""

    replay_folder_override: Optional[str] = None
    """Legacy single-folder override. Kept for back-compat with state
    files written by 0.3.x. New code reads/writes ``replay_folders_override``
    instead and migrates this field forward at load time."""

    replay_folders_override: List[str] = field(default_factory=list)
    """Replay folders the user added on top of the detected ones. Each
    entry is watched recursively, so a region/account-level path catches
    every Multiplayer subfolder underneath it.

    Detected folders are always merged in (``replay_finder.
    watched_replay_folders``), including toon folders SC2 creates while
    the agent runs, such as a first PTR game's. Until 0.17.6 a Settings
    Save stored the whole list here and replaced detection for good, so
    older state files may also list detected folders; the merge
    de-duplicates them and the next Save drops them from this list."""

    replay_folders_excluded: List[str] = field(default_factory=list)
    """Detected replay folders the user removed in Settings. They stay
    unwatched until the user adds them back (Auto-detect or Add folder…)
    or saves an empty list, which resets the agent to detection alone."""

    # ---- GUI preferences (introduced with the PySide6 main window) ----

    window_geometry: Optional[str] = None
    window_information_layout: str = "standard"
    window_page: Optional[str] = None
    companion_skin: str = "default"
    companion_animations: bool = True
    companion_session_enabled: bool = False

    api_base_override: Optional[str] = None
    """If set, takes precedence over the ``SC2TOOLS_API_BASE`` env var
    on next start. Editable from the GUI Settings tab so non-technical
    users never have to touch a .env file. Cleared by saving an empty
    string in the GUI."""

    log_level_override: Optional[str] = None
    """If set, used as the root log level on next start. Editable from
    the GUI Settings tab. Recognised values: DEBUG, INFO, WARNING,
    ERROR. Anything else is ignored at load time."""

    autostart_enabled: bool = False
    """Mirrors the Windows HKCU\\...\\Run registry entry. Stored in
    state so the GUI can show the current value without doing a
    registry probe on every render."""

    start_minimized: bool = False
    """When True, the GUI starts hidden - only the tray icon shows.
    Useful when the agent is set to launch on login."""

    notify_every_game: bool = False
    notifications_muted: bool = False
    close_to_tray: bool = True
    """Opt-in local notification for newly synced live games; never history imports."""

    companion_preferences: Dict[str, bool] = field(default_factory=dict)
    """Native Companion panel and speech switches. Missing switches default to off."""

    companion_modes: Dict[str, object] = field(default_factory=dict)
    """Local presentation profiles and optional global hide/show shortcut."""

    companion_ghost: Dict[str, object] = field(default_factory=dict)
    """Local Ghost targets by matchup and the independent enabled switch."""

    parse_concurrency_override: Optional[int] = None
    """How many parse threads the watcher's ThreadPoolExecutor runs.
    None = use the config default (4). The Settings tab exposes this
    so users on weaker hardware can drop it to 1, and users with a
    big backfill on a strong CPU can raise it to 8 or 16. Persisted
    here (rather than only as an env var) so a GUI change survives
    restarts without the user re-typing it.

    Capped at ``PARSE_CONCURRENCY_USEFUL_MAX`` (12) on save and
    on bootstrap-promote-to-env — past that ceiling the upload
    pipeline becomes the bottleneck, so additional parsers just
    sit idle. Users with a stale 32 from before the v0.5.8 cap
    get auto-clamped on next agent boot."""

    upload_concurrency_override: Optional[int] = None
    """How many parallel upload worker threads drain the queue. None
    = use the config default (2 in v0.5.8+). The Settings tab exposes
    this; the slider caps at ``UPLOAD_CONCURRENCY_USEFUL_MAX`` (4)
    because the cloud's 120 req/min rate limit means 4 workers ≈
    full budget on a typical home connection — more would just
    cause 429 retries that settle at the same average throughput.
    Persisted here so the choice survives restarts."""

    upload_batch_size_override: Optional[int] = None
    """How many games to pack into one ``POST /v1/games`` request.
    None = use the config default (40 in v0.5.8+). Bigger batches
    deliver more games per rate-limit-budget unit; the practical
    ceiling is the cloud's 5 MB body limit. Slider caps at
    ``UPLOAD_BATCH_SIZE_USEFUL_MAX`` (50). Persisted here so the
    choice survives restarts."""

    last_known_mmr: Optional[int] = None
    """Sticky cache of the most recently extracted streamer MMR.
    Pinged to the cloud profile via ``POST /v1/me/last-mmr`` after
    every successful replay parse, so the session widget can fall
    back to a real number even when no game in the user's cloud
    history carries ``myMmr``. Survives restarts so a brief offline
    period (or a re-sync of older replays) doesn't blank the value
    we already paid an HTTP round-trip to set."""

    last_known_mmr_date_iso: Optional[str] = None
    """Game-date of the replay that produced ``last_known_mmr`` (ISO
    string). Used to gate-keep the cloud ping during a backfill: we
    only push when a newly-parsed replay is more recent than what
    we already pushed, otherwise re-syncing 12k old replays would
    reset the sticky MMR to whatever the streamer's rating was three
    seasons ago."""

    last_known_mmr_region: Optional[str] = None
    """Short region label (NA/EU/KR/CN/SEA) inferred from the
    streamer's toon-handle byte at extraction time. Pushed to the
    cloud alongside ``last_known_mmr`` so the overlay's region label
    stays accurate even when SC2Pulse is unreachable."""

    setup_pending: bool = False
    """Desktop setup began before linking and still needs an import choice."""

    setup_completed_at: Optional[float] = None
    """Unix time of setup completion or a pre-wizard linked-device migration."""

    sync_filter_preset: Optional[str] = None
    """Date-range filter the watcher applies before uploading a parsed
    replay. Mirrors the website's date presets so the agent and web
    speak the same vocabulary:

      * ``None`` / ``"all"``   — no filter (default)
      * ``"current_season"``    — replays played this ladder season
      * ``"last_30_days"``      — replays played today or during the prior 29 UTC dates
      * ``"season:67"``         — replays from a specific season number
      * ``"custom"``            — bounded by ``sync_filter_since`` /
                                  ``sync_filter_until``

    Without a filter set, the agent uploads every parseable replay it
    finds. With a filter, replays outside the window are marked
    ``"filtered"`` in ``state.uploaded`` so future sweeps don't
    re-parse them. The runner clears those entries when the filter
    changes so the next sweep re-evaluates against the new window."""

    sync_filter_since: Optional[str] = None
    """Lower bound for ``sync_filter_preset="custom"`` (YYYY-MM-DD or
    full ISO). Ignored for non-custom presets."""

    sync_filter_until: Optional[str] = None
    """Upper bound for ``sync_filter_preset="custom"`` (YYYY-MM-DD or
    full ISO). Ignored for non-custom presets."""

    release_seen: Dict[str, str] = field(default_factory=dict)
    """Update channel -> latest version the updater has already
    announced. Used to avoid re-notifying every poll. Earlier versions
    stored this as ``_release_seen_<channel>`` markers inside
    ``uploaded`` — those are migrated out at load time because
    ``count_synced`` counted them as synced replays."""

    auto_update_enabled: bool = True
    """When False, the updater only notifies about new releases instead
    of downloading + launching the installer. Ignored (treated as True)
    when the running version is below the feed's minSupportedVersion —
    a build the cloud no longer supports must update to keep working."""

    replay_capture_enabled: bool = False
    """Automatically capture new and re-synced replays with StarCraft II.
    Defaults off; an existing explicit opt-in remains enabled on upgrade.
    Manual website requests grant permission for only their requested replay.
    Existing recordings can be reused without starting StarCraft II.
    """

    # ---- OBS scene switching (see live/obs_scene.py) ----

    obs_scene_switch_enabled: bool = False
    """Master gate for automatic OBS scene switching. Opt-in by
    design — the agent must never start driving somebody's OBS
    because they installed an update."""

    obs_host: str = "127.0.0.1"
    """Host running obs-websocket. Stays localhost for the common
    single-PC setup; a two-PC streamer (SC2 on the gaming rig, OBS on
    the stream rig) points this at the stream PC's LAN address."""

    obs_port: int = 4455
    """obs-websocket v5 port. v4's 4444 is not supported — that
    protocol was removed from OBS in 28.0 and authenticates
    differently."""

    obs_password: Optional[str] = field(default=None, repr=False)
    """obs-websocket server password.

    Runtime only: central state snapshots never serialize this value.
    The installation-local encrypted slot is independent of cloud relinking.
    ``SC2TOOLS_OBS_PASSWORD`` remains a runtime override and is never migrated.
    The historical plaintext ADR 0021 needs superseding at activation."""

    obs_scene_map: Dict[str, str] = field(default_factory=dict)
    """Live-bridge phase → OBS scene name.

    Keys are ``LiveLifecyclePhase`` values (``idle``, ``menu``,
    ``match_loading``, ``match_started``, ``match_in_progress``,
    ``match_ended``). An absent key or an empty value means "leave the
    scene alone for this phase", so a streamer who only wants an
    in-game and a between-games scene simply leaves the rest blank.
    Empty dict = use ``obs_scene.DEFAULT_SCENE_MAP``."""

    obs_switch_debounce_sec: float = 3.0
    """Seconds a leaving phase (``idle`` / ``menu``) must persist
    before the scene actually changes. Guards against a dropped
    localhost:6119 poll or an alt-tab yanking the layout mid-game.
    Entering a match is never debounced."""

    obs_website_add_enabled: bool = False
    """Website OBS requests require opt-in AND a separate local confirmation."""

    obs_switch_on_replays: bool = False
    """When False (the default) watching a replay does not trigger the
    in-game scene, even though replay playback reports the same
    lifecycle phases a real match does."""

    obs_transition_name: Optional[str] = None
    """Optional OBS transition to select before each switch. ``None``
    leaves whatever the streamer configured in OBS alone, which is
    almost always what they want."""

    obs_transition_duration_ms: Optional[int] = None
    """Optional transition duration override, paired with
    ``obs_transition_name``."""

    # ---- Build check-in cards (see build_checkin/) ----

    build_checkin_intro_seen: bool = False
    """True once the player dismissed the cards' first-run explainer.
    The check-in preferences themselves live in the cloud
    (``buildCheckin``), so they follow the account, not this PC."""

    build_checkin_card_positions: Dict[str, List[int]] = field(
        default_factory=dict,
    )
    """Where the player dragged each check-in card: ``"loading"`` /
    ``"postgame"`` → ``[x, y]`` in logical screen pixels. Absent means
    the default spot beside the game."""

    build_checkin_prefs: Optional[Dict[str, bool]] = None
    # Scouting visibility is local to this PC; cloud check-in switches retain
    # their three-boolean contract for older web and desktop clients.
    show_scouting_at_loading: bool = False
    """The last ``buildCheckin`` preference the server confirmed
    (``enabled`` / ``askAtLoading`` / ``askAfterGame``). The cloud stays
    the source of truth; this copy only decides the cards while the
    first read of a session has not answered (offline at login)."""

    # Appended to preserve existing positional AgentState constructor fields.
    last_known_race: Optional[str] = None
    last_known_race_at: Optional[str] = None
    companion_panel_positions: Dict[str, List[int]] = field(default_factory=dict)

    @property
    def is_paired(self) -> bool:
        return bool(self.device_token)


def count_synced(state: AgentState) -> int:
    """Number of replays successfully uploaded to the cloud.

    Counts only dated entries in ``state.uploaded`` — the sentinel
    values (``"filtered"``, ``"rejected"``, ``"skipped"`` /
    ``"skipped:<reason>"``) mark files the agent deliberately did NOT
    ship, so they must not inflate the dashboard's "Synced" stat.

    Thread-tolerant: the uploader and watcher mutate ``state.uploaded``
    from worker threads while the GUI calls this on repaint. CPython
    raises ``RuntimeError`` if the dict resizes mid-iteration, so we
    retry a few times; a transient miss just means the stat updates on
    the next repaint.
    """
    for _ in range(5):
        try:
            return sum(
                1
                for k, v in state.uploaded.items()
                # Underscore-prefixed keys are internal markers, not
                # replay paths (e.g. the legacy _release_seen_<channel>
                # entries written by pre-0.14 updaters).
                if isinstance(k, str)
                and not k.startswith("_")
                and isinstance(v, str)
                and v not in ("filtered", "rejected")
                and not v.startswith("skipped")
            )
        except RuntimeError:
            continue
    return 0


def _credential_backends(state_dir, storage=None, crypto=None, *, create=False):
    from .agent_credentials_windows import CurrentUserCrypto, WindowsCredentialStorage
    if storage is None:
        storage = WindowsCredentialStorage(state_dir)
        if create:
            storage.ensure_state_directory()
    return storage, CurrentUserCrypto() if crypto is None else crypto


def _state_directory(value):
    from .agent_credentials import CredentialStorageError
    if type(value) not in (str, type(Path())):
        raise CredentialStorageError("unsafe_path")
    return Path(os.path.abspath(os.fspath(value)))


def _context_from_snapshot(directory, snapshot, storage, crypto):
    from .agent_credentials import _document
    mode = snapshot.status
    if mode == "unreadable" and snapshot.raw is not None:
        try:
            document = _document(snapshot.raw)
        except Exception:
            document = None
        if document is not None and "credentials" not in document:
            mode = "legacy"
    return _CredentialContext(mode, snapshot.raw, snapshot, storage, crypto, directory)


def _read_context(state_dir, storage=None, crypto=None):
    from .agent_credentials import CredentialStorageError, _document, load_credentials
    directory = _state_directory(state_dir)
    if storage is not None:
        storage, crypto = _credential_backends(directory, storage, crypto)
        return _context_from_snapshot(directory, load_credentials(storage, crypto), storage, crypto)
    try:
        encoded = (directory / STATE_FILENAME).read_bytes()
    except FileNotFoundError:
        return _CredentialContext("missing", None, None, None, None, directory)
    except OSError:
        return _CredentialContext("unreadable", None, None, None, None, directory)
    try:
        document = _document(encoded)
    except CredentialStorageError:
        return _CredentialContext("unreadable", encoded, None, None, None, directory)
    if "credentials" not in document:
        return _CredentialContext("legacy", encoded, None, None, None, directory)
    try:
        storage, crypto = _credential_backends(directory, storage, crypto)
        snapshot = load_credentials(storage, crypto)
    except CredentialStorageError:
        return _CredentialContext("unreadable", encoded, None, None, None, directory)
    return _context_from_snapshot(directory, snapshot, storage, crypto)


def _from_context(context):
    from .agent_credentials import CredentialStorageError, _document
    try:
        raw = _document(context.raw) if context.raw is not None else {}
    except CredentialStorageError:
        raw = {}
    try:
        state = _state_from_raw(raw)
    except (ValueError, TypeError, OverflowError):
        state = AgentState()
        context = replace(context, mode="unreadable")
    state._credential_context = context
    if context.mode == "selected":
        state.device_token = context.snapshot.device.value
        state.obs_password = context.snapshot.obs.value
    else:
        state.device_token = state.obs_password = None
    return state


def load_state(state_dir: Path, *, storage=None, crypto=None) -> AgentState:
    """Read only. Preserve provenance so corrupt/legacy data cannot be overwritten."""
    with _STATE_SAVE_LOCK:
        return _from_context(_read_context(state_dir, storage, crypto))


def _state_from_raw(raw):
    legacy_single = _coerce_str(raw.get("replay_folder_override"))
    folders_raw = raw.get("replay_folders_override")
    folders = _coerce_str_list(folders_raw)
    # Forward-migrate the legacy single-string field into the list so
    # older state files don't lose their override after upgrade.
    if legacy_single and legacy_single not in folders:
        folders.insert(0, legacy_single)

    raw_path_by_game = raw.get("path_by_game_id") or {}
    if not isinstance(raw_path_by_game, dict):
        raw_path_by_game = {}
    path_by_game_id: Dict[str, str] = {}
    for gid, pth in raw_path_by_game.items():
        if isinstance(gid, str) and isinstance(pth, str) and gid and pth:
            path_by_game_id[gid] = pth

    uploaded = dict(raw.get("uploaded") or {})
    release_seen: Dict[str, str] = {}
    raw_release_seen = raw.get("release_seen")
    if isinstance(raw_release_seen, dict):
        for channel, latest in raw_release_seen.items():
            if isinstance(channel, str) and isinstance(latest, str):
                release_seen[channel] = latest
    # Migrate the legacy _release_seen_<channel> markers pre-0.14
    # updaters stashed inside `uploaded` (they inflated count_synced).
    for key in [k for k in uploaded if isinstance(k, str) and k.startswith("_release_seen_")]:
        channel = key[len("_release_seen_"):]
        value = uploaded.pop(key)
        if channel and isinstance(value, str) and channel not in release_seen:
            release_seen[channel] = value

    return AgentState(
        device_token=raw.get("device_token"),
        user_id=raw.get("user_id"),
        paired_at=raw.get("paired_at"),
        uploaded=uploaded,
        path_by_game_id=path_by_game_id,
        tray_hint_shown=raw.get("tray_hint_shown") is True,
        close_without_tray=raw.get("close_without_tray") if raw.get("close_without_tray") in ("quit", "minimize") else None,
        paused_until=_coerce_timestamp(raw.get("paused_until")),
        background_import_speed=raw.get("background_import_speed") if raw.get("background_import_speed") in ("gentle", "balanced", "maximum") else None,
        pause_history_in_game=raw.get("pause_history_in_game") is not False,
        pause_on_battery=raw.get("pause_on_battery") is True,
        update_pending_version=_coerce_str(raw.get("update_pending_version")),
        update_first_seen_at=_coerce_timestamp(raw.get("update_first_seen_at")),
        update_snoozed_until=_coerce_timestamp(raw.get("update_snoozed_until")),
        last_run_version=_coerce_str(raw.get("last_run_version")),
        paused=bool(raw.get("paused") or False),
        replay_folder_override=legacy_single,
        replay_folders_override=folders,
        replay_folders_excluded=_coerce_str_list(
            raw.get("replay_folders_excluded"),
        ),
        window_geometry=_coerce_geometry(raw.get("window_geometry")),
        window_information_layout=_coerce_information_layout(raw.get("window_information_layout")),
        window_page=_coerce_window_page(raw.get("window_page")),
        companion_skin=_coerce_companion_skin(raw.get("companion_skin")),
        companion_animations=raw.get("companion_animations") if type(raw.get("companion_animations")) is bool else True,
        companion_session_enabled=raw.get("companion_session_enabled") is True,
        api_base_override=_coerce_str(raw.get("api_base_override")),
        log_level_override=_coerce_str(raw.get("log_level_override")),
        autostart_enabled=bool(raw.get("autostart_enabled") or False),
        start_minimized=bool(raw.get("start_minimized") or False),
        notify_every_game=raw.get("notify_every_game") is True,
        notifications_muted=raw.get("notifications_muted") is True,
        close_to_tray=raw.get("close_to_tray") is not False,
        companion_preferences={
            key: value for key, value in (
                raw.get("companion_preferences")
                if isinstance(raw.get("companion_preferences"), dict) else {}
            ).items()
            if key in {"overlaysEnabled", "opponentOverlay", "scoutingOverlay", "scoutingSkipFirstMeeting", "scoutingReadAloud"}
            and type(value) is bool
        },
        companion_ghost=(
            dict(raw["companion_ghost"]) if isinstance(raw.get("companion_ghost"), dict) else {}
        ),
        companion_modes=normalize_modes(raw.get("companion_modes")),
        parse_concurrency_override=_coerce_int(
            raw.get("parse_concurrency_override"),
        ),
        upload_concurrency_override=_coerce_int(
            raw.get("upload_concurrency_override"),
        ),
        upload_batch_size_override=_coerce_int(
            raw.get("upload_batch_size_override"),
        ),
        last_known_mmr=_coerce_mmr(raw.get("last_known_mmr")),
        last_known_mmr_date_iso=_coerce_str(raw.get("last_known_mmr_date_iso")),
        last_known_mmr_region=_coerce_str(raw.get("last_known_mmr_region")),
        setup_pending=raw.get("setup_pending") is True,
        setup_completed_at=_coerce_timestamp(raw.get("setup_completed_at")),
        sync_filter_preset=_coerce_str(raw.get("sync_filter_preset")),
        sync_filter_since=_coerce_str(raw.get("sync_filter_since")),
        sync_filter_until=_coerce_str(raw.get("sync_filter_until")),
        release_seen=release_seen,
        auto_update_enabled=raw.get("auto_update_enabled") is not False,
        replay_capture_enabled=raw.get("replay_capture_enabled") is True,
        obs_scene_switch_enabled=bool(
            raw.get("obs_scene_switch_enabled") or False,
        ),
        obs_host=_coerce_str(raw.get("obs_host")) or "127.0.0.1",
        obs_port=_coerce_port(raw.get("obs_port")) or 4455,
        obs_password=_coerce_str(raw.get("obs_password")),
        obs_scene_map=_coerce_str_map(raw.get("obs_scene_map")),
        obs_switch_debounce_sec=_coerce_non_negative_float(
            raw.get("obs_switch_debounce_sec"), default=3.0,
        ),
        obs_website_add_enabled=raw.get("obs_website_add_enabled") is True,
        obs_switch_on_replays=bool(raw.get("obs_switch_on_replays") or False),
        obs_transition_name=_coerce_str(raw.get("obs_transition_name")),
        obs_transition_duration_ms=_coerce_int(
            raw.get("obs_transition_duration_ms"),
        ),
        build_checkin_intro_seen=raw.get("build_checkin_intro_seen") is True,
        build_checkin_card_positions=_coerce_positions(
            raw.get("build_checkin_card_positions"),
        ),
        build_checkin_prefs=_coerce_checkin_prefs(raw.get("build_checkin_prefs")),
        show_scouting_at_loading=raw.get("show_scouting_at_loading") is True,
        last_known_race=raw.get("last_known_race") if raw.get("last_known_race") in ("Protoss", "Terran", "Zerg") else None,
        last_known_race_at=_coerce_str(raw.get("last_known_race_at")),
        companion_panel_positions=_coerce_panel_positions(raw.get("companion_panel_positions")),
    )


def _secure_context(state_dir, state, storage=None, crypto=None):
    from .agent_credentials import CredentialStorageError, load_credentials
    directory = _state_directory(state_dir)
    context = getattr(state, "_credential_context", None)
    if context is not None and (type(context) is not _CredentialContext or context.directory != directory):
        raise CredentialStorageError("conflict")
    if context is None:
        context = _read_context(directory, storage, crypto)
    if context.mode in ("legacy", "unreadable"):
        raise CredentialStorageError("invalid_pointer")
    if storage is not None and context.storage is not None and storage is not context.storage:
        raise CredentialStorageError("conflict")
    if crypto is not None and context.crypto is not None and crypto is not context.crypto:
        raise CredentialStorageError("conflict")
    if context.snapshot is None or context.storage is None:
        storage, crypto = _credential_backends(directory, storage, crypto, create=context.mode == "missing")
        context = _context_from_snapshot(directory, load_credentials(storage, crypto), storage, crypto)
    if context.mode not in ("missing", "selected"):
        raise CredentialStorageError("invalid_pointer")
    return _retired_context(context) if getattr(state, "_credential_retired", False) is True else context


def _retired_context(context):
    from .agent_credentials import CredentialSnapshot, LoadedSlot
    if (type(context.snapshot) is not CredentialSnapshot or context.snapshot.selection is None
        or context.snapshot.device.reference is None
        or context.snapshot.device.reference.generation is None):
        return context
    slot = LoadedSlot(context.snapshot.device.reference, "unreadable", code="unavailable")
    return replace(context, snapshot=replace(context.snapshot, device=slot))


def _runtime_secret(value):
    from .agent_credentials import CredentialStorageError
    if value is not None and type(value) is not str:
        raise CredentialStorageError("invalid_intent")
    return None if value == "" else value


def _compatible_runtime(state, context):
    from .agent_credentials import CredentialStorageError, _document
    if context.mode != "selected":
        return
    for field_name, slot in (("device_token", "device"), ("obs_password", "obs")):
        if _runtime_secret(getattr(state, field_name)) != getattr(context.snapshot, slot).value:
            raise CredentialStorageError("invalid_intent")
    document = _document(context.raw)
    if any(value is not None and type(value) is not str for value in (state.user_id, state.paired_at)):
        raise CredentialStorageError("invalid_intent")
    if state.user_id != document.get("user_id") or state.paired_at != document.get("paired_at"):
        raise CredentialStorageError("invalid_intent")


def _state_projection(state, context, device_owner=UNCHANGED):
    from .agent_credentials import CredentialStorageError, _document, _encode, _owner
    document = _document(context.raw) if context.raw is not None else {}
    for key in ("credentials", "device_token", "obs_password"):
        document.pop(key, None)
    if any(value is not None and type(value) is not str for value in (state.user_id, state.paired_at)):
        raise CredentialStorageError("invalid_intent")
    document.update(_snapshot(state))
    if device_owner is not UNCHANGED:
        if type(device_owner) is not tuple or len(device_owner) != 2:
            raise CredentialStorageError("invalid_intent")
        document["user_id"], document["paired_at"] = device_owner
        _owner(document)
    return _encode(document)


def credential_revision(state, slot):
    """Pure private admission metadata; never read a file or expose a reference."""
    from .agent_credentials import CredentialStorageError
    if type(slot) is not str or slot not in ("device", "obs"):
        raise CredentialStorageError("invalid_intent")
    context = getattr(state, "_credential_context", None)
    if context is None:
        return 0
    if type(context) is not _CredentialContext:
        raise CredentialStorageError("invalid_pointer")
    if context.mode == "missing":
        return 0
    if context.mode != "selected":
        raise CredentialStorageError("invalid_pointer")
    return getattr(context.snapshot.selection, slot).revision


def credential_status(state, slot):
    from .agent_credentials import CredentialStorageError
    if type(slot) is not str or slot not in ("device", "obs"):
        raise CredentialStorageError("invalid_intent")
    context = getattr(state, "_credential_context", None)
    if slot == "device" and getattr(state, "_credential_retired", False) is True:
        return "retired"
    if context is None:
        return "missing"
    if type(context) is not _CredentialContext:
        raise CredentialStorageError("invalid_pointer")
    return getattr(context.snapshot, slot).status if context.mode == "selected" else context.mode


def credential_scope(state):
    """Private primitive lifetime metadata; no paths, refs, values or callbacks."""
    context = getattr(state, "_credential_context", None)
    selected = type(context) is _CredentialContext and context.mode == "selected"
    return (context.mode if type(context) is _CredentialContext else "missing",
        context.snapshot.store_id if selected else None,
        credential_revision(state, "device") if selected else None, credential_status(state, "device"),
        credential_revision(state, "obs") if selected else None, credential_status(state, "obs"))


def mark_device_retired(state, *, durable=False):
    """Retain the opaque old selector after failed revoked CLEAR, without revival.

    The runtime owner separately retires its epoch and all authenticated clients.
    A failed clear cannot be promised to survive a restart.
    """
    from .agent_credentials import CredentialStorageError
    with _STATE_SAVE_LOCK:
        if type(durable) is not bool:
            raise CredentialStorageError("invalid_intent")
        context = getattr(state, "_credential_context", None)
        if durable and (type(context) is not _CredentialContext or context.mode != "selected"
            or context.snapshot.device.reference.generation is not None):
            raise CredentialStorageError("conflict")
        state.device_token = None
        state._credential_retired = not durable
        if type(context) is _CredentialContext:
            state._credential_context = _retired_context(context)


def _intent(value):
    from .agent_credentials import CredentialIntent
    value = _runtime_secret(value)
    return CredentialIntent("clear") if value is None else CredentialIntent("set", value)


def _check_credential_admission(state, context, device, obs, device_revision, obs_revision, owner_epoch, device_owner):
    from .agent_credentials import CredentialIntent, CredentialStorageError
    for slot, intent, expected in (("device", device, device_revision), ("obs", obs, obs_revision)):
        if type(intent) is not CredentialIntent:
            raise CredentialStorageError("invalid_intent")
        if intent.operation != "keep":
            if type(expected) is not int or expected != getattr(context.snapshot.selection, slot).revision:
                raise CredentialStorageError("conflict")
    if device.operation != "keep":
        if owner_epoch is UNCHANGED or owner_epoch is None or getattr(state, "_owner_epoch", None) is not owner_epoch:
            raise CredentialStorageError("conflict")
    if device.operation == "set":
        if type(device_owner) is not tuple or len(device_owner) != 2:
            raise CredentialStorageError("invalid_intent")
    elif device_owner is not UNCHANGED:
        raise CredentialStorageError("invalid_intent")


def _committed_snapshot(context, committed, device, obs):
    from .agent_credentials import CredentialSnapshot, LoadedSlot
    slots = []
    for slot, intent in (("device", device), ("obs", obs)):
        reference = getattr(committed.selection, slot)
        old = getattr(context.snapshot, slot)
        if reference.generation is None:
            slots.append(LoadedSlot(reference, "cleared"))
        elif intent.operation == "set":
            slots.append(LoadedSlot(reference, "available", intent.value))
        else:
            slots.append(LoadedSlot(reference, old.status, old.value, old.code))
    return CredentialSnapshot("selected", committed.selection, *slots, committed.document,
        store_id=context.snapshot.store_id)


def _prepare_state_transaction(context, state, projected, device, obs):
    from .agent_credentials import _document, _encode, _same_owner, prepare_transaction
    pending = getattr(state, "_credential_pending", None)
    if (type(pending) is _PendingCredentials and pending.device == device and pending.obs == obs
        and pending.prepared.expected == context.raw and pending.prepared.store_id == context.snapshot.store_id):
        original = _document(pending.prepared.document)
        current = _document(projected)
        if _same_owner(original, current):
            current["credentials"] = original["credentials"]
            prepared = replace(pending.prepared, document=_encode(current))
            state._credential_pending = _PendingCredentials(device, obs, prepared)
            return prepared
    prepared = prepare_transaction(context.snapshot, projected, crypto=context.crypto, device=device, obs=obs)
    state._credential_pending = _PendingCredentials(device, obs, prepared)
    return prepared


def _commit_state(context, state, device, obs, device_owner=UNCHANGED):
    from .agent_credentials import CredentialStorageError, commit_transaction
    _compatible_runtime(state, context)
    if context.mode == "missing":
        device = _intent(state.device_token) if device.operation == "keep" else device
        obs = _intent(state.obs_password) if obs.operation == "keep" else obs
    projected = _state_projection(state, context, device_owner)
    prepared = _prepare_state_transaction(context, state, projected, device, obs)
    try:
        committed = commit_transaction(context.storage, context.crypto, prepared)
    except CredentialStorageError as exc:
        if exc.code == "indeterminate":
            state._credential_context = replace(context, mode="unreadable")
        raise
    snapshot = _committed_snapshot(context, committed, device, obs)
    state._credential_context = replace(context, mode="selected", raw=committed.document, snapshot=snapshot)
    state._credential_pending = None
    if device.operation != "keep":
        state._credential_retired = False
    state.device_token = None if getattr(state, "_credential_retired", False) is True else snapshot.device.value
    state.obs_password = snapshot.obs.value
    if device_owner is not UNCHANGED:
        state.user_id, state.paired_at = device_owner


def save_state(state_dir: Path, state: AgentState, *, storage=None, crypto=None) -> None:
    """Serialize opaque KEEP; only an actually absent target admits initial fields."""
    from .agent_credentials import KEEP
    with _STATE_SAVE_LOCK:
        context = _secure_context(state_dir, state, storage, crypto)
        _commit_state(context, state, KEEP, KEEP)


def commit_state_credentials(state_dir, state, *, device=UNCHANGED, obs=UNCHANGED,
                             expected_device_revision=None, expected_obs_revision=None,
                             expected_owner_epoch=UNCHANGED, device_owner=UNCHANGED,
                             storage=None, crypto=None):
    """Stage candidate owner/credentials without provisional shared publication."""
    from .agent_credentials import KEEP
    device = KEEP if device is UNCHANGED else device
    obs = KEEP if obs is UNCHANGED else obs
    with _STATE_SAVE_LOCK:
        context = _secure_context(state_dir, state, storage, crypto)
        _check_credential_admission(state, context, device, obs, expected_device_revision,
            expected_obs_revision, expected_owner_epoch, device_owner)
        _commit_state(context, state, device, obs, device_owner)


def _require_instance(instance_lock, directory, lease=UNCHANGED):
    from .agent_credentials import CredentialStorageError
    from .instance_lock import AgentInstanceLock
    if type(instance_lock) is not AgentInstanceLock or instance_lock.acquired is not True:
        raise CredentialStorageError("conflict")
    guarded = instance_lock.state_directory
    if type(guarded) is not type(Path()) or guarded != directory:
        raise CredentialStorageError("conflict")
    current = instance_lock.acquisition_token
    if current is None or lease is not UNCHANGED and current is not lease:
        raise CredentialStorageError("conflict")
    return current


class _InstanceStorage:
    """Narrow migration IO lease; never used by ordinary readers/writers."""
    def __init__(self, storage, instance_lock, directory, lease):
        self.storage, self.instance_lock, self.directory = storage, instance_lock, directory
        self.lease = lease

    def _run(self, method, *args):
        _require_instance(self.instance_lock, self.directory, self.lease)
        try:
            result = getattr(self.storage, method)(*args)
        except Exception:
            _require_instance(self.instance_lock, self.directory, self.lease)
            raise
        _require_instance(self.instance_lock, self.directory, self.lease)
        return result

    def identity(self): return self._run("identity")
    def read_pointer(self): return self._run("read_pointer")
    def read_generation(self, name): return self._run("read_generation", name)
    def create_generation(self, name, data): return self._run("create_generation", name, data)
    def replace_pointer(self, expected, data): return self._run("replace_pointer", expected, data)
    def capacity(self): return self._run("capacity")


def migrate_legacy_state(state_dir, instance_lock, *, storage=None, crypto=None):
    """Explicit post-instance migration before any credential consumer exists."""
    from .agent_credentials import (CredentialIntent, CredentialStorageError, PreparedTransaction, _document, _encode,
        load_credentials, prepare_legacy_transaction, prepare_transaction, commit_transaction)
    directory = _state_directory(state_dir)
    guard_directory = directory.resolve()
    lease = _require_instance(instance_lock, guard_directory)
    with _STATE_SAVE_LOCK:
        _require_instance(instance_lock, guard_directory, lease)
        storage, crypto = _credential_backends(directory, storage, crypto, create=True)
        _require_instance(instance_lock, guard_directory, lease)
        owned = _InstanceStorage(storage, instance_lock, guard_directory, lease)
        snapshot = load_credentials(owned, crypto)
        _require_instance(instance_lock, guard_directory, lease)
        pending = getattr(instance_lock, "_credential_migration_pending", None)
        if (type(pending) is PreparedTransaction and (snapshot.raw is not None or snapshot.status == "missing")
            and pending.expected == snapshot.raw and pending.store_id == snapshot.store_id):
            prepared = pending
        elif snapshot.status == "missing":
            projected = _encode(_snapshot(AgentState()))
            prepared = prepare_transaction(snapshot, projected, crypto=crypto,
                device=CredentialIntent("clear"), obs=CredentialIntent("clear"))
        elif snapshot.status == "selected":
            document = _document(snapshot.raw)
            if not any(key in document for key in ("device_token", "obs_password")):
                instance_lock._credential_migration_pending = None
                return _from_context(_context_from_snapshot(directory, snapshot, storage, crypto))
            document.pop("credentials")
            document.pop("device_token", None)
            document.pop("obs_password", None)
            prepared = prepare_transaction(snapshot, _encode(document), crypto=crypto)
        elif snapshot.raw is not None:
            prepared = prepare_legacy_transaction(snapshot, crypto=crypto)
        else:
            raise CredentialStorageError("invalid_pointer")
        _require_instance(instance_lock, guard_directory, lease)
        instance_lock._credential_migration_pending = prepared
        commit_transaction(owned, crypto, prepared)
        _require_instance(instance_lock, guard_directory, lease)
        instance_lock._credential_migration_pending = None
        return _from_context(_context_from_snapshot(directory, load_credentials(owned, crypto), storage, crypto))


def _replace_state_file(source, target) -> None:
    """Keep the fsync'd snapshot while a Windows reader briefly holds the target.

    Windows can reject atomic replacement while another thread reads agent.json
    (or a scanner opens it). Retry the same immutable temporary file, under the
    existing writer lock. Never fall back to truncating the destination.
    """
    for attempt in range(6):
        try:
            os.replace(source, target)
            return
        except PermissionError as exc:
            if getattr(exc, "winerror", None) not in (5, 32, 33) or attempt == 5:
                raise
            time.sleep(0.01 * 2 ** attempt)


def _snapshot(state: AgentState) -> dict:
    """Deep-copy the state for serialisation, tolerating concurrent
    mutation.

    The watcher's FS-event/parse-callback threads write ``filtered`` /
    ``skipped`` markers into ``state.uploaded`` without holding the
    upload queue's lock, so ``asdict`` (whose Python-level recursion
    yields the GIL between bytecodes) can hit ``RuntimeError:
    dictionary changed size during iteration`` while an upload worker
    persists a batch — and under a hot writer a bounded retry of
    ``asdict`` itself can keep losing that race. Instead, copy each
    shared mutable container first: ``dict()`` / ``list()`` on
    str-keyed/str-valued containers are single C-level calls that hold
    the GIL, so they cannot interleave with another thread's insert.
    ``asdict`` then walks only private copies. A marker that lands
    after the copy is simply picked up by the next save.
    """
    stable = replace(
        state,
        device_token=None,
        obs_password=None,
        window_geometry=_coerce_geometry(state.window_geometry),
        window_information_layout=_coerce_information_layout(state.window_information_layout),
        window_page=_coerce_window_page(state.window_page),
        companion_skin=_coerce_companion_skin(state.companion_skin),
        companion_animations=state.companion_animations if type(state.companion_animations) is bool else True,
        companion_session_enabled=state.companion_session_enabled is True,
        companion_panel_positions=_coerce_panel_positions(state.companion_panel_positions),
        uploaded=dict(state.uploaded),
        path_by_game_id=dict(state.path_by_game_id),
        companion_preferences=dict(state.companion_preferences),
        companion_modes=normalize_modes(state.companion_modes),
        companion_ghost=dict(state.companion_ghost),
        release_seen=dict(state.release_seen),
        replay_folders_override=list(state.replay_folders_override),
        replay_folders_excluded=list(state.replay_folders_excluded),
        obs_website_add_enabled=state.obs_website_add_enabled is True,
        obs_scene_map=dict(state.obs_scene_map),
        build_checkin_card_positions={
            kind: list(point)
            for kind, point in dict(state.build_checkin_card_positions).items()
        },
        build_checkin_prefs=(
            dict(state.build_checkin_prefs)
            if state.build_checkin_prefs is not None else None
        ),
    )
    snapshot = asdict(stable)
    snapshot.pop("device_token")
    snapshot.pop("obs_password")
    return snapshot


def _coerce_timestamp(value):
    import math
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0 else None


def _coerce_geometry(value: object) -> Optional[str]:
    if not isinstance(value, str) or not value or len(value) > 16384:
        return None
    try:
        return value if base64.b64decode(value, validate=True) else None
    except (ValueError, binascii.Error):
        return None


def _coerce_window_page(value: object) -> Optional[str]:
    return value if isinstance(value, str) and value in {
        "dashboard", "recent", "log", "settings", "streams", "companion", "help",
    } else None


def _coerce_mmr(value: object) -> Optional[int]:
    """Return ``value`` as a plausible MMR (500–9999) or None.

    Defends against legacy/garbage entries written by older agent
    versions or hand-edited state files. Mirrors the cloud profile's
    [500, 9999] band so a state-loaded value the cloud would reject
    is dropped here instead of repeatedly bouncing off the API.
    """
    if isinstance(value, bool):
        return None
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if 500 <= n <= 9999:
        return n
    return None


def _coerce_information_layout(value: object) -> str:
    return value if isinstance(value, str) and value in {"compact", "standard", "detailed", "full"} else "standard"


def _coerce_companion_skin(value: object) -> str:
    return value if isinstance(value, str) and value in COMPANION_SKINS else "default"


def _coerce_int(value: object) -> Optional[int]:
    """Return ``value`` as a positive int if possible; ``None`` otherwise.

    Used for state-stored override fields that the GUI may write as
    a JSON number or string. We clamp to ``>= 1`` because the Settings
    tab's spinbox already gates the range, but a hand-edited state
    file could put a zero or negative there and silently break the
    watcher's ThreadPoolExecutor (which requires max_workers >= 1).
    """
    if isinstance(value, bool):
        # ``True`` would otherwise coerce to ``1`` — guard against the
        # case where someone hand-edits the state file.
        return None
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if n >= 1 else None


def _coerce_str(value: object) -> Optional[str]:
    """Return ``value`` if it's a non-empty string; ``None`` otherwise.

    Clears legacy/empty entries written by older agent versions so the
    GUI's "blank means default" semantics work without a migration.
    """
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _coerce_port(value: object) -> Optional[int]:
    """Return ``value`` as a valid TCP port, or ``None``.

    Separate from ``_coerce_int`` because that one is for worker
    counts and rejects nothing at the top end; a hand-edited port of
    ``70000`` would sail through it and then fail deep inside the
    socket layer with a confusing error.
    """
    if isinstance(value, bool):
        return None
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return n if 1 <= n <= 65535 else None


def _coerce_non_negative_float(value: object, *, default: float) -> float:
    """Return ``value`` as a float >= 0, falling back to ``default``.

    A negative debounce would make the deadline already-expired and
    silently defeat the guard it exists to provide, so it is treated
    as malformed rather than clamped silently to zero.
    """
    if isinstance(value, bool):
        return default
    try:
        f = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default
    if f != f or f < 0:  # NaN or negative
        return default
    return f


def _coerce_str_map(value: object) -> Dict[str, str]:
    """Return ``value`` as a ``dict[str, str]``, dropping junk entries.

    Used for ``obs_scene_map``. Empty string values are *kept*: in the
    scene map they carry meaning ("don't switch for this phase") and
    are distinct from an absent key only in that the GUI renders them
    as an explicit choice.
    """
    if not isinstance(value, dict):
        return {}
    out: Dict[str, str] = {}
    for key, val in value.items():
        if isinstance(key, str) and key and isinstance(val, str):
            out[key] = val.strip()
    return out


def _coerce_positions(value: object) -> Dict[str, List[int]]:
    """Return ``value`` as ``{name: [x, y]}`` with integer coordinates.

    Off-screen or stale coordinates are the window's problem to clamp;
    this only drops entries that are not a pair of plain numbers.
    """
    if not isinstance(value, dict):
        return {}
    out: Dict[str, List[int]] = {}
    for key, point in value.items():
        if (
            isinstance(key, str)
            and key
            and isinstance(point, list)
            and len(point) == 2
            and all(
                isinstance(c, (int, float)) and not isinstance(c, bool)
                and c == c and abs(c) < 1_000_000
                for c in point
            )
        ):
            out[key] = [int(point[0]), int(point[1])]
    return out


def _coerce_panel_positions(value: object) -> Dict[str, List[int]]:
    from .panel_positions import normalize_panel_positions

    return normalize_panel_positions(value)


_CHECKIN_PREF_KEYS = ("enabled", "askAtLoading", "askAfterGame")


def _coerce_checkin_prefs(value: object) -> Optional[Dict[str, bool]]:
    """Return ``value`` as the three ``buildCheckin`` flags, or ``None``.

    Same reading as the API's sanitiser: only an explicit ``true``
    opts into a feature.
    """
    if not isinstance(value, dict):
        return None
    return {key: value.get(key) is True for key in _CHECKIN_PREF_KEYS}


def _coerce_str_list(value: object) -> List[str]:
    """Return ``value`` as a deduplicated list of non-empty strings.

    Tolerates a JSON list, a single string, or a missing/None field —
    in every case the result is a fresh ``list[str]`` the caller can
    mutate without touching the source state.
    """
    if value is None:
        return []
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    seen: set[str] = set()
    out: List[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out
