"""Widget layout for the Streams page. The page owns all streaming state and callbacks."""

from . import theme
from .qt_helpers import install_wheel_guard

AUTO_REARM_LABEL = ("Prepare the next pair automatically", "after both streams end")


def build_stream_studio(page, QtCore, QtWidgets):
    content = QtWidgets.QWidget()
    content.setObjectName("studioContent")
    layout = QtWidgets.QVBoxLayout(content)
    layout.setContentsMargins(theme.PAGE_MARGIN_X, theme.PAGE_MARGIN_Y, theme.PAGE_MARGIN_X, theme.PAGE_MARGIN_Y)
    layout.setSpacing(theme.SPACE_L)
    heading = QtWidgets.QHBoxLayout()
    heading.addWidget(page._label("Streams", name="h1"))
    heading.addStretch()
    heading.addWidget(page._label("SC2TOOLS  /  STREAM STUDIO", name="studioEyebrow"))
    layout.addLayout(heading)

    layout.addWidget(_command(page, QtCore, QtWidgets))
    layout.addLayout(_youtube(page, QtCore, QtWidgets))
    layout.addLayout(_accounts(page, QtWidgets))
    layout.addWidget(_youtube_setup(page, QtWidgets))
    layout.addWidget(_obs_details(page, QtCore, QtWidgets))
    layout.addStretch()
    _guard_fields(page, QtCore)
    return content


def _command(page, QtCore, QtWidgets):
    command, command_layout = page._card("studioCommand")
    label_row = QtWidgets.QHBoxLayout()
    label_row.addWidget(page._label("ONE TITLE. EVERY DESTINATION.", name="studioEyebrow"))
    label_row.addStretch()
    page.counter = page._label("0 / 70", name="studioCounter")
    label_row.addWidget(page.counter)
    command_layout.addLayout(label_row)
    page.title_input = QtWidgets.QLineEdit()
    page.title_input.setObjectName("streamTitle")
    page.title_input.setMaxLength(500)
    page.title_input.setPlaceholderText("Give your next stream a title")
    page.title_input.setMinimumHeight(theme.STREAM_TITLE_HEIGHT)
    page.title_input.textEdited.connect(page._title_edited)
    page.title_input.returnPressed.connect(page.save_title)
    command_layout.addWidget(page.title_input)
    from .stream_title_controls import StreamTitleControls
    page.title_controls = StreamTitleControls(page, command_layout, QtCore, QtWidgets)
    description_header = QtWidgets.QHBoxLayout()
    page.description_label = page._label("YouTube description", name="studioEyebrow")
    page.description_scope = page._label("Applies to both YouTube formats", True)
    description_header.addWidget(page.description_label)
    description_header.addWidget(page.description_scope, 1)
    command_layout.addLayout(description_header)
    page.description_input = QtWidgets.QPlainTextEdit()
    page.description_input.setObjectName("streamDescription")
    page.description_input.setFixedHeight(theme.STREAM_DESCRIPTION_HEIGHT)
    page.description_input.textChanged.connect(page._description_edited)
    command_layout.addWidget(page.description_input)
    page.description_link_note = page._label("The vertical-to-horizontal watch link is added automatically.", True)
    command_layout.addWidget(page.description_link_note)
    actions = QtWidgets.QHBoxLayout()
    actions.setSpacing(theme.SPACE_S)
    page.save_button = page._button("Save title and description", page.save_title, primary=True)
    page.prepare_button = page._button("Prepare YouTube session", lambda: page.job({"action": "prepare"}))
    page.prepare_button.setToolTip("Save your title, description and YouTube setup, then prepare both destinations before starting Aitum.")
    actions.addWidget(page.save_button)
    actions.addWidget(page.prepare_button)
    actions.addStretch()
    actions.addWidget(page._label("YouTube · Twitch · Kick", True))
    command_layout.addLayout(actions)
    page.notice = page._label("Loading stream settings…", name="studioNotice")
    command_layout.addWidget(page.notice)
    return command


