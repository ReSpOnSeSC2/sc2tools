"""ML CLI used by the Node-backed analyzer at localhost:3000/analyzer.

Exposes the same WP-training and prediction surface that ``web_analyzer.py``
serves over HTTP, but as a stdout-streaming command-line tool so the
Express+Socket.io overlay backend can spawn it without needing a Python
HTTP sidecar.

Subcommands
-----------

    status     [--db PATH] [--model-dir DIR]
        Print one JSON object describing whether a trained WP model exists
        and how many games are in the DB.

    train      [--db PATH] [--model-dir DIR] [--player NAME]
        Train (or retrain) the WP model. Streams one ``{"progress": ...}``
        JSON line per processed replay, then prints one final
        ``{"result": ...}`` line. The Node side parses these line-by-line.

    predict    [--db PATH] [--model-dir DIR]
               [--minute N] [--supply_diff N] [--army_value_diff N]
               [--income_min_diff N] [--income_gas_diff N]
               [--nexus_count_diff N] [--tech_score_self N]
               [--tech_score_opp N] [--matchup PvT|PvZ|PvP]
        Mid-game what-if prediction. Prints ``{"ok": true, "p_win": ...}``.

    pregame    [--db PATH] [--myrace R] [--opprace R] [--opponent NAME]
               [--map NAME] [--strategy NAME]
        Historical pre-game win-rate prediction. Prints
        ``{"ok": true, "p_win": ..., "components": [...]}``.

    options    [--db PATH]
        Print distinct races / opponents / maps / strategies for the
        front-end dropdowns.

Exit codes are 0 on success, 1 on usage error, 2 on runtime error.
The CLI never prints to stderr unless something is genuinely wrong, so the
Node side can pipe stdout straight into a JSON parser.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

# Project root on sys.path so 'core', 'analytics', etc. import.
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)
if _ROOT not in sys.path:
    sys.path.insert(0, _ROOT)


def _eprint(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _emit(obj: Dict[str, Any]) -> None:
    """Write one newline-delimited JSON record to stdout."""
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()


# ----------------------------------------------------------- DB helpers
def _load_db(db_path: str) -> Dict[str, Any]:
    if not os.path.isfile(db_path):
        return {}
    with open(db_path, "r", encoding="utf-8") as f:
        return json.load(f) or {}


def _flat_games(db: Dict[str, Any]) -> List[Dict]:
    out = []
    for bname, bd in (db or {}).items():
        if not isinstance(bd, dict):
            continue
        for g in bd.get("games", []) or []:
            out.append({"_my_build": bname, **g})
    return out


def _resolve_model_path(args) -> str:
    """Where to load/save wp_model.pkl. Defaults to next to --db."""
    if args.model_dir:
        return os.path.join(args.model_dir, "wp_model.pkl")
    if args.db:
        return os.path.join(os.path.dirname(args.db), "wp_model.pkl")
    from core.paths import DB_FILE  # pragma: no cover
    return os.path.join(os.path.dirname(DB_FILE), "wp_model.pkl")


# ----------------------------------------------------------- subcommands
def cmd_status(args) -> int:
    from analytics.win_probability import (
        WinProbabilityModel,
        cold_start_status,
    )
    db = _load_db(args.db)
    model_path = _resolve_model_path(args)
    wp = WinProbabilityModel.load_or_new(path=model_path)
    cs = cold_start_status(db)
    if wp.model is None:
        _emit({
            "trained": False,
            "have": cs["have"],
            "minimum": cs["minimum"],
            "needed": cs["needed"],
            "model_path": model_path,
            "message": (
                f"Need {cs['needed']} more game(s) to train."
                if cs["needed"] > 0 else
                f"{cs['have']} games ready - run train."
            ),
        })
    else:
        _emit({
            "trained": True,
            "auc": wp.auc,
            "games_used": wp.games_used,
            "snapshots": wp.snapshots,
            "last_trained": wp.last_trained,
            "model_path": model_path,
            "have": cs["have"],
            "minimum": cs["minimum"],
        })
    return 0


def cmd_train(args) -> int:
    from analytics.win_probability import (
        WinProbabilityModel,
        cold_start_status,
    )
    db = _load_db(args.db)
    cs = cold_start_status(db)
    if not cs["ready"]:
        _emit({
            "ok": False,
            "result": {
                "trained": False,
                "message": (
                    f"Need {cs['needed']} more game(s) "
                    f"(have {cs['have']}/{cs['minimum']})."
                ),
            },
        })
        return 0

    model_path = _resolve_model_path(args)
    wp = WinProbabilityModel.load_or_new(path=model_path)

    # Stream progress as the parser walks each replay so the Node side can
    # forward live updates over Socket.io.
    def progress_cb(done: int, total: int) -> None:
        _emit({"progress": {"done": int(done), "total": int(total)}})

    try:
        report = wp.train(
            db, player_name=args.player, progress_cb=progress_cb,
        )
    except Exception as exc:
        _emit({"ok": False, "result": {"trained": False, "message": str(exc)}})
        return 2

    if report is None:
        _emit({
            "ok": False,
            "result": {"trained": False, "message": "Cold-start guard fired."},
        })
        return 0
    # Persist explicitly to the requested path even though .train() also
    # saves to its own default location.
    try:
        wp.save(path=model_path)
    except Exception:
        pass
    _emit({
        "ok": True,
        "result": {
            "trained": bool(report.trained),
            "games_used": report.games_used,
            "games_skipped": report.games_skipped,
            "snapshots": report.snapshots,
            "auc": report.auc,
            "last_trained": report.last_trained,
            "message": report.message,
            "model_path": model_path,
        },
    })
    return 0


def cmd_predict(args) -> int:
    from analytics.win_probability import WinProbabilityModel

    model_path = _resolve_model_path(args)
    wp = WinProbabilityModel.load_or_new(path=model_path)
    if wp.model is None:
        _emit({
            "ok": False,
            "message": "Model not trained yet. Run 'train' first.",
        })
        return 0

    matchup = (args.matchup or "").strip()
    row = {
        "minute": float(args.minute),
        "supply_diff": float(args.supply_diff),
        "income_min_diff": float(args.income_min_diff),
        "income_gas_diff": float(args.income_gas_diff),
        "army_value_diff": float(args.army_value_diff),
        "nexus_count_diff": float(args.nexus_count_diff),
        "tech_score_self": float(args.tech_score_self),
        "tech_score_opp": float(args.tech_score_opp),
        "matchup_PvT": 1.0 if matchup == "PvT" else 0.0,
        "matchup_PvZ": 1.0 if matchup == "PvZ" else 0.0,
        "matchup_PvP": 1.0 if matchup == "PvP" else 0.0,
    }
    try:
        import pandas as pd
        df = pd.DataFrame([row])
        curve = wp.predict_curve(df)
    except Exception as exc:
        _emit({"ok": False, "message": f"Prediction failed: {exc}"})
        return 2
    if not curve:
        _emit({"ok": False, "message": "Empty prediction."})
        return 0
    _emit({
        "ok": True,
        "p_win": float(curve[0][1]),
        "minute": float(curve[0][0]),
        "model": {"auc": wp.auc, "games_used": wp.games_used},
    })
    return 0


def cmd_pregame(args) -> int:
    db = _load_db(args.db)
    flat = [
        g for g in _flat_games(db)
        if g.get("result") in ("Win", "Loss")
    ]
    if not flat:
        _emit({"ok": False, "message": "No games in database."})
        return 0

    def _race(s: Optional[str]) -> str:
        if not s:
            return ""
        s = s.strip().upper()
        return s[0] if s and s[0] in "PTZR" else ""

    filters = {
        "myrace":   args.myrace or "",
        "opprace":  args.opprace or "",
        "opponent": args.opponent or "",
        "map":      args.map or "",
        "strategy": args.strategy or "",
    }

    def passes(g, k, v):
        if not v:
            return True
        if k == "opprace":
            return _race(g.get("opp_race")) == _race(v)
        if k == "myrace":
            return _race(g.get("my_race") or g.get("_my_race")) == _race(v)
        if k == "opponent":
            return (g.get("opponent") or "") == v
        if k == "map":
            return (g.get("map") or "") == v
        if k == "strategy":
            return (g.get("opp_strategy") or "") == v
        return True

    matched = [g for g in flat
               if all(passes(g, k, v) for k, v in filters.items())]
    components = []
    for k, v in filters.items():
        if not v:
            continue
        comp = [g for g in flat if passes(g, k, v)]
        wins = sum(1 for g in comp if g.get("result") == "Win")
        components.append({
            "key": k, "label": f"{k}={v}",
            "total": len(comp), "wins": wins,
            "win_rate": (wins / len(comp)) if comp else 0.0,
        })

    if matched:
        wins = sum(1 for g in matched if g.get("result") == "Win")
        # Beta(1,1) Laplace smoothing so 1-0 doesn't report 100%.
        p = (wins + 1) / (len(matched) + 2)
        _emit({
            "ok": True, "p_win": float(p),
            "raw_win_rate": wins / len(matched),
            "wins": wins, "total": len(matched),
            "components": components,
            "method": "joint match (laplace-smoothed)",
        })
        return 0

    if not components:
        _emit({
            "ok": False,
            "message": "No filters set and no exact match.",
        })
        return 0
    valid = [c for c in components if c["total"] > 0]
    if not valid:
        _emit({
            "ok": False,
            "message": "No historical games match any of the selected filters.",
        })
        return 0
    p = sum(c["win_rate"] for c in valid) / len(valid)
    _emit({
        "ok": True, "p_win": float(p),
        "wins": 0, "total": 0,
        "components": components,
        "method": f"blend of {len(valid)} component win-rates",
    })
    return 0


def cmd_spatial(args) -> int:
    """Spatial heatmap aggregator for the analyzer SPA.

    Modes (--mode):
      maps                -> list maps with >= --min_games games
      buildings           -> 100x100 KDE of buildings on --map for --owner
      proxy               -> 100x100 KDE of opponent proxy buildings on --map
      battle              -> 100x100 KDE of engagement centroids on --map
      death_zone          -> 20x20 mean(my_lost - opp_lost) per cell on --map
      opponent_proxies    -> proxy locations for --opponent across all games

    The CLI is the only thing the Node backend can spawn, so all four
    SpatialAggregator entry points are surfaced through this single command
    keyed on --mode rather than adding four near-identical subcommands.
    """
    db_path = args.db
    if not db_path:
        from core.paths import DB_FILE
        db_path = DB_FILE
    db = _load_db(db_path)

    from analytics.spatial import (
        MIN_GAMES_FOR_MAP,
        SpatialAggregator,
    )
    agg = SpatialAggregator(db, player_name=args.player)

    mode = args.mode or "maps"
    try:
        if mode == "maps":
            min_games = int(args.min_games or MIN_GAMES_FOR_MAP)
            _emit({"ok": True, "mode": mode,
                   "maps": agg.list_maps_with_min_games(min_games)})
        elif mode == "buildings":
            if not args.map:
                _emit({"ok": False, "message": "--map is required"})
                return 1
            owner = args.owner or "me"
            _emit({"ok": True, "mode": mode,
                   "result": agg.building_heatmap(args.map, owner=owner)})
        elif mode == "proxy":
            if not args.map:
                _emit({"ok": False, "message": "--map is required"})
                return 1
            _emit({"ok": True, "mode": mode,
                   "result": agg.proxy_heatmap(args.map)})
        elif mode == "battle":
            if not args.map:
                _emit({"ok": False, "message": "--map is required"})
                return 1
            _emit({"ok": True, "mode": mode,
                   "result": agg.battle_heatmap(args.map)})
        elif mode == "death_zone":
            if not args.map:
                _emit({"ok": False, "message": "--map is required"})
                return 1
            _emit({"ok": True, "mode": mode,
                   "result": agg.death_zone_grid(
                       args.map, my_race=args.myrace or "")})
        elif mode == "opponent_proxies":
            if not args.opponent:
                _emit({"ok": False, "message": "--opponent is required"})
                return 1
            _emit({"ok": True, "mode": mode,
                   "result": agg.opponent_proxy_locations(args.opponent)})
        else:
            _emit({"ok": False, "message": f"Unknown spatial mode: {mode}"})
            return 1
    except Exception as exc:
        _emit({"ok": False, "message": f"spatial {mode} failed: {exc}"})
        return 2
    return 0


def cmd_options(args) -> int:
    db = _load_db(args.db)
    races, opps, maps, strats = set(), set(), set(), set()
    for g in _flat_games(db):
        if g.get("opp_race"):
            races.add(g["opp_race"])
        if g.get("opponent"):
            opps.add(g["opponent"])
        if g.get("map"):
            maps.add(g["map"])
        if g.get("opp_strategy"):
            strats.add(g["opp_strategy"])
    _emit({
        "races": sorted(races),
        "opponents": sorted(opps, key=lambda s: s.lower()),
        "maps": sorted(maps),
        "strategies": sorted(strats),
    })
    return 0


# --------------------------------------------------------------- entry
def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="ML CLI for the SC2 Meta Analyzer (used by the Node overlay backend)."
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    def add_common(p):
        p.add_argument("--db", default=None,
                       help="Path to meta_database.json (default: project DB).")
        p.add_argument("--model-dir", default=None,
                       help="Where wp_model.pkl lives (default: same dir as --db).")

    p_status = sub.add_parser("status")
    add_common(p_status)
    p_status.set_defaults(func=cmd_status)

    p_train = sub.add_parser("train")
    add_common(p_train)
    p_train.add_argument("--player", default=None,
                         help="Player handle to use as 'me' (overrides config).")
    p_train.set_defaults(func=cmd_train)

    p_predict = sub.add_parser("predict")
    add_common(p_predict)
    p_predict.add_argument("--minute", type=float, default=8.0)
    p_predict.add_argument("--supply_diff", type=float, default=0.0)
    p_predict.add_argument("--army_value_diff", type=float, default=0.0)
    p_predict.add_argument("--income_min_diff", type=float, default=0.0)
    p_predict.add_argument("--income_gas_diff", type=float, default=0.0)
    p_predict.add_argument("--nexus_count_diff", type=float, default=0.0)
    p_predict.add_argument("--tech_score_self", type=float, default=0.0)
    p_predict.add_argument("--tech_score_opp", type=float, default=0.0)
    p_predict.add_argument("--matchup", default="",
                           choices=["", "PvT", "PvZ", "PvP"])
    p_predict.set_defaults(func=cmd_predict)

    p_pregame = sub.add_parser("pregame")
    add_common(p_pregame)
    p_pregame.add_argument("--myrace", default="")
    p_pregame.add_argument("--opprace", default="")
    p_pregame.add_argument("--opponent", default="")
    p_pregame.add_argument("--map", default="")
    p_pregame.add_argument("--strategy", default="")
    p_pregame.set_defaults(func=cmd_pregame)

    p_options = sub.add_parser("options")
    add_common(p_options)
    p_options.set_defaults(func=cmd_options)

    p_spatial = sub.add_parser("spatial")
    add_common(p_spatial)
    p_spatial.add_argument("--mode", default="maps",
                           choices=["maps", "buildings", "proxy", "battle",
                                    "death_zone", "opponent_proxies"])
    p_spatial.add_argument("--map", default="",
                           help="Map name (required for non-'maps' modes).")
    p_spatial.add_argument("--owner", default="me",
                           choices=["me", "opponent"])
    p_spatial.add_argument("--myrace", default="",
                           help="Annotates death_zone response.")
    p_spatial.add_argument("--min_games", type=int, default=3)
    p_spatial.add_argument("--opponent", default="",
                           help="Required for opponent_proxies mode.")
    p_spatial.add_argument("--player", default=None,
                           help="Player handle to use as 'me'.")
    p_spatial.set_defaults(func=cmd_spatial)

    args = parser.parse_args(argv)

    # Resolve default DB path lazily (avoids importing core.paths for usage err).
    if not args.db:
        try:
            from core.paths import DB_FILE
            args.db = DB_FILE
        except Exception:
            args.db = ""

    try:
        return args.func(args)
    except KeyboardInterrupt:
        _eprint("Interrupted.")
        return 130
    except Exception as exc:
        _eprint(f"ml_cli: {type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
