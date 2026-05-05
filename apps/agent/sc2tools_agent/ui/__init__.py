"""Agent UIs: the production GUI window, a tray icon, and a fallback
console UI.

All three implement the same sink interface - ``show_pairing_code``,
``on_paired``, ``on_status``, ``on_upload_success``, ``on_upload_failed``
- so the runner's ``_Multiplexer`` can broadcast each event to whichever
subset is wired up at runtime. ``can_use_gui()`` and ``can_use_tray()``
let the runner probe for optional deps before attempting to construct
the heavyweight UIs."""

from .console import ConsoleUI
from .gui import GuiUI, SettingsPayload, can_use_gui
from .tray import TrayUI, can_use_tray

__all__ = [
    "ConsoleUI",
    "GuiUI",
    "SettingsPayload",
    "TrayUI",
    "can_use_gui",
    "can_use_tray",
]
