"""Spatial CLI used by the SPA's Map Intel tab.

The Node backend (`stream-overlay-backend/analyzer.js`) does not have its
own spatial aggregator — the heavy lifting (KDE, scipy) lives in the
Python project at `analytics/spatial.py`. This CLI is a thin shim: it
loads the meta DB, instantiates a SpatialAggregator, and dumps JSON for
one query per invocation.

Subcommands
-----------

    maps       --db PATH [--min-games N] [--player NAME]
        List maps that have at least N games (default 3) with reachable
        replay file_paths. Output:
            {"ok": true, "maps": [{"name", "total", "wins", "losses"}, ...]}

    buildings  --db PATH --map NAME [--owner me|opponent] [--player NAME]
        Building density heatmap.

    proxy      --db PATH --map NAME [--player NAME]
        Opponent-proxy density heatmap.

    battle     --db PATH --map NAME [--player NAME]
        Battle/engagement density heatmap.

    death-zone --db PATH --map NAME [--my-race R] [--player NAME]
        20x20 grid of (my_army_lost - opp_army_lost) per cell.

    opponent-proxies --db PATH --opponent NAME [--player NAME] [--max-games N]
        Flat list of every proxy point this opponent placed against me.

All subcommands write exactly one JSON object on stdout. Errors emit
``{"ok": false, "error": "..."}`` with exit code 2.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, Optional

# Project root on sys.path so 'core', 'analytics', etc. import.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


def _load_db(db_path: str) -> Dict[str, Any]:
    if not os.path.isfile(db_path):
        return {}
    with open(db_path, "r", encoding="utf-8") as f:
        return json.load(f) or {}


def _make_agg(args):
    """Build a SpatialAggregator from the meta DB at ``args.db``.

    Imports are deferred so `--help` works even when scipy or sc2reader
    aren't installed in the calling environment.
    """
    from analytics.spatial import SpatialAggregator
    db = _load_db(args.db)
    return SpatialAggregator(db, player_name=getattr(args, "player", "") or None)


def cmd_maps(args) -> int:
    try:
        agg = _make_agg(args)
        rows = agg.list_maps_with_min_games(args.min_games or 3)
        _emit({"ok": True, "maps": rows})
        return 0
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2


def _emit_result(result: Dict[str, Any]) -> None:
    """Wrap a spatial query result in the {ok, result} envelope the SPA
    expects (see MapIntelTab's handler)."""
    _emit({"ok": True, "result": result})


def cmd_buildings(args) -> int:
    try:
        agg = _make_agg(args)
        owner = "opponent" if (args.owner or "me") == "opponent" else "me"
        result = agg.building_heatmap(args.map, owner=owner)
        _emit_result(result)
        return 0
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2


def cmd_proxy(args) -> int:
    try:
        agg = _make_agg(args)
        result = agg.proxy_heatmap(args.map)
        _emit_result(result)
        return 0
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2


def cmd_battle(args) -> int:
    try:
        agg = _make_agg(args)
        result = agg.battle_heatmap(args.map)
        _emit_result(result)
        return 0
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2


def cmd_death_zone(args) -> int:
    try:
        agg = _make_agg(args)
        result = agg.death_zone_grid(args.map, my_race=args.my_race or "")
        _emit_result(result)
        return 0
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2


def cmd_opponent_proxies(args) -> int:
    try:
        agg = _make_agg(args)
        result = agg.opponent_proxy_locations(
            args.opponent, max_games=int(args.max_games or 200),
        )
        _emit_result(result)
        return 0
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 2


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="spatial_cli", description="Spatial CLI for the SPA Map Intel tab.",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    def _common(p):
        p.add_argument("--db", required=True, help="Path to meta_database.json.")
        p.add_argument("--player", default="", help="Player name (which side is 'me').")

    pm = sub.add_parser("maps", help="List maps with >=N games.")
    _common(pm)
    pm.add_argument("--min-games", type=int, default=3)
    pm.set_defaults(func=cmd_maps)

    pb = sub.add_parser("buildings", help="Building density heatmap.")
    _common(pb)
    pb.add_argument("--map", required=True)
    pb.add_argument("--owner", default="me", choices=["me", "opponent"])
    pb.set_defaults(func=cmd_buildings)

    pp = sub.add_parser("proxy", help="Opponent proxy density heatmap.")
    _common(pp)
    pp.add_argument("--map", required=True)
    pp.set_defaults(func=cmd_proxy)

    pba = sub.add_parser("battle", help="Battle density heatmap.")
    _common(pba)
    pba.add_argument("--map", required=True)
    pba.set_defaults(func=cmd_battle)

    pd = sub.add_parser("death-zone", help="20x20 death-zone grid.")
    _common(pd)
    pd.add_argument("--map", required=True)
    pd.add_argument("--my-race", default="")
    pd.set_defaults(func=cmd_death_zone)

    po = sub.add_parser("opponent-proxies", help="One opponent's proxy locations.")
    _common(po)
    po.add_argument("--opponent", required=True)
    po.add_argument("--max-games", type=int, default=200)
    po.set_defaults(func=cmd_opponent_proxies)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # pragma: no cover
        _emit({"ok": False, "error": f"runtime error: {exc}"})
        return 2


if __name__ == "__main__":
    sys.exit(main())
