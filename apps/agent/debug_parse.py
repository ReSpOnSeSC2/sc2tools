"""Diagnostic: parse one replay and print exactly what the agent sees.

Run from C:\\SC2TOOLS\\apps\\agent:
    py debug_parse.py

It tells us, for one specific replay:
  - Was the player handle picked up?
  - Was the replay parsed at all?
  - Did the parser identify "me"?
  - Did it identify the "opponent"?
  - What result was reported?
  - Would parse_replay_for_cloud() return a CloudGame, or None (and why)?
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Force-load the agent's .env so SC2TOOLS_PLAYER_HANDLE is set, same as
# the running agent does.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# A replay we KNOW exists (from your logs).
REPLAY = (
    r"C:\Users\jay19\OneDrive\Pictures\Documents\StarCraft II"
    r"\Accounts\50983875\1-S2-1-267727\Replays\Multiplayer"
    r"\10000 Feet LE (109).SC2Replay"
)


def banner(title: str) -> None:
    print()
    print("=" * 60)
    print(title)
    print("=" * 60)


banner("ENV CHECK")
handle = os.environ.get("SC2TOOLS_PLAYER_HANDLE")
print(f"SC2TOOLS_PLAYER_HANDLE = {handle!r}")
if not handle:
    print("!! Empty handle. The .env wasn't loaded or doesn't set this.")
    sys.exit(1)

banner("REPLAY FILE CHECK")
replay_path = Path(REPLAY)
print(f"Path: {replay_path}")
print(f"Exists: {replay_path.exists()}")
if not replay_path.exists():
    print("!! Replay file not found. Edit REPLAY at the top of this script.")
    sys.exit(1)
print(f"Size: {replay_path.stat().st_size} bytes")

banner("DIRECT PARSER TEST (parse_deep)")
# Mirror what replay_pipeline does to find the analyzer code.
here = Path(__file__).resolve()
for cand in (
    here.parents[2] / "SC2Replay-Analyzer",
    here.parents[2] / "reveal-sc2-opponent-main",
):
    if cand.exists():
        print(f"Adding to sys.path: {cand}")
        sys.path.insert(0, str(cand))

try:
    from core.sc2_replay_parser import parse_deep
except ImportError as exc:
    print(f"!! Could not import parse_deep: {exc}")
    sys.exit(1)

try:
    ctx = parse_deep(str(replay_path), handle)
except Exception as exc:  # noqa: BLE001
    print(f"!! parse_deep raised: {type(exc).__name__}: {exc}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print(f"is_ai_game: {ctx.is_ai_game}")
print(f"all_players: {[(p.name, p.race) for p in (ctx.all_players or [])]}")
print(f"ctx.me: {ctx.me}")
if ctx.me:
    print(f"  me.name = {ctx.me.name!r}")
    print(f"  me.race = {ctx.me.race!r}")
    print(f"  me.result = {getattr(ctx.me, 'result', '<MISSING>')!r}")
print(f"ctx.opponent: {ctx.opponent}")
if ctx.opponent:
    print(f"  opp.name = {ctx.opponent.name!r}")
    print(f"  opp.race = {ctx.opponent.race!r}")

banner("AGENT PIPELINE TEST (parse_replay_for_cloud)")
sys.path.insert(0, str(here.parent))
from sc2tools_agent.replay_pipeline import parse_replay_for_cloud

game = parse_replay_for_cloud(replay_path)
if game is None:
    print("!! parse_replay_for_cloud returned None — replay would be SKIPPED.")
    print("Looking at the parser output above, the most likely reason is:")
    if ctx.is_ai_game:
        print("  - It's an AI game (ctx.is_ai_game=True).")
    elif not ctx.me:
        print("  - The player handle didn't match anyone in the replay.")
        print(f"    Configured handle: {handle!r}")
        print("    Player names in replay:")
        for p in (ctx.all_players or []):
            print(f"      {p.name!r}")
    elif not ctx.opponent:
        print("  - Couldn't identify an opponent (single-player or weird replay).")
    else:
        result = getattr(ctx.me, "result", None)
        print(f"  - Result was unrecognised: {result!r} (need Win/Loss/Tie)")
else:
    print("OK — parse_replay_for_cloud returned a CloudGame.")
    print(f"  gameId: {game.game_id}")
    print(f"  result: {game.result}")
    print(f"  myRace: {game.my_race}")
    print(f"  map: {game.map_name}")
    print(f"  opponent: {game.opponent}")
    print()
    print("If THIS works but the running agent shows 0 synced, the problem is")
    print("upstream of the parser — the agent is rejecting/dedupe-skipping the")
    print("replay before it gets to parse_replay_for_cloud.")