def _youtube(page, QtCore, QtWidgets):
    youtube_section = QtWidgets.QVBoxLayout()
    youtube_section.setSpacing(theme.SPACE_S)
    youtube_header = QtWidgets.QHBoxLayout()
    youtube_header.addWidget(page._label("YouTube destinations", name="h2"))
    youtube_header.addStretch()
    page.import_google_button = page._button("Import Google client…", page.import_google, quiet=True)
    youtube_header.addWidget(page.import_google_button)
    page.refresh_accounts_button = page._button("Refresh connections", lambda: page.job({"action": "refresh_accounts"}), quiet=True)
    youtube_header.addWidget(page.refresh_accounts_button)
    page.youtube_setup_button = QtWidgets.QPushButton("Setup")
    page.youtube_setup_button.setObjectName("quietButton")
    page.youtube_setup_button.setCursor(QtCore.Qt.PointingHandCursor)
    page.youtube_setup_button.clicked.connect(page.open_setup)
    youtube_header.addWidget(page.youtube_setup_button)
    page.youtube_connect_button = page._button("Connect YouTube", lambda: page.job({"action": "connect_youtube"}), quiet=True)
    youtube_header.addWidget(page.youtube_connect_button)
    youtube_section.addLayout(youtube_header)
    page.platform_labels["youtube"] = page._label("YouTube · connection required", True)
    youtube_section.addWidget(page.platform_labels["youtube"])
    destinations = QtWidgets.QHBoxLayout()
    destinations.setSpacing(theme.SPACE_M)
    for scope, title, canvas, ratio in (
        ("horizontal", "Horizontal", "OBS main canvas", "16:9"),
        ("portrait", "Vertical", "OBS vertical canvas", "9:16"),
    ):
        destinations.addWidget(_destination(page, scope, title, canvas, ratio, QtCore, QtWidgets), 1)
    youtube_section.addLayout(destinations)
    session_row = QtWidgets.QHBoxLayout()
    session_row.setSpacing(theme.SPACE_S)
    page.auto_label = page._label("Next session: manual", True)
    session_row.addWidget(page.auto_label, 1)
    session_row.addWidget(page._button("Check / recover", lambda: page.job({"action": "recover"}), quiet=True))
    page.pause_auto_button = page._button("Pause auto", lambda: page.job({"action": "pause_auto"}), quiet=True)
    page.resume_auto_button = page._button("Enable auto", lambda: page.job({"action": "resume_auto"}), quiet=True)
    session_row.addWidget(page.pause_auto_button)
    session_row.addWidget(page.resume_auto_button)
    youtube_section.addLayout(session_row)
    youtube_section.addWidget(page._label("Start the two YouTube Output buttons in Aitum when both destinations show Ready.", True))
    return youtube_section


def _destination(page, scope, title, canvas, ratio, QtCore, QtWidgets):
    card, card_layout = page._card("studioDestination")
    row = QtWidgets.QHBoxLayout()
    row.setSpacing(theme.SPACE_M)
    marker = page._label(ratio, name="canvasLandscape" if scope == "horizontal" else "canvasPortrait")
    marker.setAlignment(QtCore.Qt.AlignCenter)
    size = theme.STREAM_CANVAS_LANDSCAPE if scope == "horizontal" else theme.STREAM_CANVAS_PORTRAIT
    marker.setFixedSize(*size)
    marker_box = QtWidgets.QWidget()
    marker_box.setObjectName("studioTransparent")
    marker_box.setFixedWidth(theme.STREAM_CANVAS_WIDTH)
    marker_layout = QtWidgets.QHBoxLayout(marker_box)
    marker_layout.setContentsMargins(0, 0, 0, 0)
    marker_layout.addWidget(marker, 0, QtCore.Qt.AlignCenter)
    row.addWidget(marker_box)
    names = QtWidgets.QVBoxLayout()
    names.setSpacing(theme.SPACE_XS)
    names.addWidget(page._label(title, name="studioDestinationTitle"))
    names.addWidget(page._label(canvas, True))
    row.addLayout(names, 1)
    page.format_labels[scope] = page._badge("Setup needed")
    row.addWidget(page.format_labels[scope], 0, QtCore.Qt.AlignTop)
    connect = page._button(
        "Connect YouTube",
        lambda _checked=False, key=scope: page.connect_youtube(key),
        quiet=True,
    )
    connect.setToolTip("Connect your YouTube account in your browser.")
    connect.setVisible(False)
    page.format_connect_buttons[scope] = connect
    row.addWidget(connect, 0, QtCore.Qt.AlignTop)
    card_layout.addLayout(row)
    footer = QtWidgets.QHBoxLayout()
    footer.addWidget(page._label("Reusable key · separate link & chat", True), 1)
    view = QtWidgets.QPushButton("View ↗")
    view.setObjectName("quietButton")
    view.setCursor(QtCore.Qt.PointingHandCursor)
    view.clicked.connect(lambda _checked=False, key=scope: page.view_stream(key))
    view.setEnabled(False)
    page.format_links[scope] = view
    footer.addWidget(view)
    card_layout.addLayout(footer)
    return card


