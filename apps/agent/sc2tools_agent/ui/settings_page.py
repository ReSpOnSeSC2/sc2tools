"""Construct the desktop Settings page with the supplied Qt namespaces."""
from __future__ import annotations

import os

from ..config import _DEFAULT_API_BASE, PARSE_CONCURRENCY_USEFUL_MAX
from . import theme
from .help_links import help_button

# Format the sync-range controls and the corresponding saved dates consistently.
SYNC_DATE_FORMAT = "yyyy-MM-dd"
APPLIES_INSTANTLY = "Applies instantly"
SAVED_WITH_SAVE = "Saved with Save"
NEEDS_RESTART = "Needs restart"
_SECTION_INDEX_MIN_WIDTH = 900


def settings_timing(QtWidgets, timing, *controls):
    """Display timing and include it in each control's accessible description."""
    note = QtWidgets.QLabel(timing)
    note.setObjectName("hint")
    for control in controls:
        description = control.accessibleDescription()
        control.setAccessibleDescription(" ".join(part for part in (description, timing) if part))
    return note


def _with_timing(QtWidgets, field, timing, *controls):
    block = QtWidgets.QWidget()
    layout = QtWidgets.QVBoxLayout(block)
    layout.setContentsMargins(0, 0, 0, 0)
    layout.setSpacing(theme.SPACE_XS)
    layout.addWidget(field)
    layout.addWidget(settings_timing(QtWidgets, timing, *(controls or (field,))))
    return block


def _install_section_index(scroller, jump_label, jump, sections, open_section, *, QtCore, QtWidgets):
    index = QtWidgets.QListWidget(scroller)
    index.setAccessibleName("Settings section index")
    index.addItems(list(sections))
    index.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAlwaysOff)
    index.itemClicked.connect(lambda item: open_section(item.text()))
    index.itemActivated.connect(lambda item: open_section(item.text()))
    QtWidgets.QWidget.setTabOrder(index, jump)
    index.hide()

    class ResponsiveIndex(QtCore.QObject):
        def __init__(self):
            super().__init__(scroller)
            self.wide = False
            scroller.installEventFilter(self)

        def eventFilter(self, watched, event):
            if event.type() in (QtCore.QEvent.Resize, QtCore.QEvent.Show):
                self.refresh()
            return False

        def refresh(self):
            wide = scroller.width() >= _SECTION_INDEX_MIN_WIDTH
            width = index.sizeHintForColumn(0) + 2 * theme.SPACE_S
            if wide != self.wide:
                self.wide = wide
                transfer_focus = jump.hasFocus() if wide else index.hasFocus()
                scroller.setViewportMargins(theme.PAGE_MARGIN_X + width if wide else 0, 0, 0, 0)
                index.setVisible(wide)
                jump_label.setVisible(not wide)
                jump.setVisible(not wide)
                if transfer_focus:
                    (index if wide else jump).setFocus()
            if wide:
                height = sum(index.sizeHintForRow(row) for row in range(index.count())) + 2 * index.frameWidth()
                height = min(height, max(0, scroller.height() - 2 * theme.PAGE_MARGIN_Y))
                index.setGeometry(theme.PAGE_MARGIN_X, theme.PAGE_MARGIN_Y, width, height)

    return ResponsiveIndex()


