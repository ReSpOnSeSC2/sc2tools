"""Desktop help destinations. No Qt import is needed by headless installs."""
from urllib.parse import urlsplit, urlunsplit

# Keep identical to apps/web/lib/help/__tests__/agentLinks.test.ts.
AGENT_HELP_SLUGS = (
    "desktop-app-overview", "desktop-app-sync-range", "replay-folders",
    "obs-auto-scene-switching", "build-check-in", "desktop-app-activity-log",
    "pairing-troubleshooting", "desktop-app-sync-problems",
    "desktop-app-tray", "desktop-app-performance", "desktop-app-updates", "desktop-app-status",
    "desktop-app-import",
)


def site_url(dashboard_url, path):
    parsed=urlsplit(dashboard_url)
    return urlunsplit((parsed.scheme,parsed.netloc,path,"",""))


def help_url(dashboard_url, slug):
    if slug not in AGENT_HELP_SLUGS:
        raise ValueError("Unknown desktop help topic")
    parsed = urlsplit(dashboard_url)
    return urlunsplit((parsed.scheme, parsed.netloc, f"/help/{slug}", "src=agent", ""))


def help_button(QtWidgets, topic, callback, parent=None):
    button = QtWidgets.QToolButton(parent)
    button.setText("?")
    button.setFixedSize(20, 20)
    button.setObjectName("helpLink")
    button.setAccessibleName(f"Help: {topic}")
    button.setToolTip("Open help in your browser")
    button.clicked.connect(callback)
    return button
