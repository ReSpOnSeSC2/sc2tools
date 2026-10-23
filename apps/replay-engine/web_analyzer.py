"""SC2 Meta Analyzer - Flask web UI - **RETIRED**.

Use the web analyzer at https://sc2tools.com/app. It reads replay events
using fixed rules and statistics. The unused server model-training and
prediction tools have been removed.

Running this file now just prints the migration message and exits with
status 1 so any leftover scripts that point at port 5050 fail loudly
instead of silently serving stale data.
"""

from __future__ import annotations

import sys
import textwrap


_BANNER = textwrap.dedent(
    """\
    =====================================================================
      web_analyzer.py is RETIRED.

      Use the web analyzer:
          https://sc2tools.com/app

      Analysis uses fixed rules and statistics.
      Server model-training and prediction tools have been removed.
    =====================================================================
    """
)


def main() -> int:
    sys.stderr.write(_BANNER)
    sys.stderr.flush()
    return 1


if __name__ == "__main__":
    sys.exit(main())