def build_settings_page(
    window, *, QtCore, QtGui, QtWidgets, initial_settings,
    checkin_controller, checkin_available, open_folder,
):
    """Attach Settings controls to the window and connect its actions."""
    # The form is taller than the window's minimum height, so
    # everything lives inside a scroll area — otherwise the
    # bottom rows (and the Save button with them) are simply
    # clipped off-screen at small window sizes with no way to
    # reach them.
    scroller = QtWidgets.QScrollArea()
    scroller.setWidgetResizable(True)
    scroller.setFrameShape(QtWidgets.QFrame.NoFrame)
    scroller.setHorizontalScrollBarPolicy(QtCore.Qt.ScrollBarAsNeeded)
    window._settings_scroll = scroller

    page = QtWidgets.QWidget()
    v = QtWidgets.QVBoxLayout(page)
    v.setContentsMargins(theme.PAGE_MARGIN_X, theme.PAGE_MARGIN_Y, theme.PAGE_MARGIN_X, theme.PAGE_MARGIN_Y)
    v.setSpacing(14)

    title = QtWidgets.QLabel("Settings")
    title.setObjectName("h1")
    v.addWidget(title)
    navigation = QtWidgets.QHBoxLayout()
    section_label = QtWidgets.QLabel("Settings section")
    section_select = QtWidgets.QComboBox()
    section_select.setAccessibleName("Settings section")
    section_label.setBuddy(section_select)
    navigation.addWidget(section_label)
    navigation.addWidget(section_select, 1)
    navigation.addWidget(help_button(QtWidgets, "Desktop app settings",
                                     lambda: window._open_help("desktop-app-settings")))
    navigation.addWidget(help_button(QtWidgets, "Keyboard shortcuts",
                                     lambda: window._open_help("desktop-app-shortcuts")))
    navigation.addStretch()
    v.addLayout(navigation)

    form_card = QtWidgets.QFrame()
    form_card.setObjectName("card")
    form = QtWidgets.QFormLayout(form_card)
    form.setContentsMargins(12, 14, 12, 14)
    form.setHorizontalSpacing(20)
    form.setVerticalSpacing(14)
    form.setLabelAlignment(QtCore.Qt.AlignRight | QtCore.Qt.AlignVCenter)
    form.setRowWrapPolicy(QtWidgets.QFormLayout.WrapLongRows)

    window._api_test_generation = 0
    window._api_input = QtWidgets.QLineEdit()
    window._api_input.setPlaceholderText(_DEFAULT_API_BASE)
    window._api_input.setToolTip(
        "Where the agent uploads parsed replays and fetches your "
        "profile. Leave blank to use the production cloud API "
        "(https://sc2tools-api.onrender.com). Override only when "
        "you're running a private API instance — e.g. local dev "
        "or a self-hosted ingest endpoint.",
    )
    api_block = QtWidgets.QWidget()
    api_v = QtWidgets.QVBoxLayout(api_block)
    api_v.setContentsMargins(0, 0, 0, 0)
    api_row = QtWidgets.QHBoxLayout()
    api_row.addWidget(window._api_input, 1)
    api_actions = QtWidgets.QHBoxLayout()
    window._api_reset_btn = QtWidgets.QPushButton("Reset to default")
    window._api_reset_btn.clicked.connect(window._reset_api_address)
    api_actions.addWidget(window._api_reset_btn)
    window._api_test_btn = QtWidgets.QPushButton("Test")
    window._api_test_btn.clicked.connect(window._test_api_address)
    api_actions.addWidget(window._api_test_btn)
    api_v.addLayout(api_row)
    api_v.addWidget(settings_timing(QtWidgets, NEEDS_RESTART, window._api_input))
    api_actions.addStretch(1)
    api_v.addLayout(api_actions)
    api_hint = QtWidgets.QLabel("Leave blank to use sc2tools.com")
    api_hint.setObjectName("muted")
    api_v.addWidget(api_hint)
    window._api_error = QtWidgets.QLabel("")
    window._api_error.setObjectName("fieldError")
    window._api_error.setWordWrap(True)
    api_v.addWidget(window._api_error)
    window._api_test_status = QtWidgets.QLabel("")
    window._api_test_status.setObjectName("muted")
    window._api_test_status.setWordWrap(True)
    api_v.addWidget(window._api_test_status)
    window._api_input.editingFinished.connect(window._validate_api_address)
    window._api_input.textChanged.connect(window._on_api_text_changed)
    api_label = QtWidgets.QLabel("API base URL")
    api_label.setBuddy(window._api_input)
    form.addRow(api_label, api_block)

    window._handle_input = QtWidgets.QLineEdit()
    window._handle_edit_origin = None
    window._handle_input.textEdited.connect(window._on_handle_edited)
    window._handle_input.setPlaceholderText(
        "e.g. ReSpOnSe  (leave blank to use your current profile)",
    )
    window._handle_input.setToolTip(
        "Your in-game player name. Used to identify which player "
        "is YOU when no saved account ID identifies a player. "
        "Leave blank to refresh your current account's profile. "
        "Saved account IDs take priority. A name must uniquely "
        "match one replay player, including any clan tag or a "
        "case-sensitive substring. Only an edited value is saved "
        "as an override for the linked account.",
    )
    form.addRow("Player handle", window._handle_input)

    # Parse concurrency. Slider capped at the SMALLER of
    # ``cpu_count`` and ``PARSE_CONCURRENCY_USEFUL_MAX`` —
    # not just ``cpu_count``. Why: the cloud's 120 req/min
    # rate limit × 25-game upload batches caps total
    # throughput at ~50 games/sec end-to-end. One parse
    # worker delivers ~3-5 games/sec depending on replay
    # length, so 8-12 workers already saturate the upload
    # pipeline. Anything above that just queues parsed games
    # in memory while the upload thread drains at the same
    # rate. Capping the slider at the useful ceiling keeps
    # the UI honest — moving it from 12 to 32 produces zero
    # visible speedup, so we don't offer the option. Power
    # users who self-host the cloud API with a higher rate
    # limit can override via ``SC2TOOLS_PARSE_CONCURRENCY``.
    cpu_count = max(1, os.cpu_count() or 4)
    cpu_max = min(cpu_count, PARSE_CONCURRENCY_USEFUL_MAX)
    default_workers = min(4, cpu_max)
    concurrency_block = QtWidgets.QWidget()
    concurrency_h = QtWidgets.QHBoxLayout(concurrency_block)
    concurrency_h.setContentsMargins(0, 0, 0, 0)
    concurrency_h.setSpacing(10)
    window._concurrency_slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
    window._concurrency_slider.setRange(1, cpu_max)
    window._concurrency_slider.setValue(default_workers)
    window._concurrency_slider.setTickPosition(
        QtWidgets.QSlider.TicksBelow,
    )
    # Tick every step. The slider only goes up to ~12 now so
    # we don't need the high-density compression we used to
    # apply for 32-thread monsters.
    window._concurrency_slider.setTickInterval(1)
    cpu_hint = (
        f"capped at {cpu_max} (your CPU has {cpu_count} threads "
        f"but uploads max out around {cpu_max} parsers — more "
        f"workers won't speed anything up)"
        if cpu_count > cpu_max
        else f"capped at your CPU's {cpu_max} threads"
    )
    window._concurrency_slider.setToolTip(
        f"How many replays to parse in parallel. Each worker "
        f"is a separate process and consumes one CPU thread "
        f"plus ~150 MB of sc2reader state. The cloud upload "
        f"pipeline tops out near 50 games/sec, so 8-12 parse "
        f"workers already saturate it — {cpu_hint}. Takes "
        f"effect on next agent restart."
    )
    window._concurrency_value_label = QtWidgets.QLabel()
    window._concurrency_value_label.setMinimumWidth(96)

    def _refresh_label(val: int) -> None:
        window._concurrency_value_label.setText(
            f"{int(val)} / {cpu_max} workers",
        )

    window._concurrency_slider.valueChanged.connect(_refresh_label)
    _refresh_label(default_workers)
    concurrency_h.addWidget(window._concurrency_slider, 1)
    concurrency_h.addWidget(window._concurrency_value_label)
    window._concurrency_slider.setEnabled(False)
    form.addRow("Workers after restart", concurrency_block)

    # Upload concurrency. Replaces the older slider with a
    # 1-or-2 button group: those are the only values worth
    # offering on the production cloud. The 120 req/min rate
    # limit means 1 worker uses ~half the budget and 2 uses
    # the full budget on a typical home connection; 3+ would
    # just produce 429 retries that settle at the same
    # throughput, so there's no reason to expose them in the
    # UI. Power users on a self-hosted API with a higher
    # rate limit can still override via the
    # ``SC2TOOLS_UPLOAD_CONCURRENCY`` env var.
    #
    # Click-to-apply: each button click immediately fires a
    # save (no need to click "Save settings") AND hot-swaps
    # the live upload queue's worker count via the runner's
    # save handler. Takes effect on the next batch the
    # agent issues, no restart required.
    from ..config import (  # local: keeps test imports cheap
        _DEFAULT_UPLOAD_CONCURRENCY,
        UPLOAD_CONCURRENCY_USEFUL_MAX,
        _DEFAULT_UPLOAD_BATCH_SIZE,
        UPLOAD_BATCH_SIZE_USEFUL_MAX,
    )
    upload_conc_block = QtWidgets.QWidget()
    upload_conc_h = QtWidgets.QHBoxLayout(upload_conc_block)
    upload_conc_h.setContentsMargins(0, 0, 0, 0)
    upload_conc_h.setSpacing(8)
    window._upload_conc_group = QtWidgets.QButtonGroup(window)
    window._upload_conc_group.setExclusive(True)
    window._upload_conc_buttons: dict[int, QtWidgets.QPushButton] = {}
    # Two buttons: 1 worker (safe) and 2 workers (max).
    # If we ever want to ship a higher option, add it here
    # — UPLOAD_CONCURRENCY_USEFUL_MAX is still 4 in
    # config.py, but we deliberately only expose 1/2 in
    # the UI because anything past 2 risks 429s on the
    # production rate limit. The state and env var both
    # accept higher; this is just a UI-side choice.
    for n in (1, 2):
        btn = QtWidgets.QPushButton(f"{n}")
        btn.setCheckable(True)
        btn.setMinimumWidth(56)
        btn.setCursor(QtCore.Qt.PointingHandCursor)
        btn.setObjectName("segment")
        btn.setToolTip(
            f"Use {n} parallel upload "
            f"worker{'' if n == 1 else 's'}. "
            + (
                "Conservative — uses ~half the cloud rate "
                "limit budget."
                if n == 1
                else "Recommended — saturates the 120 req/min "
                     "rate limit without 429s on a typical "
                     "home connection."
            )
        )
        window._upload_conc_group.addButton(btn, n)
        upload_conc_h.addWidget(btn)
        window._upload_conc_buttons[n] = btn
    # Default selection — overridden in _populate_settings if
    # state has an explicit override.
    initial_default = max(
        1, min(2, _DEFAULT_UPLOAD_CONCURRENCY),
    )
    window._upload_conc_buttons[initial_default].setChecked(True)
    # Track the last value we saved so a no-op click (user
    # clicks the already-selected button) skips the round-
    # trip through _on_save_settings.
    window._upload_conc_last_saved: int = initial_default
    upload_conc_h.addStretch(1)
    # Hint text trailing the buttons — explains the
    # rate-limit reasoning so the user knows why we don't
    # expose more options.
    upload_conc_hint = QtWidgets.QLabel("More than 2 risks rate-limit retries.")
    upload_conc_hint.setWordWrap(True)
    upload_conc_hint.setObjectName("hint")
    upload_conc_h.addWidget(upload_conc_hint, 2)
    window._upload_concurrency_feedback = upload_conc_hint
    form.addRow("Upload concurrency", upload_conc_block)

    # Auto-save handler. Connected via ``buttonClicked``
    # which fires for every click — including a re-click of
    # the already-selected button — so we de-dupe on the
    # ``_upload_conc_last_saved`` cache.
    window._upload_conc_group.buttonClicked.connect(window._on_upload_conc_clicked)

    # Upload batch size. How many games we cram into a single
    # ``POST /v1/games``. Bigger batches = more throughput per
    # rate-limit-budget unit; capped at
    # ``UPLOAD_BATCH_SIZE_USEFUL_MAX`` (50) by the 5 MB body
    # limit on long-Zerg-game outliers.
    upload_batch_block = QtWidgets.QWidget()
    upload_batch_h = QtWidgets.QHBoxLayout(upload_batch_block)
    upload_batch_h.setContentsMargins(0, 0, 0, 0)
    upload_batch_h.setSpacing(10)
    window._upload_batch_slider = QtWidgets.QSlider(QtCore.Qt.Horizontal)
    window._upload_batch_slider.setRange(1, UPLOAD_BATCH_SIZE_USEFUL_MAX)
    window._upload_batch_slider.setValue(_DEFAULT_UPLOAD_BATCH_SIZE)
    window._upload_batch_slider.setTickPosition(
        QtWidgets.QSlider.TicksBelow,
    )
    # Sparser tick marks at 5-game intervals — 50 ticks would
    # turn into a comb on the slider track.
    window._upload_batch_slider.setTickInterval(5)
    window._upload_batch_slider.setToolTip(
        f"How many games to pack into one HTTP request. The "
        f"cloud accepts {UPLOAD_BATCH_SIZE_USEFUL_MAX}-game "
        f"batches up to 5 MB; long Zerg games with full "
        f"build_logs run ~150 KB each, so the default of "
        f"{_DEFAULT_UPLOAD_BATCH_SIZE} leaves margin for "
        f"outliers. Bigger batches × the 120 req/min rate "
        f"limit = more throughput. Applies to the next batch."
    )
    window._upload_batch_value_label = QtWidgets.QLabel()
    window._upload_batch_value_label.setMinimumWidth(96)

    def _refresh_upload_batch_label(val: int) -> None:
        window._upload_batch_value_label.setText(
            f"{int(val)} games / req",
        )

    window._upload_batch_slider.valueChanged.connect(
        _refresh_upload_batch_label,
    )
    _refresh_upload_batch_label(_DEFAULT_UPLOAD_BATCH_SIZE)
    upload_batch_h.addWidget(window._upload_batch_slider, 1)
    upload_batch_h.addWidget(window._upload_batch_value_label)
    form.addRow("Upload batch size", upload_batch_block)

    # Date-range sync filter — mirrors the website's filter bar
    # (apps/web/lib/datePresets.ts). Restricts which replays the
    # watcher uploads. New users on PCs with thousands of
    # historical replays use this to scope the initial backfill
    # to "Current season" or "Custom range" so they don't grind
    # through years of old games to hydrate today's stats.
    from .. import sync_filter as sf  # local import keeps tests cheap

    filter_block = QtWidgets.QWidget()
    filter_v = QtWidgets.QVBoxLayout(filter_block)
    filter_v.setContentsMargins(0, 0, 0, 0)
    filter_v.setSpacing(6)

    window._filter_combo = QtWidgets.QComboBox()
    cur = sf.current_season()
    # Build the menu with the same vocabulary the website uses.
    # Per-season entries cover the last six seasons — beyond
    # that, "Custom range" is the right escape hatch.
    window._filter_combo.addItem("All time", "all")
    window._filter_combo.addItem(
        f"Current season (Season {cur})", "current_season",
    )
    window._filter_combo.addItem("Last 30 days", sf.PRESET_LAST_30_DAYS)
    if initial_settings.sync_filter_preset == sf.PRESET_SINCE_SETUP:
        window._filter_combo.addItem("Only games since setup", sf.PRESET_SINCE_SETUP)
    for n in range(cur, max(cur - 6, 0), -1):
        window._filter_combo.addItem(f"Season {n}", f"season:{n}")
    window._filter_combo.addItem("Custom date range…", "custom")
    window._filter_combo.setToolTip(
        "Restrict which replays get uploaded. The watcher still "
        "watches every folder you've added — replays played "
        "outside the chosen window are skipped, not deleted. "
        "Existing cloud uploads are not removed when you change "
        "this setting; the agent runs a fresh sweep on save."
    )
    filter_v.addWidget(window._filter_combo)

    # Custom range row — visible only when "Custom" is picked.
    window._filter_custom_row = QtWidgets.QWidget()
    custom_h = QtWidgets.QHBoxLayout(window._filter_custom_row)
    custom_h.setContentsMargins(0, 0, 0, 0)
    custom_h.setSpacing(8)
    custom_h.addWidget(QtWidgets.QLabel("From"))
    window._filter_since = QtWidgets.QDateEdit()
    window._filter_since.setCalendarPopup(True)
    window._filter_since.setDisplayFormat(SYNC_DATE_FORMAT)
    window._filter_since.setDate(QtCore.QDate.currentDate().addMonths(-1))
    custom_h.addWidget(window._filter_since)
    custom_h.addWidget(QtWidgets.QLabel("to"))
    window._filter_until = QtWidgets.QDateEdit()
    window._filter_until.setCalendarPopup(True)
    window._filter_until.setDisplayFormat(SYNC_DATE_FORMAT)
    window._filter_until.setDate(QtCore.QDate.currentDate())
    custom_h.addWidget(window._filter_until)
    custom_h.addStretch(1)
    filter_v.addWidget(window._filter_custom_row)

    def _toggle_custom_visibility() -> None:
        is_custom = window._filter_combo.currentData() == "custom"
        window._filter_custom_row.setVisible(is_custom)

    window._filter_combo.currentIndexChanged.connect(
        lambda _idx: _toggle_custom_visibility(),
    )
    _toggle_custom_visibility()

    form.addRow(window._help_label("Sync date range", "desktop-app-sync-range"), filter_block)

    performance = QtWidgets.QWidget()
    performance_v = QtWidgets.QVBoxLayout(performance)
    performance_v.setContentsMargins(0,0,0,0)
    window._speed_combo = QtWidgets.QComboBox()
    for label, key in (("Gentle", "gentle"),("Balanced", "balanced"),("Maximum", "maximum")):
        window._speed_combo.addItem(label,key)
    mode = initial_settings.background_import_speed or "balanced"
    window._speed_combo.setCurrentIndex(window._speed_combo.findData(mode))
    performance_v.addWidget(window._speed_combo)
    from ..game_activity import background_workers
    window._speed_combo.currentIndexChanged.connect(lambda _index:window._concurrency_slider.setValue(
        background_workers(window._speed_combo.currentData(),PARSE_CONCURRENCY_USEFUL_MAX)))
    window._speed_combo.setAccessibleName("Background import speed")
    performance_v.addWidget(settings_timing(QtWidgets, NEEDS_RESTART, window._speed_combo))
    window._pause_history_check = QtWidgets.QCheckBox("Pause history import while I'm in a game")
    window._pause_history_check.setChecked(initial_settings.pause_history_in_game is not False)
    window._battery_check = QtWidgets.QCheckBox("Pause on battery")
    window._battery_check.setChecked(initial_settings.pause_on_battery is True)
    performance_v.addWidget(window._pause_history_check)
    performance_v.addWidget(window._battery_check)
    performance_v.addWidget(settings_timing(QtWidgets, SAVED_WITH_SAVE, window._pause_history_check, window._battery_check))
    form.addRow(window._help_label("Performance", "desktop-app-performance"), performance)

    window._log_combo = QtWidgets.QComboBox()
    window._log_combo.addItems(["INFO", "DEBUG", "WARNING", "ERROR"])
    form.addRow("Log level", window._log_combo)

    # Replay folders: a real list, because StarCraft II writes
    # replays to a separate folder per (region, toon) — players
    # who use multiple regions or BattleTags need more than
    # one entry. Detected folders are always watched unless the
    # user removes them here; saving an empty list resets the
    # agent to detection alone.
    #
    # Unsaved removals, sent with Save so only folders the user
    # removed become exclusions (not ones that appeared later).
    window._folders_removed: list[str] = []
    # Set while the list has unsaved edits, so a folder the agent
    # starts watching meanwhile is appended, not a list rebuild.
    window._folders_dirty = False
    folder_block = QtWidgets.QWidget()
    folder_v = QtWidgets.QVBoxLayout(folder_block)
    folder_v.setContentsMargins(0, 0, 0, 0)
    folder_v.setSpacing(6)

    window._folder_list = QtWidgets.QListWidget()
    window._folder_list.setSelectionMode(
        QtWidgets.QAbstractItemView.ExtendedSelection,
    )
    window._folder_list.setUniformItemSizes(False)
    window._folder_list.setAlternatingRowColors(False)
    window._folder_list.setMinimumHeight(96)
    window._folder_list.setHorizontalScrollBarPolicy(
        QtCore.Qt.ScrollBarAsNeeded,
    )
    window._folder_list.setToolTip(
        "Each region and battle.net handle stores replays in a "
        "different folder. Add every Replays/Multiplayer folder "
        "you want synced.",
    )
    folder_v.addWidget(window._folder_list)
    from .folder_rows import build_folder_rows
    window._folder_rows = build_folder_rows(window._folder_list, QtCore=QtCore, QtGui=QtGui,
                                          QtWidgets=QtWidgets, open_folder=open_folder)
    window._folder_delete = QtGui.QShortcut(QtGui.QKeySequence.Delete, window._folder_list)
    window._folder_delete.setContext(QtCore.Qt.WidgetWithChildrenShortcut)
    window._folder_delete.activated.connect(window._remove_folder_rows)
    window._folder_empty = QtWidgets.QWidget()
    empty_layout = QtWidgets.QVBoxLayout(window._folder_empty)
    empty_layout.addWidget(QtWidgets.QLabel("We couldn't find StarCraft II replays"))
    locate = QtWidgets.QPushButton("Locate folder…")
    locate.clicked.connect(window._click_choose_folder)
    empty_layout.addWidget(locate)
    folder_v.addWidget(window._folder_empty)
    window._folder_undo = QtWidgets.QPushButton("Undo folder change")
    window._folder_undo.clicked.connect(window._undo_folder_change)
    window._folder_undo.hide()
    folder_v.addWidget(window._folder_undo)

    folder_btns = QtWidgets.QHBoxLayout()
    folder_btns.setSpacing(6)
    add_btn = QtWidgets.QPushButton("Add folder…")
    add_btn.clicked.connect(window._add_folder_row)
    folder_btns.addWidget(add_btn)
    remove_btn = QtWidgets.QPushButton("Remove selected")
    remove_btn.setToolTip(
        "Stop watching the selected folders. A folder found "
        "automatically stays unwatched until Auto-detect or "
        "Add folder… brings it back.",
    )
    remove_btn.clicked.connect(window._remove_folder_rows)
    folder_btns.addWidget(remove_btn)
    auto_btn = QtWidgets.QPushButton("Auto-detect")
    auto_btn.setToolTip(
        "Scan your StarCraft II Accounts folder and add every "
        "Replays/Multiplayer directory found. Existing entries "
        "are preserved; only missing folders are appended.",
    )
    auto_btn.clicked.connect(window._auto_detect_folders)
    folder_btns.addWidget(auto_btn)
    folder_btns.addStretch(1)
    folder_v.addLayout(folder_btns)

    form.addRow(window._help_label("Replay folders", "replay-folders"), folder_block)

    from .. import autostart as autostart_mod  # local import keeps import-time safe

    window._autostart_check = QtWidgets.QCheckBox(
        "Run SC2 Tools Agent on Windows startup",
    )
    window._autostart_check.setEnabled(autostart_mod.is_supported())
    if not autostart_mod.is_supported():
        window._autostart_check.setToolTip(
            "Only available on Windows. On macOS/Linux configure "
            "your session manager to launch the agent at login.",
        )
    form.addRow("", window._autostart_check)

    window._minimized_check = QtWidgets.QCheckBox(
        "Start minimised to the system tray",
    )
    form.addRow("", window._minimized_check)

    window._notifications_combo = QtWidgets.QComboBox()
    for label, mode in (("Off", "off"), ("Important", "important"), ("Every game", "all")):
        window._notifications_combo.addItem(label, mode)
    window._notifications_combo.setToolTip("Every game includes a result notification on this PC. Replay-history imports stay quiet.")
    form.addRow("Desktop notifications", window._notifications_combo)
    window._milestones_check = QtWidgets.QCheckBox("Show game milestones in the tray")
    milestone_help = "Turn on game milestones in your web bell and choose Important or Every game above."
    window._milestones_check.setToolTip(milestone_help)
    window._milestones_check.setAccessibleDescription(milestone_help)
    form.addRow(window._milestones_check)
    window._weekly_report_check = QtWidgets.QCheckBox("Show weekly reports in the tray")
    weekly_help = "Get a private weekly report reminder after play. Choose Important or Every game above."
    window._weekly_report_check.setToolTip(weekly_help)
    window._weekly_report_check.setAccessibleDescription(weekly_help)
    form.addRow(window._weekly_report_check)
    window._close_behavior_combo = QtWidgets.QComboBox()
    window._close_behavior_combo.addItem("Keep syncing in the tray", True)
    window._close_behavior_combo.addItem("Quit SC2 Tools", False)
    form.addRow("When closing the window", window._close_behavior_combo)

    # Auto-update consent — the state flag shipped in 0.13.4's
    # updater hardening but had no UI surface, so the only way
    # to opt out was hand-editing agent.json. Unchecking turns
    # the updater notify-only (the badge + notice still appear;
    # nothing installs behind the user's back).
    window._autoupdate_check = QtWidgets.QCheckBox(
        "Install agent updates automatically (recommended)",
    )
    window._autoupdate_check.setToolTip(
        "When enabled, new releases download and install "
        "silently and the agent restarts minimised. When "
        "disabled, the agent only notifies — except below the "
        "cloud's minimum supported version, where the update "
        "is required to keep working.",
    )
    form.addRow("", window._autoupdate_check)

    capture_block = QtWidgets.QWidget()
    capture_v = QtWidgets.QVBoxLayout(capture_block)
    capture_v.setContentsMargins(0, 0, 0, 0)
    capture_v.setSpacing(6)
    window._replay_capture_check = QtWidgets.QCheckBox(
        "Automatically capture map replays (uses more CPU)",
    )
    window._replay_capture_check.setAccessibleDescription(APPLIES_INSTANTLY)
    capture_v.addWidget(window._replay_capture_check)
    window._replay_capture_feedback = window._instant_feedback()
    capture_v.addWidget(window._replay_capture_feedback)
    capture_help = QtWidgets.QLabel(
        "Automatically records detailed movement, attacks, spells and creep "
        "for new and re-synced replays. Uses StarCraft II in the background "
        "and substantial CPU for several minutes per replay. Saved recordings "
        "are reused. For games already synced, use Re-sync once. When off, "
        "Generate accurate playback on the website records one replay."
    )
    capture_help.setObjectName("muted")
    capture_help.setWordWrap(True)
    capture_v.addWidget(capture_help)
    form.addRow(capture_block)

    def section(name, fields):
        group = QtWidgets.QGroupBox(name, page)
        destination = QtWidgets.QFormLayout(group)
        destination.setRowWrapPolicy(QtWidgets.QFormLayout.WrapLongRows)
        for field, timing, *controls in fields:
            row = form.takeRow(field)
            caption = row.labelItem.widget() if row.labelItem else None
            buddy = controls[0] if controls else field
            if isinstance(caption, QtWidgets.QLabel) and buddy.focusPolicy() != QtCore.Qt.NoFocus:
                caption.setBuddy(buddy)
            body = _with_timing(QtWidgets, field, timing, *controls) if timing else field
            if caption is not None:
                destination.addRow(caption, body)
            else:
                destination.addRow(body)
        return group, destination

    replays, _ = section("Replays", (
        (folder_block, APPLIES_INSTANTLY, add_btn, remove_btn, auto_btn, locate, window._folder_undo),
        (filter_block, SAVED_WITH_SAVE, window._filter_combo, window._filter_since, window._filter_until),
        (window._handle_input, SAVED_WITH_SAVE),
    ))
    app_group, _ = section("App", (
        (window._autostart_check, SAVED_WITH_SAVE),
        (window._minimized_check, SAVED_WITH_SAVE),
        (window._notifications_combo, SAVED_WITH_SAVE),
        (window._milestones_check, SAVED_WITH_SAVE),
        (window._weekly_report_check, SAVED_WITH_SAVE),
        (window._close_behavior_combo, SAVED_WITH_SAVE),
    ))
    updates, _ = section("Updates", ((window._autoupdate_check, SAVED_WITH_SAVE),))
    map_replay, _ = section("Map replay", ((capture_block, None),))
    advanced, advanced_form = section("Advanced", (
        (api_block, None, window._api_input),
        (concurrency_block, None),
        (upload_conc_block, APPLIES_INSTANTLY, *window._upload_conc_buttons.values()),
        (upload_batch_block, SAVED_WITH_SAVE, window._upload_batch_slider),
        (performance, None),
        (window._log_combo, NEEDS_RESTART),
    ))
    for group in (replays, app_group, updates):
        v.addWidget(group)
    from .build_checkin_settings import CheckinSettingsGroup

    # Applies immediately (cloud preference), like the toggles above.
    window._checkin_settings = CheckinSettingsGroup(
        controller=checkin_controller,
        available=checkin_available,
        on_help=lambda: window._open_help("build-check-in"),
        on_preview=lambda kind: window._checkin_host.show_preview(kind),
        on_reset_positions=lambda: window._checkin_host.reset_positions(),
        on_open_queue=lambda: window._open_checkin_queue(),
    )
    obs = window._build_obs_card()
    v.addWidget(obs)
    v.addWidget(window._checkin_settings)
    v.addWidget(map_replay)
    window._settings_advanced = QtWidgets.QPushButton("Show Advanced settings")
    window._settings_advanced.setCheckable(True)
    window._settings_advanced.toggled.connect(advanced.setVisible)
    window._settings_advanced.toggled.connect(lambda opened: window._settings_advanced.setText(
        "Hide Advanced settings" if opened else "Show Advanced settings",
    ))
    advanced.hide()
    reset = QtWidgets.QPushButton("Reset advanced draft defaults")
    reset.clicked.connect(window._reset_advanced_draft_defaults)
    advanced_form.addRow(reset)
    v.addWidget(window._settings_advanced)
    v.addWidget(advanced)
    anchors = {"Replays": replays, "App": app_group, "Updates": updates, "Streaming & OBS": obs,
               "Build check-in": window._checkin_settings, "Map replay": map_replay,
               "Advanced": window._settings_advanced}
    section_select.addItem("Jump to a section…", None)
    for section_name in anchors:
        section_select.addItem(section_name, section_name)
    def scroll_to_section(anchor):
        top = anchor.mapTo(page, QtCore.QPoint()).y() - theme.SPACE_S
        scroller.verticalScrollBar().setValue(top)

    def open_section(name):
        anchor = anchors.get(name)
        if anchor is None:
            return
        if name == "Advanced" and not window._settings_advanced.isChecked():
            window._settings_advanced.setChecked(True)
            v.activate()
            # Advanced changes the scroll range. Wait for the viewport's
            # geometry before jumping, so the old maximum cannot clamp it.
            QtCore.QTimer.singleShot(0, scroller, lambda: scroll_to_section(anchor))
        else:
            scroll_to_section(anchor)
        section_select.setCurrentIndex(0)

    section_select.activated.connect(lambda row: open_section(section_select.itemData(row)))

    window._settings_status = QtWidgets.QLabel("")
    window._settings_status.setObjectName("muted")
    window._settings_status.setWordWrap(True)
    window._settings_status.setAccessibleName("Settings save status")
    v.addWidget(window._settings_status)
    window._settings_restart_button = QtWidgets.QPushButton("Restart agent now")
    window._settings_restart_button.clicked.connect(window._confirm_restart)
    window._settings_restart_button.hide()
    v.addWidget(window._settings_restart_button, alignment=QtCore.Qt.AlignRight)
    window._settings_page = page
    window._settings_draft_footer = QtWidgets.QWidget(page)
    row = QtWidgets.QHBoxLayout(window._settings_draft_footer)
    row.setContentsMargins(0, 0, 0, 0)
    window._settings_draft_label = QtWidgets.QLabel()
    row.addWidget(window._settings_draft_label, 1)
    revert = QtWidgets.QPushButton("Revert")
    revert.clicked.connect(window._revert_settings_draft)
    row.addWidget(revert)
    save_btn = window._save_settings_btn = QtWidgets.QPushButton("Save (Ctrl+S)")
    save_btn.setObjectName("primary")
    save_btn.clicked.connect(window._click_save_settings)
    row.addWidget(save_btn)
    v.addWidget(window._settings_draft_footer)

    maintenance = QtWidgets.QGroupBox("Maintenance")
    maintenance_layout = QtWidgets.QVBoxLayout(maintenance)
    warning = QtWidgets.QLabel("Re-sync rebuilds your local upload cursor and revisits your replay library.")
    warning.setWordWrap(True)
    maintenance_layout.addWidget(warning)
    window._resync_btn.setText("Re-sync replay library…")
    window._resync_btn.setObjectName("dangerButton")
    maintenance_layout.addWidget(window._resync_btn)
    v.addWidget(maintenance)
    v.addStretch(1)
    scroller.setWidget(page)
    from .qt_helpers import install_responsive_forms
    window._settings_responsive_forms = install_responsive_forms(scroller, QtCore=QtCore, QtWidgets=QtWidgets)
    window._settings_section_index = _install_section_index(
        scroller, section_label, section_select, anchors, open_section, QtCore=QtCore, QtWidgets=QtWidgets,
    )
    return scroller
