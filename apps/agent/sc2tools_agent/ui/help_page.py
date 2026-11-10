"""Native support page. Widgets/clipboard are touched only on the Qt thread."""
from __future__ import annotations

from . import theme
from ..support_diagnostics import ROW_IDS, diagnostic_bytes
from .support_actions import support_mailto
from .qt_helpers import build_flow_layout

_TITLES = {"storage": "Data folder and free space", "folders": "Replay folders", "analyzer": "Replay analyzer and sample replay",
    "version": "Agent version", "api": "Website connection", "profile": "Account link", "client_api": "StarCraft II client API",
    "obs": "OBS connection", "sync": "Sync queues"}
_CODES = {"ok": "OK", "unavailable": "Unavailable", "disabled": "Disabled", "cancelled": "Cancelled",
    "offline": "Cannot reach the website", "timeout": "Timed out", "signed_out": "Link this PC again",
    "missing_folders": "Check your folders or scan limit", "not_running": "Not running", "not_writable": "Folder is not writable",
    "invalid_response": "Unexpected response", "analysis_failed": "Sample analysis did not finish", "server_busy": "Service is busy",
    "rate_limited": "Service asked us to wait", "file": "File unavailable", "rejected": "Replay was rejected"}
_ERRORS = {"already_exists": "That file already exists. Choose a new filename.", "unsafe_path": "Choose an ordinary local folder and a new filename.",
    "file_changed": "A selected log changed. Review the bundle again.", "write_failed": "The bundle could not be saved. Choose another folder.",
    "unavailable": "Support tools are unavailable. Try again when startup has finished.", "invalid_plan": "Review the bundle again before saving."}


