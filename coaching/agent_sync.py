#!/usr/bin/env python3
"""SC2 Tools agent -> Locker sync.

Turns the replay data the SC2 Tools agent/engine already produces into a
locker-sync JSON the Locker imports (Inbox tab -> "Import agent sync").
Fills the replay-admission lanes, marks the agent connected, and stamps
the sync date — no hand-typed counts.

Sources (auto-detected):
  * parsed.jsonl produced by the replay engine        (uses each game's date)
  * a folder of .SC2Replay files                      (reads dates via sc2reader)
  * a replays-<student>-*.json bundle from the Locker (reads dates via sc2reader)

Season lanes:
  active      game date >= --season-start                (current season)
  bridge      --bridge-start <= date < --season-start    (last season; default 90d window)
  historical  older than the bridge window
  quarantine  unreadable / undated games

Usage:
  python agent_sync.py parsed.jsonl        --student ReSpOnSe --season 68 --season-start 2026-06-01
  python agent_sync.py inbox/Alex/2026-08-24 --student Alex   --season 68 --season-start 2026-06-01
"""
import argparse, base64, datetime as dt, json, os, sys, tempfile


def dates_from_jsonl(path, student):
    games, quarantine = [], 0
    for line in open(path, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            quarantine += 1
            continue
        if student and student.lower() not in str(r.get("me", "")).lower():
            continue
        d = (r.get("date") or "")[:10]
        if d:
            games.append({"d": d, "m": r.get("map", ""), "o": r.get("opponent", ""),
                          "res": "W" if r.get("result") == "Win" else "L",
                          "b": r.get("my_build", "")})
        else:
            quarantine += 1
    return games, quarantine


def dates_from_replays(paths, student):
    try:
        import sc2reader
    except ImportError:
        sys.exit("sc2reader not installed — use the coaching venv (see repo README).")
    games, quarantine = [], 0
    for p in paths:
        try:
            rep = sc2reader.load_replay(p, load_level=2)
            me = next((pl for pl in rep.players if student and student.lower() in pl.name.lower()), None)
            if student and me is None:
                continue
            opp = next((pl.name for pl in rep.players if me is None or pl.pid != me.pid), "")
            games.append({"d": str(rep.start_time)[:10], "m": rep.map_name, "o": opp,
                          "res": "W" if (me and me.result == "Win") else ("L" if me else ""), "b": ""})
        except Exception:
            quarantine += 1
    return games, quarantine


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="parsed.jsonl | folder of .SC2Replay | Locker replay bundle .json")
    ap.add_argument("--student", required=True, help="player name as it appears in game")
    ap.add_argument("--season", default="68")
    ap.add_argument("--season-start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--bridge-start", default=None, help="YYYY-MM-DD (default: 90 days before season start)")
    ap.add_argument("-o", "--out", default=None)
    a = ap.parse_args()

    s_start = a.season_start
    b_start = a.bridge_start or (dt.date.fromisoformat(s_start) - dt.timedelta(days=90)).isoformat()

    src = a.source
    if os.path.isdir(src):
        paths = [os.path.join(src, f) for f in os.listdir(src) if f.lower().endswith(".sc2replay")]
        games, quarantine = dates_from_replays(paths, a.student)
    elif src.lower().endswith(".jsonl"):
        games, quarantine = dates_from_jsonl(src, a.student)
    else:  # Locker bundle: unpack to temp, then read
        bundle = json.load(open(src, encoding="utf-8"))
        tmp = tempfile.mkdtemp(prefix="locker-sync-")
        paths = []
        for it in bundle.get("items", []):
            p = os.path.join(tmp, os.path.basename(it["name"]))
            open(p, "wb").write(base64.b64decode(it["b64"]))
            paths.append(p)
        games, quarantine = dates_from_replays(paths, a.student)

    games.sort(key=lambda g: g["d"], reverse=True)
    dates = [g["d"] for g in games]
    lanes = {"active": 0, "bridge": 0, "historical": 0, "quarantine": quarantine}
    for d in dates:
        if d >= s_start:
            lanes["active"] += 1
        elif d >= b_start:
            lanes["bridge"] += 1
        else:
            lanes["historical"] += 1

    out = {
        "locker": "sc2tools-agent-sync",
        "student": a.student,
        "season": a.season,
        "season_start": s_start,
        "bridge_start": b_start,
        "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "games_seen": len(dates) + quarantine,
        "lanes": lanes,
        "latest_game": max(dates) if dates else None,
        "games": games[:500],
    }
    path = a.out or f"locker-sync-{a.student.replace(' ', '_')}.json"
    json.dump(out, open(path, "w", encoding="utf-8"), indent=1)
    print(f"{out['games_seen']} games -> {path}")
    print(f"  active {lanes['active']} · bridge {lanes['bridge']} · historical {lanes['historical']} · quarantine {lanes['quarantine']}"
          f"  (latest game {out['latest_game']})")
    print("Import it in the Locker: coach view -> Inbox -> Import agent sync.")


if __name__ == "__main__":
    main()
