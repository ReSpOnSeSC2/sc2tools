import time
import os
import json
import requests  # <-- New import for handling HTTP POST
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# Import your existing logic from UpdateHistory.py
from UpdateHistory import process_replay, HISTORY_FILE, is_duplicate

# Updated to track ALL your account folders across NA, EU, etc.
WATCH_DIR = r"C:\Users\jay19\OneDrive\Pictures\Documents\StarCraft II\Accounts"

# The endpoint for your local Node.js stream overlay server
SERVER_URL = "http://localhost:3000/api/replay"

def wait_for_file_ready(filepath, timeout=15):
    """Waits for SC2 to finish writing the .SC2Replay file to disk."""
    start_time = time.time()
    previous_size = -1
    
    while True:
        if time.time() - start_time > timeout:
            print(f"Timeout waiting for file to finish writing: {filepath}")
            return False
            
        try:
            current_size = os.path.getsize(filepath)
            if current_size > 0 and current_size == previous_size:
                return True
            previous_size = current_size
        except OSError:
            pass
            
        time.sleep(1)

def send_replay_to_server(game_data):
    """
    Constructs a JSON payload from the parsed replay data and sends it
    to the local web server via an HTTP POST request.
    """
    payload = {
        "myRace":   game_data["my_race"],
        "oppRace":  game_data["opp_race"],
        "map":      game_data["map"],
        "result":   game_data["result"],
        "oppName":  game_data.get("opp_name"),
        "duration": game_data.get("duration"),
    }
    # Only include MMR fields if we actually parsed them - the server
    # treats missing MMR as "no change" rather than zero.
    if game_data.get("my_mmr")  is not None: payload["myMmr"]  = game_data["my_mmr"]
    if game_data.get("opp_mmr") is not None: payload["oppMmr"] = game_data["opp_mmr"]

    try:
        # We use a short timeout (3 seconds) so the script doesn't hang forever
        # if your local server isn't running.
        response = requests.post(SERVER_URL, json=payload, timeout=3)
        
        # Raise an exception if the server responds with a 4xx or 5xx error code
        response.raise_for_status() 
        print(f"Server Update Success: Payload delivered to {SERVER_URL}.")
        
    except requests.exceptions.ConnectionError:
        print(f"Server Update Failed: Connection refused. Is the server running at {SERVER_URL}?")
    except requests.exceptions.Timeout:
        print("Server Update Failed: The request timed out.")
    except requests.exceptions.HTTPError as err:
        print(f"Server Update Failed: HTTP Error occurred: {err}")
    except Exception as err:
        print(f"Server Update Failed: An unexpected error occurred: {err}")

def update_single_replay(game_data):
    """Updates your local MyOpponentHistory.json file."""
    if not os.path.exists(HISTORY_FILE):
        print(f"History file {HISTORY_FILE} not found. Cannot update locally.")
        return

    # FIXED: Changed encoding to 'utf-8-sig' to handle Windows BOM issues
    with open(HISTORY_FILE, 'r', encoding='utf-8-sig') as f:
        history = json.load(f)

    name_to_pulse_id = {}
    for pulse_id, data in history.items():
        opp_name = data.get("Name")
        if opp_name:
            clean_json_name = opp_name.split(']')[-1].strip() if ']' in opp_name else opp_name
            name_to_pulse_id[clean_json_name] = pulse_id

    opp_name = game_data["opp_name"]
    if opp_name in name_to_pulse_id:
        pulse_id = name_to_pulse_id[opp_name]
        matchup_string = f"{game_data['my_race']}v{game_data['opp_race']}"

        if "Matchups" not in history[pulse_id]:
            history[pulse_id]["Matchups"] = {}
        if matchup_string not in history[pulse_id]["Matchups"]:
            history[pulse_id]["Matchups"][matchup_string] = {"Wins": 0, "Losses": 0, "Games": []}

        existing_games = history[pulse_id]["Matchups"][matchup_string]["Games"]

        if not is_duplicate(game_data, existing_games):
            if game_data["result"] == "Victory":
                history[pulse_id]["Matchups"][matchup_string]["Wins"] += 1
            else:
                history[pulse_id]["Matchups"][matchup_string]["Losses"] += 1

            history[pulse_id]["Matchups"][matchup_string]["Games"].append({
                "Date": game_data["date"],
                "Result": game_data["result"],
                "Map": game_data["map"],
                "Duration": game_data.get("duration")
            })

            # FIXED: Also changed writing encoding to 'utf-8-sig' for consistency
            with open(HISTORY_FILE, 'w', encoding='utf-8-sig') as f:
                json.dump(history, f, indent=4)
            print(f"Local JSON Updated! Added game vs {opp_name} ({game_data['result']}).")
        else:
            print("Duplicate game detected. Skipping local JSON update.")
    else:
        print(f"Opponent {opp_name} not found in Black Book. Skipping local JSON update.")

class ReplayHandler(FileSystemEventHandler):
    """Listens for new .SC2Replay files and triggers updates."""
    def on_created(self, event):
        if event.is_directory or not event.src_path.endswith(".SC2Replay"):
            return

        print(f"\nNew replay detected: {event.src_path}")
        
        if wait_for_file_ready(event.src_path):
            print("Parsing replay data...")
            game_data = process_replay(event.src_path)
            
            if game_data:
                # NEW FILTER: Stop the process immediately if the opponent is an AI
                if "A.I." in game_data["opp_name"]:
                    print(f"Ignored: Match against {game_data['opp_name']} will not be recorded or broadcast.")
                    return

                # 1. Update the local JSON database
                update_single_replay(game_data)
                
                # 2. Send the live payload to your stream overlay server
                send_replay_to_server(game_data)
            else:
                print("Ignored: Not a valid 1v1 match or parsing failed.")

if __name__ == "__main__":
    if not os.path.exists(WATCH_DIR):
        print(f"Directory not found: {WATCH_DIR}")
        exit(1)

    print(f"Starting Replay Watcher on: {WATCH_DIR}")
    print("Waiting for new matches... (Press Ctrl+C to stop)")

    event_handler = ReplayHandler()
    observer = Observer()
    observer.schedule(event_handler, WATCH_DIR, recursive=True)
    observer.start()
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
        print("\nWatcher stopped.")
        
    observer.join()