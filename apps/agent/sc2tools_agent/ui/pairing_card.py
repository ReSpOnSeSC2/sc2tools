"""Pairing card with explicit requesting, expired, offline and recovery states."""
from datetime import datetime, timezone
from urllib.parse import urlencode, urlsplit, urlunsplit


def pairing_url(dashboard_url, code):
    parsed = urlsplit(dashboard_url)
    return urlunsplit((parsed.scheme, parsed.netloc, "/devices",
                       urlencode({"code": code, "src": "agent"}), ""))


def build_pairing_card(parent, *, QtCore, QtWidgets, open_browser, copy_text,
                       dashboard_url, retry_now, new_code, link_again, open_log, open_help):
    class PairingCard(QtWidgets.QFrame):
        def __init__(self):
            super().__init__(parent)
            self.setObjectName("cardElevated")
            self.code = ""
            self.expires_at = None
            self.kind = "requesting"
            layout = QtWidgets.QVBoxLayout(self)
            layout.setContentsMargins(20, 18, 20, 20)
            self.heading = QtWidgets.QLabel("Link this PC")
            self.heading.setObjectName("h2")
            layout.addWidget(self.heading)
            self.message = QtWidgets.QLabel()
            self.message.setWordWrap(True)
            layout.addWidget(self.message)
            self.spinner = QtWidgets.QProgressBar()
            self.spinner.setRange(0, 0)
            self.spinner.setMaximumHeight(6)
            self.spinner.setAccessibleName("Getting your code")
            layout.addWidget(self.spinner)
            self.code_label = QtWidgets.QLabel()
            self.code_label.setObjectName("code")
            self.code_label.setAlignment(QtCore.Qt.AlignCenter)
            self.code_label.setTextInteractionFlags(QtCore.Qt.TextSelectableByMouse)
            layout.addWidget(self.code_label)
            self.countdown = QtWidgets.QLabel()
            layout.addWidget(self.countdown)
            self.primary = QtWidgets.QPushButton()
            self.primary.setObjectName("primary")
            self.primary.clicked.connect(self.act)
            layout.addWidget(self.primary)
            row = QtWidgets.QHBoxLayout()
            self.copy = QtWidgets.QPushButton("Copy code")
            self.copy.clicked.connect(lambda: copy_text(self.code) if self.code else None)
            row.addWidget(self.copy)
            self.refresh = QtWidgets.QPushButton("Get a new code")
            self.refresh.setFlat(True)
            self.refresh.clicked.connect(new_code)
            row.addWidget(self.refresh)
            self.log = QtWidgets.QPushButton("Open activity log")
            self.log.clicked.connect(open_log)
            row.addWidget(self.log)
            row.addStretch()
            self.help = QtWidgets.QPushButton("Need help?")
            self.help.setFlat(True)
            self.help.clicked.connect(open_help)
            row.addWidget(self.help)
            layout.addLayout(row)
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(1000)
            self.timer.timeout.connect(self.tick)
            self.timer.start()
            self.collapse = QtCore.QTimer(self)
            self.collapse.setSingleShot(True)
            self.collapse.setInterval(4000)
            self.collapse.timeout.connect(self.hide)
            self.apply("requesting")

        def act(self):
            if self.kind == "showing" and self.code:
                open_browser(pairing_url(dashboard_url, self.code))
            elif self.kind == "unlinked":
                link_again()
            elif self.kind == "expired":
                new_code()
            else:
                retry_now()

        def apply(self, value):
            self.collapse.stop()
            self.kind = value if isinstance(value, str) else value.kind
            self.code = getattr(value, "code", "")
            self.expires_at = getattr(value, "expires_at", None)
            labels = {
                "requesting": ("Getting your code…", "Getting your code…"),
                "showing": ("Use this code to link SC2 Tools to your account.", "Link this PC in your browser"),
                "unreachable": ("Can't reach sc2tools.com. Check your internet connection; we'll keep trying.", "Retry now"),
                "expired": ("This code expired. We'll keep trying to get a fresh code.", "Get a new code"),
                "unlinked": ("This PC was unlinked from your account. Your settings and replay history are kept.", "Link again"),
                "paired": ("Paired - syncing starts now", "Linked"),
            }
            message, button = labels[self.kind]
            self.message.setText(message)
            self.message.setStyleSheet("color: #55ce89" if self.kind == "paired" else "")
            self.primary.setText(button)
            self.primary.setEnabled(self.kind not in ("requesting", "paired"))
            self.spinner.setVisible(self.kind == "requesting")
            self.code_label.setText(self.code)
            self.code_label.setVisible(bool(self.code))
            self.copy.setVisible(bool(self.code))
            self.refresh.setVisible(self.kind == "showing")
            self.log.setVisible(self.kind in ("expired", "unreachable"))
            self.countdown.setVisible(self.kind == "showing")
            self.show()
            self.tick()
            if self.kind == "paired":
                self.collapse.start()

        def tick(self):
            if self.kind != "showing" or self.expires_at is None:
                return
            remaining = max(0, int((self.expires_at - datetime.now(timezone.utc)).total_seconds()))
            self.countdown.setText(f"Expires in {remaining // 60}:{remaining % 60:02d}")
            if remaining == 0:
                self.apply("expired")
                new_code()
    return PairingCard()
