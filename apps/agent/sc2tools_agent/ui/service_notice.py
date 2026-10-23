"""A plain-text service notice, separate from status and installer messages."""
from urllib.parse import urljoin
from ..updater import notice_is_current
from . import palette


def build_service_notice(parent, *, QtCore, QtWidgets, dashboard_url, open_browser):
    class ServiceNotice(QtWidgets.QFrame):
        def __init__(self):
            super().__init__(parent)
            self.setObjectName("cardElevated")
            self.notice = None
            layout = QtWidgets.QHBoxLayout(self)
            self.text = QtWidgets.QLabel()
            self.text.setTextFormat(QtCore.Qt.PlainText)
            self.text.setWordWrap(True)
            layout.addWidget(self.text, 1)
            self.details = QtWidgets.QPushButton("More information")
            self.details.clicked.connect(self.open_details)
            layout.addWidget(self.details)
            self.timer = QtCore.QTimer(self)
            self.timer.setInterval(1000)
            self.timer.timeout.connect(self.refresh)
            self.hide()

        def apply(self, notice):
            self.notice = notice
            self.refresh()

        def refresh(self):
            if not notice_is_current(self.notice):
                self.notice = None
                self.timer.stop()
                self.hide()
                return
            notice = self.notice
            color = {"critical": palette.RED, "warning": palette.AMBER}.get(notice.severity, palette.CYAN)
            self.text.setStyleSheet("color: " + color)
            self.text.setText(notice.message)
            self.setAccessibleName("SC2 Tools service notice: " + notice.message)
            self.details.setVisible(bool(notice.href))
            self.show()
            self.timer.start()

        def open_details(self):
            if notice_is_current(self.notice) and self.notice.href:
                open_browser(urljoin(dashboard_url, self.notice.href))

    return ServiceNotice()
