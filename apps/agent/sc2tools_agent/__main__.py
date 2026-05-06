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

import sys

from sc2tools_agent.runner import run_agent


def main() -> int:
    return run_agent()


if __name__ == "__main__":
    sys.exit(main())
