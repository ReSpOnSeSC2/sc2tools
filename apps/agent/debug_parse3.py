"""Diagnostic v3: enable logging so we see ANY warning/error
parse_replay_for_cloud emits, and re-run the call."""

from __future__ import annotations

import logging
import sys
from pathlib import Path

# Enable everything
logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)s %(name)s | %(message)s",
)
logging.getLogger("sc2reader").setLevel(logging.WARNING)  # silence sc2reader

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

REPLAY = (
    r"C:\Users\jay19\OneDrive\Pictures\Documents\StarCraft II"
    r"\Accounts\50983875\1-S2-1-267727\Replays\Multiplayer"
    r"\10000 Feet LE (109).SC2Replay"
)

here = Path(__file__).resolve()
for cand in (
    here.parents[2] / "SC2Replay-Analyzer",
    here.parents[2] / "reveal-sc2-opponent-main",
):
    if cand.exists():
        sys.path.insert(0, str(cand))

sys.path.insert(0, str(here.parent))
from sc2tools_agent.replay_pipeline import parse_replay_for_cloud

print("=== Calling parse_replay_for_cloud — any errors will be logged above ===")
result = parse_replay_for_cloud(Path(REPLAY))
print(f"=== Returned: {type(result).__name__} ===")
if result is None:
    print("Returned None. The exception (if any) is shown above this line.")
else:
    print(f"  game_id={result.game_id}")
    print(f"  result={result.result}")

# Now do an UNTRAPPED call: monkey-patch the function to expose where it fails.
print()
print("=== Now: re-implement WITH EXCEPTION RE-RAISE inline ===")
import os, traceback
from sc2tools_agent.replay_pipeline import _read_player_handle, _result_str, _sanitize_name, _to_iso, CloudGame

handle = _read_player_handle()
print(f"handle={handle!r}")

try:
    from core.sc2_replay_parser import parse_deep
    print("import OK")
except Exception:
    print("import FAILED:")
    traceback.print_exc()
    sys.exit(1)

try:
    ctx = parse_deep(str(REPLAY), handle)
    print(f"parse_deep returned ctx with me={ctx.me}, opponent={ctx.opponent}")
except Exception:
    print("parse_deep RAISED (exception that the production code would silently swallow):")
    traceback.print_exc()
    sys.exit(1)

if ctx.is_ai_game or not ctx.me or not ctx.opponent:
    print(f"would return None — is_ai={ctx.is_ai_game} me={ctx.me!r} opp={ctx.opponent!r}")
    sys.exit(1)

me = ctx.me
opp = ctx.opponent
result_str = _result_str(me.result)
print(f"_result_str({me.result!r}) = {result_str!r}")
if result_str is None:
    print("would return None — result_str is None")
    sys.exit(1)

opponent = {"displayName": _sanitize_name(opp.name), "race": opp.race or "U"}
if opp.mmr is not None:
    opponent["mmr"] = int(opp.mmr)
if getattr(opp, "league_id", None) is not None:
    try: opponent["leagueId"] = int(opp.league_id)
    except (TypeError, ValueError): pass
if getattr(ctx, "opp_pulse_id", None):
    opponent["pulseId"] = str(ctx.opp_pulse_id)
elif opp.handle:
    opponent["pulseId"] = str(opp.handle)
if getattr(ctx, "opp_strategy", None):
    opponent["strategy"] = str(ctx.opp_strategy)

print(f"opponent dict = {opponent}")
print(f"ctx.game_id = {getattr(ctx, 'game_id', '<MISSING>')!r}")
print(f"ctx.date_iso = {ctx.date_iso!r}")
print(f"ctx.map_name = {ctx.map_name!r}")
print(f"ctx.length_seconds = {ctx.length_seconds!r}")
print(f"ctx.build_log type = {type(getattr(ctx, 'build_log', None)).__name__}")

print("Constructing CloudGame...")
try:
    game = CloudGame(
        game_id=str(ctx.game_id),
        date_iso=_to_iso(ctx.date_iso),
        result=result_str,
        my_race=str(me.race),
        my_build=getattr(ctx, "my_build", None),
        map_name=str(ctx.map_name),
        duration_sec=int(ctx.length_seconds or 0),
        macro_score=getattr(ctx, "macro_score", None),
        apm=getattr(me, "apm", None),
        spq=getattr(me, "spq", None),
        opponent=opponent,
        build_log=list(getattr(ctx, "build_log", []) or []),
        early_build_log=list(getattr(ctx, "early_build_log", []) or []),
        opp_early_build_log=list(getattr(ctx, "opp_early_build_log", []) or []),
        opp_build_log=list(getattr(ctx, "opp_build_log", []) or []),
    )
    print(f"  CloudGame OK: {game.game_id}")
except Exception:
    print("  CloudGame construction RAISED:")
    traceback.print_exc()
