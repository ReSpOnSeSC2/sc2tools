"""SC2 Meta Analyzer - Flask web UI - **RETIRED**.

This module has been superseded by the polished React + Socket.io analyzer
served by the overlay backend at:

    http://localhost:3000/analyzer

That analyzer has every feature this Flask app used to offer:

* Per-game Win-Probability curves (existing).
* WP model training with **live progress over Socket.io** (new ML/Predict tab).
* What-if mid-game predictor with sliders (new).
* Pre-game predictor based on historical win-rate (new).
* Season selector (Last 7 / 30 / 90 days, etc.) (parity with the old UI).

It also has things this Flask app never offered:
* Per-opponent deep dives (Opponents tab).
* Time-series trends.
* Global filters across all tabs (race, opp_race, map, MMR range, dates).
* CSV export on every aggregation.
* Live updates as new replays land (Socket.io ``analyzer_db_changed``).

The ML side calls a Python CLI (``scripts/ml_cli.py``) inside this project,
so we kept the heavy lifting in Python; the Node side just spawns it.

To start the new analyzer::

    cd <reveal-sc2-opponent-main>/stream-overlay-backend
    npm start
    # then open http://localhost:3000/analyzer

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

      Use the polished React analyzer instead:
          http://localhost:3000/analyzer

      Start it with:
          cd <reveal-sc2-opponent-main>/stream-overlay-backend
          npm start

      All features (training, prediction, season selection, deep dives,
      time-series, CSV export, live updates) are available there.

      The Python ML CLI used by the new analyzer lives at:
          scripts/ml_cli.py
    =====================================================================
    """
)


def main() -> int:
    sys.stderr.write(_BANNER)
    sys.stderr.flush()
    return 1


if __name__ == "__main__":
    sys.exit(main())
