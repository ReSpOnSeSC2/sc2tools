#!/usr/bin/env python3
"""Build the Locker from one template into its two deployment targets.

  artifact  -> locker_app.html            (standalone; games/library embedded)
  site      -> ../apps/web/public/coaching/locker-site.html
               (served from sc2tools.com; live API supplies games/users,
                so only the static build library + intake lists embed)

Usage:
  python build_locker.py --parsed <parsed.jsonl> --season 68
  python build_locker.py --season 68            (site build only; no games embed)
"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "locker_app_template.html")
SITE_OUT = os.path.normpath(os.path.join(HERE, "..", "apps", "web", "public", "coaching", "locker-site.html"))
BUILD_DEFS = os.path.normpath(os.path.join(HERE, "..", "apps", "replay-engine", "core", "build_definitions.py"))
EXCL = ("Unclassified", "Game Too Short", "Standard Play", "Comp", "Macro Transition")


def esc(s):
    return s.replace("</", "<\\/")


def games_from_parsed(path):
    games = []
    for line in open(path, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        if "date" not in r:
            continue
        games.append({"d": r["date"][:10], "m": r.get("map", ""), "o": r.get("opponent", ""),
                      "res": "W" if r.get("result") == "Win" else "L", "b": r.get("my_build", "")})
    games.sort(key=lambda g: g["d"], reverse=True)
    return games


def intake_builds():
    src = open(BUILD_DEFS, encoding="utf-8").read()
    names = [n for n in re.findall(r'^\s*"([^"]+)":\s*"', src, re.M)
             if not any(e in n for e in EXCL)]
    ib = {r: {"vsT": [], "vsZ": [], "vsP": []} for r in ("Protoss", "Terran", "Zerg", "Random")}

    def add(race, mus, n):
        for mu in mus:
            if n not in ib[race][mu]:
                ib[race][mu].append(n)
    for n in names:
        if n.startswith("PvT"): add("Protoss", ["vsT"], n)
        elif n.startswith("PvZ"): add("Protoss", ["vsZ"], n)
        elif n.startswith("PvP"): add("Protoss", ["vsP"], n)
        elif n.startswith("Protoss"): add("Protoss", ["vsT", "vsZ", "vsP"], n)
        elif n.startswith("Terran"): add("Terran", ["vsT", "vsZ", "vsP"], n)
        elif n.startswith("Zerg"): add("Zerg", ["vsT", "vsZ", "vsP"], n)
    for mu in ("vsT", "vsZ", "vsP"):
        seen = []
        for r in ("Protoss", "Terran", "Zerg"):
            for n in ib[r][mu]:
                if n not in seen:
                    seen.append(n)
        ib["Random"][mu] = seen
    return ib


def library():
    refs = json.load(open(os.path.join(HERE, "coaching_builds.json"), encoding="utf-8"))
    return [{"id": b["id"], "name": b["name"], "matchup": b["matchup"],
             "winrate": b["winrate"], "games": b["games"],
             "order": [{"s": int(o["supply"]), "c": o["clock"], "n": o["name"]} for o in b["order"][:30]],
             "bench": [{"m": m["milestone"], "c": m["median_clock"], "s": m["median_supply"]} for m in b["benchmarks"]]}
            for b in refs["builds"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parsed", default=None, help="parsed.jsonl for the artifact build's game index")
    ap.add_argument("--season", default="68")
    ap.add_argument("--artifact-out", default=os.path.join(HERE, "locker_app.html"))
    a = ap.parse_args()

    t = open(TEMPLATE, encoding="utf-8").read()
    lib = esc(json.dumps(library(), separators=(",", ":")))
    ib = esc(json.dumps(intake_builds(), separators=(",", ":")))

    base = t.replace("__LIBRARY__", lib).replace("__INTAKE_BUILDS__", ib).replace("__CUR_SEASON__", a.season)

    # site build: no embedded game index — the API is live
    os.makedirs(os.path.dirname(SITE_OUT), exist_ok=True)
    open(SITE_OUT, "w", encoding="utf-8").write(base.replace("__GAMES__", "[]"))
    print(f"site     -> {SITE_OUT}")

    if a.parsed:
        gj = esc(json.dumps(games_from_parsed(a.parsed), separators=(",", ":")))
        open(a.artifact_out, "w", encoding="utf-8").write(base.replace("__GAMES__", gj))
        print(f"artifact -> {a.artifact_out}")
    else:
        print("artifact build skipped (no --parsed)")


if __name__ == "__main__":
    main()