def build_help_page(parent, *, QtCore, QtWidgets, service, deliver, open_help, open_settings, link_again,
                    open_url, clipboard, busy_changed=lambda _busy: None):
    class HelpPage(QtWidgets.QWidget):
        def __init__(self):
            super().__init__(parent)
            self.setObjectName("agentHelpPage")
            self.run_nonce, self.result, self.intent = None, None, None
            self.cancelling = False
            outer = QtWidgets.QVBoxLayout(self)
            outer.setContentsMargins(0, 0, 0, 0)
            scroll = QtWidgets.QScrollArea()
            scroll.setWidgetResizable(True)
            body = QtWidgets.QWidget()
            layout = QtWidgets.QVBoxLayout(body)
            layout.setContentsMargins(theme.PAGE_MARGIN_X, theme.PAGE_MARGIN_Y, theme.PAGE_MARGIN_X, theme.PAGE_MARGIN_Y)
            title = QtWidgets.QLabel("Help and troubleshooting")
            title.setObjectName("h1")
            title.setWordWrap(True)
            layout.addWidget(title)
            intro = QtWidgets.QLabel("Run a read-only check, copy redacted support info, or review a local support bundle before saving it.")
            intro.setWordWrap(True)
            intro.setObjectName("muted")
            layout.addWidget(intro)
            links_widget = QtWidgets.QWidget()
            links = build_flow_layout(links_widget, QtCore=QtCore, QtWidgets=QtWidgets)
            for label, callback in (
                ("Desktop overview", lambda _checked=False: open_help("desktop-app-overview")),
                ("Support guide", lambda _checked=False: open_help("desktop-app-support")),
                ("Missing games", lambda _checked=False: open_help("my-game-didnt-show-up")),
                ("Replay folders", lambda _checked=False: open_help("replay-folders")),
                ("Updates", lambda _checked=False: open_help("desktop-app-updates")),
            ):
                button = QtWidgets.QPushButton(label)
                button.clicked.connect(callback)
                links.addWidget(button)
            layout.addWidget(links_widget)
            controls_widget = QtWidgets.QWidget()
            controls = build_flow_layout(controls_widget, QtCore=QtCore, QtWidgets=QtWidgets)
            self.run_button = QtWidgets.QPushButton("Run system check")
            self.cancel_button = QtWidgets.QPushButton("Cancel")
            self.copy_button = QtWidgets.QPushButton("Copy support info")
            self.bundle_button = QtWidgets.QPushButton("Save support bundle…")
            self.email_button = QtWidgets.QPushButton("Email support")
            for button in (self.run_button, self.cancel_button, self.copy_button, self.bundle_button, self.email_button):
                controls.addWidget(button)
            layout.addWidget(controls_widget)
            self.run_button.clicked.connect(lambda: self.start("check"))
            self.cancel_button.clicked.connect(self.cancel)
            self.copy_button.clicked.connect(lambda: self.start("copy"))
            self.bundle_button.clicked.connect(lambda: self.start("review"))
            self.email_button.clicked.connect(lambda: self.start("email"))
            self.status = QtWidgets.QLabel("Checks run only when you ask. No replay is uploaded and StarCraft II is never launched.")
            self.status.setWordWrap(True)
            self.status.setObjectName("muted")
            layout.addWidget(self.status)
            checks_card = QtWidgets.QFrame()
            checks_card.setObjectName("card")
            checks_layout = QtWidgets.QVBoxLayout(checks_card)
            checks_layout.setContentsMargins(theme.SPACE_L, theme.SPACE_M, theme.SPACE_L, theme.SPACE_M)
            checks_layout.setSpacing(theme.SPACE_XS)
            self.rows = {}
            for row_id in ROW_IDS:
                row = QtWidgets.QWidget()
                line = QtWidgets.QHBoxLayout(row)
                line.setContentsMargins(0, theme.SPACE_XS, 0, theme.SPACE_XS)
                label = QtWidgets.QLabel(_TITLES[row_id] + ": Unavailable")
                label.setWordWrap(True)
                label.setMinimumWidth(0)
                label.setSizePolicy(QtWidgets.QSizePolicy.Ignored, QtWidgets.QSizePolicy.Preferred)
                line.addWidget(label, 1)
                action = QtWidgets.QPushButton("Retry")
                action.hide()
                line.addWidget(action)
                action.clicked.connect(lambda _checked=False, key=row_id: self.fix(key))
                checks_layout.addWidget(row)
                self.rows[row_id] = label, action
            layout.addWidget(checks_card)
            body_layout = layout
            self.folder_details = QtWidgets.QLabel()
            self.folder_details.setWordWrap(True)
            body_layout.addWidget(self.folder_details)
            self.files = QtWidgets.QTreeWidget()
            self.files.setHeaderLabels(["Reviewed file", "Bytes", "Omissions"])
            self.files.setRootIsDecorated(False)
            self.files.setAccessibleName("Exact reviewed support bundle files")
            self.files.hide()
            body_layout.addWidget(self.files)
            self.save_button = QtWidgets.QPushButton("Save reviewed bundle…")
            self.save_button.clicked.connect(self.save)
            self.save_button.hide()
            body_layout.addWidget(self.save_button)
            body_layout.addStretch()
            scroll.setWidget(body)
            outer.addWidget(scroll, 1)
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(200)
            self.timer.timeout.connect(self.poll)
            self.timer.start()
            self.poll()

        def clear(self):
            self.run_nonce, self.result, self.intent = None, None, None
            self.files.clear()
            self.files.hide()
            self.save_button.hide()
            self.folder_details.clear()
            for row_id, (label, action) in self.rows.items():
                label.setText(_TITLES[row_id] + ": Unavailable")
                action.hide()

        def poll(self):
            current = service()
            busy = current.busy if current is not None else False
            if self.run_nonce is not None and (current is None or not current.is_current(self.run_nonce)):
                self.clear()
                self.cancelling = busy
                self.status.setText("Cancelling… waiting for the running check to finish." if busy else "The account or connection changed. Run a new check.")
            if self.cancelling and not busy:
                self.cancelling = False
                self.status.setText("Cancelled. You can run a new check.")
            for button in (self.run_button, self.copy_button, self.bundle_button, self.email_button):
                button.setEnabled(current is not None and not busy)
            self.cancel_button.setEnabled(busy and not self.cancelling)
            self.save_button.setEnabled(not busy and self.result is not None and self.result.kind == "review"
                and current is not None and current.is_current(self.result.run_nonce))
            for _label, action in self.rows.values():
                action.setEnabled(not busy)
            busy_changed(busy)

        def start(self, intent):
            current = service()
            if current is None or current.busy:
                self.status.setText("A support task is still finishing. Wait before trying again." if current else _ERRORS["unavailable"])
                return
            self.clear()
            self.intent = intent
            callback = current.run_check if intent == "check" else current.prepare_bundle if intent == "review" else current.copy_info
            nonce = callback(deliver)
            if nonce is None:
                self.status.setText(_ERRORS["unavailable"])
                return
            self.run_nonce = nonce
            self.status.setText("Preparing the reviewed file list…" if intent == "review" else "Running system check…" if intent == "check" else "Preparing support info…")
            self.poll()

        def accept(self, result):
            current = service()
            if result.run_nonce != self.run_nonce:
                return
            if current is None or not current.is_current(result.run_nonce):
                self.clear()
                return
            if result.code != "ok":
                self.status.setText(_ERRORS.get(result.code, "The support task did not finish. Try again."))
                return
            self.result = result
            if result.kind == "copy" and result.snapshot is not None:
                if self.intent == "email":
                    url = support_mailto(result.snapshot)
                    if current.is_current(result.run_nonce):
                        opened = open_url(url)
                        self.status.setText("Email draft opened. Add what happened before sending." if opened else "The email draft could not be opened.")
                elif current.is_current(result.run_nonce):
                    copied = clipboard(diagnostic_bytes(result.snapshot).decode("utf-8")) is True
                    if current.is_current(result.run_nonce):
                        self.status.setText("Support info copied." if copied else "Clipboard unavailable. Copy support info again when the clipboard is available.")
            elif result.kind == "saved":
                for _label, action in self.rows.values():
                    action.hide()
                self.status.setText("Support bundle saved. Review it before attaching it to a report.")
            elif result.snapshot is not None:
                for row in result.snapshot.rows:
                    label, action = self.rows[row.id]
                    facts = f" · {row.latency_ms:g} ms" if row.latency_ms is not None else ""
                    if row.count is not None:
                        facts += f" · {row.count:,}" + (" MiB free" if row.id == "storage" else "")
                    state = {"pass": "Ready", "warn": "Needs attention", "fail": "Failed", "unavailable": "Unavailable", "cancelled": "Cancelled"}[row.status]
                    label.setText(_TITLES[row.id] + ": " + state + " · " + _CODES.get(row.code, "Review settings") + facts)
                    action.setText({"retry": "Retry", "open_settings": "Open Settings", "link_again": "Link again"}.get(row.action, "Retry"))
                    action.setVisible(row.status in ("warn", "fail", "unavailable") and row.action != "none")
                details = []
                for folder in result.folders:
                    count = "Unavailable" if folder.replay_count is None else f"{folder.replay_count:,}" if folder.complete else f"at least {folder.replay_count:,}"
                    newest = folder.newest_utc or "unavailable"
                    details.append(f"Folder {folder.index}: {count} replays; newest {'in scanned sample' if not folder.complete else 'replay'}: {newest}.")
                self.folder_details.setText("\n".join(details))
                if result.kind == "review":
                    self.files.clear()
                    for entry in result.entries:
                        QtWidgets.QTreeWidgetItem(self.files, [entry.alias, str(entry.size),
                            f"{entry.omitted_lines:,}" + (" · capped" if entry.truncated else "")])
                    self.files.show()
                    self.save_button.show()
                    self.status.setText("Review these exact files. Uncertain log text is omitted. Saving keeps this reviewed copy, even if logs later change.")
                else:
                    self.status.setText("System check complete. Use each row's action or copy support info for your report.")
            self.poll()

        def fix(self, row_id):
            current = service()
            if (self.result is None or self.result.snapshot is None or current is None or current.busy
                or not current.is_current(self.result.run_nonce)):
                self.clear()
                return
            row = next(row for row in self.result.snapshot.rows if row.id == row_id)
            if row.action == "link_again":
                link_again()
            elif row.action == "open_settings":
                open_settings(row_id)
            else:
                self.start("check")

        def save(self):
            current = service()
            reviewed = self.result
            if reviewed is None or reviewed.kind != "review" or current is None or current.busy or not current.is_current(reviewed.run_nonce):
                self.clear()
                return
            reviewed_nonce = reviewed.run_nonce
            filename, _filter = QtWidgets.QFileDialog.getSaveFileName(self, "Save reviewed support bundle", "sc2tools-support.zip", "ZIP archives (*.zip)",
                options=QtWidgets.QFileDialog.DontConfirmOverwrite)
            if filename:
                latest = self.result
                if (service() is not current or latest is None or latest.kind != "review" or latest.run_nonce != reviewed_nonce
                    or self.run_nonce != reviewed_nonce or current.busy or not current.is_current(reviewed_nonce)):
                    self.clear()
                    self.status.setText("The review changed. Review the bundle again before saving.")
                    return
                nonce = current.save_reviewed(reviewed_nonce, filename, deliver)
                self.status.setText("Saving the reviewed bundle…" if nonce is not None else "Review the bundle again before saving.")
                self.poll()

        def cancel(self):
            current = service()
            if current is not None:
                current.cancel()
                self.cancelling = current.busy
            self.clear()
            self.status.setText("Cancelling… waiting for the running check to finish." if self.cancelling else "Cancelled.")
            self.poll()

        leave = cancel

    return HelpPage()
