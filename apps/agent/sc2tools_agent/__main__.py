"""Entry point for ``python -m sc2tools_agent`` and the PyInstaller bundle.

We deliberately use an ABSOLUTE import here. PyInstaller invokes this
file as a top-level script (``__name__ == "__main__"``, no
``__package__``) so a relative ``from .runner import run_agent`` blows
up with "attempted relative import with no known parent package".

The absolute import works equally well under ``python -m
sc2tools_agent`` because the package is already on sys.path by the
time the module loader gets here.
"""

from __future__ import annotations

import multiprocessing
import os
import sys

from sc2tools_agent.runner import run_agent


def main() -> int:
    # Packaging-only diagnostic: exercise the frozen Qt window without ever
    # bootstrapping user state, pairing, replay services, OBS or crash reporting.
    smoke_report = os.environ.get("SC2TOOLS_GUI_SMOKE_REPORT")
    if smoke_report:
        from sc2tools_agent.packaging_smoke import run_gui_smoke

        return run_gui_smoke(smoke_report)
    return run_agent()


if __name__ == "__main__":
    # Critical for the frozen PyInstaller exe: ``freeze_support`` makes
    # ``multiprocessing`` reliably re-enter the child process at this
    # exact spot instead of re-running the whole agent (which would
    # spawn 12 GUI windows the moment the watcher's ProcessPoolExecutor
    # forks workers). Must be called BEFORE any pool is created — and
    # because the runner constructs the pool deep inside ``run_agent``,
    # the only safe place is right here at the top of ``__main__``.
    # No-op on non-frozen / non-Windows runs.
    multiprocessing.freeze_support()
    sys.exit(main())
