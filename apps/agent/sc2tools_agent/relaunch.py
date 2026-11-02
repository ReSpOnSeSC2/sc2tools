"""Restart agent: start a fresh copy once this process has released its instance lock.

A copy started any earlier finds the lock held, hands off to this window and
exits. So the window only arms an ``AgentRelaunch``; ``run_agent`` starts it
after the normal shutdown has released the lock. Standard library only.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys

log = logging.getLogger(__name__)

# The window comes back for the user who pressed Restart agent: the flag is dropped,
# and this marker in the new copy's environment skips the saved start_minimized setting.
_DROPPED_FLAGS = frozenset({"--start-minimized"})
RESTARTED_ENV = "SC2TOOLS_RESTARTED"


def _frozen():
    return getattr(sys, "frozen", False) is True


def take_restart_marker(environ=None):
    """Whether Restart agent started this copy. The marker is removed, so nothing
    this copy starts later (the updater's helper, say) inherits it."""
    return (os.environ if environ is None else environ).pop(RESTARTED_ENV, None) == "1"


def relaunch_command(argv, *, frozen, executable=None):
    """The bundled exe with this run's flags, or ``-m sc2tools_agent`` for a source run."""
    flags = [flag for flag in (sys.argv[1:] if argv is None else argv) if flag not in _DROPPED_FLAGS]
    program = [executable or sys.executable]
    return program + flags if frozen else program + ["-m", "sc2tools_agent"] + flags


def _spawn(command, environ):
    options = {"env": environ, "close_fds": True, "stdin": subprocess.DEVNULL,
               "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
    if os.name == "nt":
        # As the updater's helper: no console window, and outside this process group.
        options["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        options["start_new_session"] = True
    subprocess.Popen(command, **options)


class AgentRelaunch:
    """One restart, armed from the window and started by ``run_agent``."""

    def __init__(self, argv=None, *, frozen=None, environ=None):
        frozen = _frozen() if frozen is None else frozen
        self.command = relaunch_command(argv, frozen=frozen)
        # Read before _bootstrap promotes saved settings into the environment,
        # so the new copy picks up settings saved since this one started.
        self.environ = dict(os.environ if environ is None else environ)
        self.environ[RESTARTED_ENV] = "1"
        if frozen:
            self.environ["PYINSTALLER_RESET_ENVIRONMENT"] = "1"  # a new app, not a child of this bundle
        self.requested = False

    def request(self):
        self.requested = True

    def start_if_requested(self):
        """Start the new copy. Call only after the instance lock is released. Never raises."""
        if not self.requested:
            return False
        try:
            _spawn(self.command, self.environ)
        except Exception:  # noqa: BLE001 - shutdown must finish even when the new copy can't start
            log.exception("agent_relaunch_failed")
            return False
        log.info("agent_relaunched command=%s", self.command)
        return True
