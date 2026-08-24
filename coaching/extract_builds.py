#!/usr/bin/env python3
"""SC2 Tools Coaching -- reference build extractor.

Reads the replay-engine's parsed.jsonl (one record per ReSpOnSe ladder game)
and produces coaching_builds.json: one reference build per detected opener,
with a real exemplar game, a cleaned supply-by-supply order, chrono plan,
and MEDIAN benchmark timings across every game of that build.

Season policy (per Jonathan):
  * Prefer exemplars played in the CURRENT season window (--season-start /
    --season-end). If a build has no game in the window, fall back to the
    newest game of that build in the database and flag it stale.
  * Re-run each season with a fresh parsed.jsonl to refresh the packet.

Usage:
  python extract_builds.py parsed.jsonl -o coaching_builds.json \
      --season 68 --season-start 2026-06-01 [--min-games 3]
"""
import argparse, json, statistics, sys
from collections import defaultdict

# t=0 cosmetic noise emitted by the engine
JUNK_PREFIXES = ("Beacon", "RewardDance", "Spray")
EXCLUDE_BUILD_SUBSTR = ("Game Too Short", "Unclassified")

# Milestones worth benchmarking (first occurrence, plus numbered repeats for these)
NUMBERED = {"Nexus", "Gateway", "Assimilator", "Stargate", "RoboticsFacility", "Pylon"}
NUMBERED_MAX = {"Nexus": 3, "Gateway": 4, "Assimilator": 4, "Stargate": 3,
                "RoboticsFacility": 2, "Pylon": 2}


def clean_opening(events, cutoff_s=480):
    out = []
    for e in events:
        if e["time"] == 0:
            continue
        if any(e["name"].startswith(p) for p in JUNK_PREFIXES) or e["name"].startswith("Spray"):
            continue
        if e["name"] == "WarpGate":   # morph event; WarpGateResearch already covers it
            continue
        if e["time"] > cutoff_s:
            break
        out.append(e)
    return out


def milestone_stream(events):
    """Yield (key, time, supply): first occurrence per name, numbered for core structures."""
    counts = defaultdict(int)
    seen = set()
    for e in events:
        n = e["name"]
        if e["type"] == "building" and n in NUMBERED:
            counts[n] += 1
            if counts[n] > NUMBERED_MAX.get(n, 1):
                continue
            # the starting Nexus (t=0) is filtered out, so the first Nexus
            # event is the natural expansion -> label it #2
            num = counts[n] + 1 if n == "Nexus" else counts[n]
            key = f"{n} #{num}"
        else:
            if n in seen:
                continue
            seen.add(n)
            key = n
        yield key, e["time"], e["supply"]


def fmt_t(s):
    return f"{int(s)//60}:{int(s)%60:02d}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("parsed", help="parsed.jsonl from the replay engine")
    ap.add_argument("-o", "--out", default="coaching_builds.json")
    ap.add_argument("--season", default="68")
    ap.add_argument("--season-start", default=None, help="YYYY-MM-DD")
    ap.add_argument("--season-end", default=None, help="YYYY-MM-DD")
    ap.add_argument("--min-games", type=int, default=3)
    ap.add_argument("--cutoff", type=int, default=480, help="opening cutoff seconds")
    args = ap.parse_args()

    games = []
    for line in open(args.parsed, encoding="utf-8"):
        r = json.loads(line)
        if "date" not in r or not r.get("my_build"):
            continue
        if any(s in r["my_build"] for s in EXCLUDE_BUILD_SUBSTR):
            continue
        games.append(r)

    by_build = defaultdict(list)
    for g in games:
        by_build[g["my_build"]].append(g)

    def in_season(g):
        d = g["date"][:10]
        if args.season_start and d < args.season_start:
            return False
        if args.season_end and d > args.season_end:
            return False
        return True

    builds = []
    for name, gs in sorted(by_build.items(), key=lambda kv: -len(kv[1])):
        if len(gs) < args.min_games:
            continue
        wins = sum(1 for g in gs if g.get("result") == "Win")
        # exemplar: newest in-season win > newest in-season > newest win > newest
        pool = [g for g in gs if in_season(g)]
        stale = not pool
        if not pool:
            pool = gs
        pool.sort(key=lambda g: (g.get("result") == "Win", g["date"]), reverse=True)
        ex = pool[0]

        opening = clean_opening(ex["opening"], args.cutoff)
        order = [{"supply": e["supply"], "time": e["time"], "clock": fmt_t(e["time"]),
                  "type": e["type"], "name": e["name"]} for e in opening]

        # median benchmarks across ALL games of this build
        buckets = defaultdict(list)   # key -> [(time, supply)]
        for g in gs:
            for key, t, sup in milestone_stream(clean_opening(g["opening"], args.cutoff)):
                buckets[key].append((t, sup))
        benchmarks = []
        for key, vals in buckets.items():
            if len(vals) < max(2, len(gs) // 2):   # only stable milestones
                continue
            ts = [v[0] for v in vals]
            sups = [v[1] for v in vals]
            benchmarks.append({
                "milestone": key,
                "median_time": int(statistics.median(ts)),
                "median_clock": fmt_t(statistics.median(ts)),
                "median_supply": round(statistics.median(sups), 1),
                "samples": len(vals),
                "spread_s": int(statistics.quantiles(ts, n=4)[2] - statistics.quantiles(ts, n=4)[0]) if len(ts) >= 4 else None,
            })
        benchmarks.sort(key=lambda b: b["median_time"])

        chronos = [{"time": c["time"], "clock": fmt_t(c["time"]), "target": c["target"]}
                   for c in ex.get("chronos", []) if c["time"] <= args.cutoff]

        matchup = name.split(" - ")[0] if " - " in name else "P"
        builds.append({
            "id": name.lower().replace(" ", "-").replace("'", "").replace("/", "-"),
            "name": name,
            "matchup": matchup,
            "games": len(gs), "wins": wins, "losses": len(gs) - wins,
            "winrate": round(100.0 * wins / len(gs), 1),
            "season": args.season,
            "from_current_season": not stale,
            "exemplar": {"file": ex["file"], "date": ex["date"], "map": ex["map"],
                          "opponent": ex.get("opponent"), "opp_race": ex.get("opp_race"),
                          "result": ex.get("result"), "patch": ex.get("release")},
            "order": order,
            "chrono_plan": chronos,
            "benchmarks": benchmarks,
        })

    out = {
        "brand": "SC2 Tools Coaching",
        "coach": "ReSpOnSe",
        "season": args.season,
        "season_window": [args.season_start, args.season_end],
        "source_games": len(games),
        "builds": builds,
    }
    json.dump(out, open(args.out, "w", encoding="utf-8"), indent=1)
    ms = [b for b in builds if not b["from_current_season"]]
    print(f"{len(builds)} reference builds from {len(games)} games -> {args.out}")
    if ms:
        print(f"NOTE: {len(ms)} builds had no season-{args.season} example; "
              f"newest available game used (flagged from_current_season=false).")

if __name__ == "__main__":
    main()