def _accounts(page, QtWidgets):
    accounts = QtWidgets.QHBoxLayout()
    accounts.setSpacing(theme.SPACE_M)
    for platform in ("twitch", "kick"):
        card, account_layout = page._card()
        row = QtWidgets.QHBoxLayout()
        text = QtWidgets.QVBoxLayout()
        text.setSpacing(theme.SPACE_XS)
        title_row = QtWidgets.QHBoxLayout()
        title_row.addWidget(page._label(platform.title(), name="h2"))
        page.platform_badges[platform] = page._badge("Not connected")
        title_row.addWidget(page.platform_badges[platform])
        title_row.addStretch()
        text.addLayout(title_row)
        page.platform_labels[platform] = page._label("Connect your streaming account", True)
        text.addWidget(page.platform_labels[platform])
        row.addLayout(text, 1)
        row.addWidget(page._button("Connect", lambda _checked=False, name=platform: page.connect_platform(name), quiet=True))
        account_layout.addLayout(row)
        accounts.addWidget(card, 1)
    return accounts


def _youtube_setup(page, QtWidgets):
    setup_section, page.setup_toggle, page.setup_box, setup_layout = page._disclosure("YouTube setup", "Channel, keys & session options")
    setup = QtWidgets.QFormLayout()
    setup.setHorizontalSpacing(theme.SPACE_L)
    setup.setVerticalSpacing(theme.SPACE_M)
    setup.setFieldGrowthPolicy(QtWidgets.QFormLayout.AllNonFixedFieldsGrow)
    page.channel_combo = QtWidgets.QComboBox()
    page.horizontal_combo = QtWidgets.QComboBox()
    page.portrait_combo = QtWidgets.QComboBox()
    for combo in (page.channel_combo, page.horizontal_combo, page.portrait_combo):
        combo.addItem("Choose…", None)
    setup.addRow("Channel", page.channel_combo)
    setup.addRow("Horizontal reusable key", page.horizontal_combo)
    setup.addRow("Vertical reusable key", page.portrait_combo)
    page.catalog_note = page._label("Connect YouTube to load your channel and reusable keys.", True)
    setup.addRow("", page.catalog_note)
    page.privacy = QtWidgets.QComboBox()
    for text, data in (("Choose visibility…", None), ("Unlisted (for testing)", "unlisted"), ("Private", "private"), ("Public", "public")):
        page.privacy.addItem(text, data)
    setup.addRow("Visibility", page.privacy)
    page.audience = QtWidgets.QComboBox()
    page.audience.addItem("Choose audience setting…", None)
    page.audience.addItem("No, not made for kids", False)
    page.audience.addItem("Yes, made for kids", True)
    setup.addRow("Audience", page.audience)
    page.auto_check = QtWidgets.QCheckBox(" ".join(AUTO_REARM_LABEL))
    page.auto_check.setAccessibleName(page.auto_check.text())
    page.auto_check.setChecked(False)
    setup.addRow(page.auto_check)
    from ..streaming.obs_reader import DEFAULT_OUTPUTS
    page.output_inputs = {}
    for scope, text in (("horizontal", "OBS horizontal output name"), ("portrait", "OBS vertical output name")):
        field = QtWidgets.QLineEdit(DEFAULT_OUTPUTS[scope])
        page.output_inputs[scope] = field
        setup.addRow(text, field)
    setup_layout.addLayout(setup)
    setup_actions = QtWidgets.QHBoxLayout()
    setup_actions.addWidget(page._button("Refresh keys", lambda: page.job({"action": "refresh_keys"})))
    setup_actions.addWidget(page._button("Save YouTube setup", page.configure, primary=True))
    setup_actions.addStretch()
    setup_layout.addLayout(setup_actions)
    page.connection_note = page._label("Authorize your accounts through SC2Tools once. Provider credentials stay on the server.", True)
    setup_layout.addWidget(page.connection_note)
    account_actions = QtWidgets.QHBoxLayout()
    page.local_setup_button = page._button("Advanced local setup…", page.change_connection_mode, quiet=True)
    account_actions.addWidget(page.local_setup_button)
    account_actions.addStretch()
    setup_layout.addLayout(account_actions)
    return setup_section


