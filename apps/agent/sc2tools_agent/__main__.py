"""Entry point for `python -m sc2tools_agent`."""

from __future__ import annotations

import sys

from .runner import run_agent


def main() -> int:
    return run_agent()


if __name__ == "__main__":
    sys.exit(main())
