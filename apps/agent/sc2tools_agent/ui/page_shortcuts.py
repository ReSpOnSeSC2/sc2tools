"""Keyboard navigation shared by the desktop agent window."""

PAGE_SHORTCUTS = ("companion", "dashboard", "recent", "streams", "log", "settings")


def install_page_shortcuts(window, *, QtCore, QtGui, go_to, refresh, save, nav_buttons):
    """Bind page actions and arrow navigation without changing focus policy."""
    shortcuts = []

    def add(parent, sequence, context, action):
        shortcut = QtGui.QShortcut(QtGui.QKeySequence(sequence), parent)
        shortcut.setContext(context)
        shortcut.activated.connect(action)
        shortcuts.append(shortcut)

    for index, key in enumerate(PAGE_SHORTCUTS, 1):
        add(window, f"Ctrl+{index}", QtCore.Qt.WindowShortcut, lambda key=key: go_to(key))
    add(window, "Ctrl+,", QtCore.Qt.WindowShortcut, lambda: go_to("settings"))
    add(window, "Ctrl+S", QtCore.Qt.WindowShortcut, save)
    add(window, "F5", QtCore.Qt.WindowShortcut, refresh)

    def focus_neighbor(index, direction):
        for offset in range(1, len(nav_buttons)):
            button = nav_buttons[(index + offset * direction) % len(nav_buttons)]
            if button.isEnabled() and button.isVisible():
                button.setFocus(QtCore.Qt.ShortcutFocusReason)
                return

    for index, button in enumerate(nav_buttons):
        add(button, "Up", QtCore.Qt.WidgetShortcut, lambda index=index: focus_neighbor(index, -1))
        add(button, "Down", QtCore.Qt.WidgetShortcut, lambda index=index: focus_neighbor(index, 1))
    return shortcuts