def _obs_details(page, QtCore, QtWidgets):
    obs_section, page.obs_toggle, page.obs_box, obs_layout = page._disclosure("OBS connection details", "Server & key for the selected YouTube destination")
    obs_layout.addWidget(page._label("Save your channel and both reusable keys with Save YouTube setup first. Then choose a destination and Fetch its server and key for the matching Aitum output in OBS.", True))
    obs_form = QtWidgets.QFormLayout()
    page.obs_destination = QtWidgets.QComboBox()
    page.obs_destination.addItem("Horizontal", "horizontal")
    page.obs_destination.addItem("Vertical", "portrait")
    obs_form.addRow("Destination", page.obs_destination)
    page.obs_selected_key = page._label("Save your YouTube setup first.", True)
    obs_form.addRow("Reusable key", page.obs_selected_key)
    page.obs_output_name = page._label("", True)
    obs_form.addRow("OBS / Aitum output", page.obs_output_name)
    page.obs_server = QtWidgets.QLineEdit()
    page.obs_server.setReadOnly(True)
    obs_form.addRow("Server URL", page.obs_server)
    page.obs_key = QtWidgets.QLineEdit()
    page.obs_key.setReadOnly(True)
    page.obs_key.setEchoMode(QtWidgets.QLineEdit.Password)
    obs_form.addRow("Stream key", page.obs_key)
    obs_layout.addLayout(obs_form)
    obs_actions = QtWidgets.QHBoxLayout()
    page.obs_fetch_button = page._button("Fetch connection details", page.fetch_obs_connection)
    page.obs_copy_server = QtWidgets.QPushButton("Copy server")
    page.obs_copy_key = QtWidgets.QPushButton("Copy key")
    for button, field, message in (
        (page.obs_copy_server, page.obs_server, "Server URL copied."),
        (page.obs_copy_key, page.obs_key, "Stream key copied. Paste it into the selected OBS output."),
    ):
        button.setObjectName("quietButton")
        button.setCursor(QtCore.Qt.PointingHandCursor)
        button.clicked.connect(lambda _checked=False, item=field, text=message: page.copy_obs_detail(item, text))
    page.obs_reveal = QtWidgets.QCheckBox("Reveal key")
    page.obs_reveal.toggled.connect(page.reveal_obs_key)
    for control in (page.obs_fetch_button, page.obs_copy_server, page.obs_copy_key, page.obs_reveal):
        obs_actions.addWidget(control)
    obs_actions.addStretch()
    obs_layout.addLayout(obs_actions)
    page.obs_note = page._label("Connection details appear only after Fetch; the key stays hidden until you reveal or copy it.", True)
    obs_layout.addWidget(page.obs_note)
    page.obs_destination.currentIndexChanged.connect(page._obs_selection_changed)
    page.obs_toggle.toggled.connect(lambda opened: None if opened else page._clear_obs_connection())
    return obs_section


def _guard_fields(page, QtCore):
    # Scrolling the page over an unfocused dropdown must never change a
    # saved choice (channel, key, visibility, audience, destination).
    for combo in (page.channel_combo, page.horizontal_combo, page.portrait_combo, page.privacy, page.audience, page.obs_destination):
        install_wheel_guard(combo, QtCore)
    for combo, key in ((page.channel_combo, "channel_id"), (page.horizontal_combo, "horizontal_id"), (page.portrait_combo, "portrait_id"), (page.privacy, "privacy"), (page.audience, "made_for_kids")):
        combo.currentIndexChanged.connect(lambda _index, name=key: page._setup_edited(name))
    page.auto_check.toggled.connect(lambda _checked: page._setup_edited("auto_rearm"))
    for scope, field in page.output_inputs.items():
        field.textEdited.connect(lambda _text, name=scope: page._setup_edited("output_" + name))
