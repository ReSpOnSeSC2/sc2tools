import json
import glob
import os
import sc2reader
from datetime import datetime
import concurrent.futures

# Atomic JSON writer -- prevents partial writes if the process is killed
# mid-flush (the bug that left MyOpponentHistory.json truncated in 04/2026).
from core.atomic_io import atomic_write_json

# --- CONFIGURATION ---
HISTORY_FILE = "MyOpponentHistory.json"
REPLAYS_DIR = r"C:\Users\jay19\OneDrive\Pictures\Documents\StarCraft II\Accounts\50983875\1-S2-1-267727"

def is_me(player_name):
    """Identifies your account, ignoring clan tags."""
    if not player_name:
        return False
    return "ReSpOnSe" in player_name

def get_race_initial(race_string):
    """Converts 'Protoss' to 'P', etc."""
    if not race_string:
        return "U"
    return race_string[0].upper()

def _safe_mmr(player):
    """Best-effort MMR read from an sc2reader player. Returns int or None."""
    for attr in ("scaled_rating", "mmr", "highest_league"):
        val = getattr(player, attr, None)
        if isinstance(val, (int, float)) and val > 0:
            return int(val)
    return None


def _replay_duration_seconds(replay):
    """
    Returns match length in real seconds. sc2reader exposes replay.game_length
    which is already wall-clock (Faster speed factor applied) in modern versions.
    Falls back to game_loops / 22.4 if needed.
    """
    length = getattr(replay, "game_length", None)
    if length is not None:
        secs = getattr(length, "seconds", None)
        if isinstance(secs, (int, float)) and secs > 0:
            return int(secs)
    loops = getattr(replay, "frames", None) or getattr(replay, "game_loops", None)
    if isinstance(loops, (int, float)) and loops > 0:
        return int(round(loops / 22.4))
    return None


def process_replay(replay_path):
    """
    Worker function to parse a single replay.
    Designed to run on a separate CPU core.
    """
    try:
        # load_level=2 is the sweet spot for fast parsing (gets players & results without full simulation)
        replay = sc2reader.load_replay(replay_path, load_level=2)

        # Only process 1v1 games
        if getattr(replay, 'real_type', '') != '1v1' or len(replay.players) != 2:
            return None

        me = None
        opponent = None

        for player in replay.players:
            if is_me(player.name):
                me = player
            else:
                opponent = player

        if not me or not opponent:
            return None

        # Strip opponent's clan tag
        opp_clean_name = opponent.name.split(']')[-1].strip() if ']' in opponent.name else opponent.name

        # Determine result
        result_str = None
        if me.result == "Win":
            result_str = "Victory"
        elif me.result == "Loss":
            result_str = "Defeat"
        else:
            return None # Ignore ties or incomplete data

        # sc2reader replay.date is the local time the game ended
        date_str = replay.date.strftime("%Y-%m-%d %H:%M")

        return {
            "opp_name": opp_clean_name,
            "my_race": get_race_initial(me.play_race),
            "opp_race": get_race_initial(opponent.play_race),
            "result": result_str,
            "map": replay.map_name,
            "date": date_str,
            "duration": _replay_duration_seconds(replay),
            "my_mmr": _safe_mmr(me),
            "opp_mmr": _safe_mmr(opponent)
        }

    except Exception:
        # Fails silently for corrupt files
        return None

def is_duplicate(new_game, existing_games):
    """
    Checks if a game already exists in the history log by comparing Map, Result, 
    and checking if the timestamps are within 10 minutes of each other.
    """
    new_date = datetime.strptime(new_game["date"], "%Y-%m-%d %H:%M")
    
    for g in existing_games:
        if g.get("Map") == new_game["map"] and g.get("Result") == new_game["result"]:
            try:
                existing_date = datetime.strptime(g.get("Date"), "%Y-%m-%d %H:%M")
                # If the map, result, and time (within 10 mins) match, it's a duplicate
                if abs((new_date - existing_date).total_seconds()) <= 600:
                    return True
            except Exception:
                pass
    return False

def backfill_history():
    if not os.path.exists(HISTORY_FILE):
        print(f"Could not find {HISTORY_FILE}")
        return

    # 1. Load existing history
    with open(HISTORY_FILE, 'r', encoding='utf-8') as f:
        history = json.load(f)

    # 2. Build Reverse Lookup Dictionary (Name -> SC2 Pulse ID)
    name_to_pulse_id = {}
    for pulse_id, data in history.items():
        opp_name = data.get("Name")
        if opp_name:
            # Handle potential clan tags saved in the JSON just in case
            clean_json_name = opp_name.split(']')[-1].strip() if ']' in opp_name else opp_name
            name_to_pulse_id[clean_json_name] = pulse_id

    replay_files = glob.glob(REPLAYS_DIR, recursive=True)
    print(f"Found {len(replay_files)} replays. Distributing across CPU cores...")

    games_processed = 0
    games_skipped = 0

    # 3. Process replays in parallel using all available CPU cores
    # We gather the parsed results first, then update the JSON sequentially 
    # to avoid race conditions (threads fighting to write to the dictionary).
    parsed_games = []
    with concurrent.futures.ProcessPoolExecutor() as executor:
        # executor.map automatically chunks the files and feeds them to idle CPU cores
        for result in executor.map(process_replay, replay_files):
            if result:
                parsed_games.append(result)

    print(f"Extracted {len(parsed_games)} valid 1v1 games. Cross-referencing your Black Book...")

    # 4. Apply results to the history dictionary
    for game in parsed_games:
        opp_name = game["opp_name"]
        
        # Only process if this opponent is already in your known SC2 Pulse ID history
        if opp_name in name_to_pulse_id:
            pulse_id = name_to_pulse_id[opp_name]
            matchup_string = f"{game['my_race']}v{game['opp_race']}"

            # Ensure data structure exists
            if "Matchups" not in history[pulse_id]:
                history[pulse_id]["Matchups"] = {}

            if matchup_string not in history[pulse_id]["Matchups"]:
                history[pulse_id]["Matchups"][matchup_string] = {
                    "Wins": 0,
                    "Losses": 0,
                    "Games": []
                }

            existing_games_list = history[pulse_id]["Matchups"][matchup_string]["Games"]

            # Deduplication Check
            if is_duplicate(game, existing_games_list):
                games_skipped += 1
                continue

            # Update stats
            if game["result"] == "Victory":
                history[pulse_id]["Matchups"][matchup_string]["Wins"] += 1
            else:
                history[pulse_id]["Matchups"][matchup_string]["Losses"] += 1

            # Log the game to the array
            history[pulse_id]["Matchups"][matchup_string]["Games"].append({
                "Date": game["date"],
                "Result": game["result"],
                "Map": game["map"],
                "Duration": game.get("duration")
            })

            games_processed += 1

    # 5. Save the updated history (atomic write so a kill mid-flush
    # can't leave the file in a half-written state).
    atomic_write_json(HISTORY_FILE, history, indent=4)

    print("\n--- SUMMARY ---")
    print(f"Successfully added: {games_processed} new games.")
    print(f"Skipped duplicates: {games_skipped} already recorded games.")

if __name__ == "__main__":
    backfill_history()