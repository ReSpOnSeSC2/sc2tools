"""Diagnostic v2: re-implement parse_replay_for_cloud step by step
with prints, so we see exactly which check fails."""

from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

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


def step(label: str) -> None:
    print(f"--- {label}")


here = Path(__file__).resolve()
for cand in (
    here.parents[2] / "SC2Replay-Analyzer",
    here.parents[2] / "reveal-sc2-opponent-main",
):
    if cand.exists():
        sys.path.insert(0, str(cand))

step("import parse_deep")
from core.sc2_replay_parser import parse_deep
step("OK")

step("parse_deep")
ctx = parse_deep(REPLAY, "ReSpOnSe")
step(f"  is_ai_game={ctx.is_ai_game}")
step(f"  me={ctx.me!r}")
step(f"  opponent={ctx.opponent!r}")

if ctx.is_ai_game:
    print("EXIT: ai_game"); sys.exit()
if not ctx.me:
    print("EXIT: no me"); sys.exit()
if not ctx.opponent:
    print("EXIT: no opponent"); sys.exit()

me = ctx.me
opp = ctx.opponent

step(f"me.result raw = {me.result!r} (type={type(me.result).__name__})")

# Inline copy of _result_str
def result_str(player_result):
    if player_result == "Win":
        return "Victory"
    if player_result == "Loss":
        return "Defeat"
    if player_result == "Tie":
        return "Tie"
    return None

result = result_str(me.result)
step(f"_result_str(me.result) = {result!r}")
if result is None:
    print("EXIT: result is None"); sys.exit()

step("Building opponent dict")
opponent = {
    "displayName": opp.name,
    "race": opp.race or "U",
}
step(f"  opp.mmr = {opp.mmr!r}")
if opp.mmr is not None:
    try:
        opponent["mmr"] = int(opp.mmr)
        step(f"  set mmr={opponent['mmr']}")
    except Exception as exc:
        step(f"  mmr coerce failed: {type(exc).__name__}: {exc}")

step(f"  opp.league_id = {getattr(opp, 'league_id', '<MISSING>')!r}")
step(f"  ctx.opp_pulse_id = {getattr(ctx, 'opp_pulse_id', '<MISSING>')!r}")
step(f"  opp.handle = {opp.handle!r}")
step(f"  ctx.opp_strategy = {getattr(ctx, 'opp_strategy', '<MISSING>')!r}")

step("Importing the AGENT'S parse_replay_for_cloud")
sys.path.insert(0, str(here.parent))
from sc2tools_agent.replay_pipeline import parse_replay_for_cloud, CloudGame

step("Calling parse_replay_for_cloud(REPLAY)")
try:
    game = parse_replay_for_cloud(Path(REPLAY))
    step(f"  returned: {type(game).__name__}")
    if game is None:
        step("  IT RETURNED NONE — but we just walked through every check above and they all PASSED.")
        step("  That means the agent's replay_pipeline.py file has something different from what we're testing.")
        step("  Inspecting the actual function source it loaded:")
        import inspect
        src = inspect.getsource(parse_replay_for_cloud)
        for i, line in enumerate(src.splitlines(), 1):
            print(f"    {i:>3}  {line}")
    else:
        step(f"  game.result = {game.result!r}")
        step(f"  game.game_id = {game.game_id!r}")
        step("  parse_replay_for_cloud worked — the bug is OUTSIDE this function.")
except Exception:
    step("  parse_replay_for_cloud RAISED:")
    traceback.print_exc()
