"""Agent UIs: a tray icon and a fallback console UI."""

from .console import ConsoleUI
from .tray import TrayUI, can_use_tray

__all__ = ["ConsoleUI", "TrayUI", "can_use_tray"]
