#!/usr/bin/env python3
"""SC2 Tools Coaching -- Build Execution Grader (the value-add).

Takes a student's .SC2Replay, extracts their opening with sc2reader in the
same event vocabulary as the replay engine, auto-matches it to one of the
coach's reference builds (coaching_builds.json), and grades execution
milestone-by-milestone against the coach's MEDIAN timings.

Output: terminal summary, <replay>.grade.json, and a branded HTML report card.

Usage:
  python grade_replay.py student.SC2Replay --refs coaching_builds.json \
      [--player NameSubstr] [--build build-id] [--html report.html]

Requires: pip install sc2reader==1.8.0 (clean venv; see repo README).
"""
import argparse, json, os, sys
from collections import defaultdict

import sc2reader

FPS = 22.4  # frames -> real seconds (same timebase as the replay engine)

PROTOSS_BUILDINGS = {
    "Nexus", "Pylon", "Gateway", "WarpGate", "Assimilator", "Forge",
    "CyberneticsCore", "PhotonCannon", "ShieldBattery", "RoboticsFacility",
    "Stargate", "TwilightCouncil", "RoboticsBay", "FleetBeacon",
    "TemplarArchive", "TemplarArchives", "DarkShrine",
}
JUNK_PREFIXES = ("Beacon", "RewardDance", "Spray")
SKIP_UNITS = {"Probe", "Larva", "Broodling", "Interceptor", "AdeptPhaseShift",
              "MULE", "Egg", "Overlord"}

# scoring: full credit within GRACE seconds of the coach median, zero at FAIL
GRACE, FAIL = 12, 90
WEIGHTS = {"building": 2.0, "upgrade": 1.5, "unit": 1.0}


def extract_opening(path, player_hint=None, cutoff=480):
    replay = sc2reader.load_replay(path, load_level=4)
    protoss = [p for p in replay.players if p.play_race == "Protoss"]
    pool = replay.players
    if player_hint:
        pool = [p for p in replay.players if player_hint.lower() in p.name.lower()]
        if not pool:
            sys.exit(f"No player matching '{player_hint}' in {path}")
    elif len(protoss) == 1:
        pool = protoss
    player = pool[0]

    last_supply = defaultdict(lambda: 12.0)
    events = []
    for ev in replay.events:
        t = ev.frame / FPS
        if t > cutoff + 60:
            break
        name = type(ev).__name__
        if name == "PlayerStatsEvent" and ev.pid == player.pid:
            last_supply[player.pid] = ev.food_used
        elif name in ("UnitInitEvent", "UnitBornEvent"):
            unit = ev.unit
            if unit is None or unit.owner is None or unit.owner.pid != player.pid:
                continue
            uname = ev.unit_type_name
            if t == 0 or uname in SKIP_UNITS or uname == "WarpGate" \
                    or any(uname.startswith(p) for p in JUNK_PREFIXES):
                continue
            etype = "building" if uname in PROTOSS_BUILDINGS else "unit"
            if name == "UnitBornEvent" and etype == "building":
                continue  # buildings 'born' at t=0 or from morphs we don't track
            if t <= cutoff:
                events.append({"type": etype, "name": uname,
                               "time": int(t), "supply": last_supply[player.pid]})
        elif name == "UpgradeCompleteEvent" and ev.pid == player.pid:
            uname = ev.upgrade_type_name
            if t == 0 or any(uname.startswith(p) for p in JUNK_PREFIXES):
                continue
            if t <= cutoff:
                events.append({"type": "upgrade", "name": uname,
                               "time": int(t), "supply": last_supply[player.pid]})
    meta = {
        "player": player.name,
        "matchup": "Pv" + ("".join(p.play_race[0] for p in replay.players if p.pid != player.pid) or "?"),
        "map": replay.map_name,
        "date": str(replay.start_time),
        "length_s": int(replay.game_length.seconds),
        "result": player.result,
    }
    return meta, events


def milestones_of(events):
    """Same numbering scheme as extract_builds.milestone_stream."""
    NUMBERED_MAX = {"Nexus": 3, "Gateway": 4, "Assimilator": 4, "Stargate": 3,
                    "RoboticsFacility": 2, "Pylon": 2}
    counts, seen, out = defaultdict(int), set(), {}
    for e in events:
        n = e["name"]
        if e["type"] == "building" and n in NUMBERED_MAX:
            counts[n] += 1
            if counts[n] > NUMBERED_MAX[n]:
                continue
            num = counts[n] + 1 if n == "Nexus" else counts[n]
            key = f"{n} #{num}"
        else:
            if n in seen:
                continue
            seen.add(n)
            key = n
        out[key] = (e["time"], e["supply"], e["type"])
    return out


def score_against(build, student_ms):
    rows, total_w, total_s = [], 0.0, 0.0
    for bm in build["benchmarks"]:
        key = bm["milestone"]
        base = key.split(" #")[0]
        etype = _ref_type(build, key) or ("building" if base in PROTOSS_BUILDINGS else "unit")
        w = WEIGHTS.get(etype, 1.0)
        hit = student_ms.get(key)
        if hit is None:
            rows.append({"milestone": key, "target": bm["median_clock"],
                         "target_supply": bm["median_supply"], "actual": None,
                         "delta_s": None, "score": 0, "weight": w})
            total_w += w
            continue
        t, sup, _ = hit
        delta = t - bm["median_time"]
        ad = abs(delta)
        s = 100.0 if ad <= GRACE else max(0.0, 100.0 * (1 - (ad - GRACE) / (FAIL - GRACE)))
        rows.append({"milestone": key, "target": bm["median_clock"],
                     "target_supply": bm["median_supply"],
                     "actual": f"{t//60}:{t%60:02d}", "actual_supply": sup,
                     "delta_s": delta, "score": round(s, 1), "weight": w})
        total_w += w
        total_s += s * w
    overall = total_s / total_w if total_w else 0.0
    return overall, rows


def _ref_type(build, key):
    base = key.split(" #")[0]
    for o in build["order"]:
        if o["name"] == base:
            return o["type"]
    return "building" if base in PROTOSS_BUILDINGS else None


def letter(x):
    for cut, l in [(93, "A"), (90, "A-"), (87, "B+"), (83, "B"), (80, "B-"),
                   (77, "C+"), (73, "C"), (70, "C-"), (60, "D")]:
        if x >= cut:
            return l
    return "F"


def auto_match(refs, matchup, student_ms):
    cands = [b for b in refs["builds"] if b["matchup"] == matchup] or refs["builds"]
    best, best_key = None, -1
    for b in cands:
        s, rows = score_against(b, student_ms)
        matched = sum(1 for r in rows if r["actual"] is not None)
        # favor references that explain MORE of the student's opening at a
        # high score, not sparse references that trivially fit
        key = s * (matched ** 0.5)
        if key > best_key:
            best, best_key = b, key
    return best


def render_html(meta, build, overall, rows, out_path, notes):
    g = letter(overall)
    def row_html(r):
        if r["actual"] is None:
            cls, d = "miss", "not built in window"
        else:
            d = r["delta_s"]
            cls = "ok" if abs(d) <= GRACE else ("warn" if abs(d) <= 45 else "late")
            d = ("+" if d >= 0 else "−") + f"{abs(d)}s"
        return (f"<tr class='{cls}'><td>{r['milestone']}</td>"
                f"<td>{r['target']} <span class='sup'>@{r['target_supply']}</span></td>"
                f"<td>{r['actual'] or '—'}</td><td>{d}</td><td>{r['score']:.0f}</td></tr>")
    trs = "\n".join(row_html(r) for r in rows)
    lis = "\n".join(f"<li>{n}</li>" for n in notes)
    html = f"""<!doctype html><html><head><meta charset='utf-8'>
<title>Build Report Card — {meta['player']}</title><style>
body{{background:#0b0e14;color:#dbe2ef;font:15px/1.5 'Segoe UI',system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem}}
h1{{font-size:1.5rem;margin:0}} .brand{{color:#58a6ff;font-weight:600;letter-spacing:.06em;text-transform:uppercase;font-size:.8rem}}
.card{{background:#121826;border:1px solid #1f2a3d;border-radius:12px;padding:1.2rem 1.5rem;margin:1rem 0}}
.grade{{font-size:3.2rem;font-weight:800;color:{'#3fb950' if overall>=80 else '#d29922' if overall>=60 else '#f85149'}}}
table{{width:100%;border-collapse:collapse;font-size:.92rem}} td,th{{padding:.4rem .6rem;border-bottom:1px solid #1f2a3d;text-align:left}}
tr.ok td:nth-child(4){{color:#3fb950}} tr.warn td:nth-child(4){{color:#d29922}} tr.late td:nth-child(4),tr.miss td{{color:#f85149}}
.sup{{color:#8b949e;font-size:.8em}} .meta{{color:#8b949e;font-size:.9rem}}
</style></head><body>
<div class='brand'>SC2 Tools Coaching · Build Execution Report</div>
<h1>{meta['player']} — {build['name']}</h1>
<div class='meta'>{meta['map']} · {meta['date']} · {meta['matchup']} · result: {meta['result']}</div>
<div class='card'><span class='grade'>{g}</span>&nbsp;&nbsp;<b>{overall:.1f} / 100</b> Build Adherence
<div class='meta'>Graded vs coach ReSpOnSe's median timings over {build['games']} games ({build['winrate']}% win rate), season {build['season']}.</div></div>
<div class='card'><table><tr><th>Milestone</th><th>Coach target</th><th>You</th><th>Delta</th><th>Score</th></tr>{trs}</table></div>
<div class='card'><b>Coach's focus points</b><ul>{lis}</ul></div>
<div class='meta'>Generated by the SC2 Tools coaching pipeline · sc2tools.com</div>
</body></html>"""
    open(out_path, "w", encoding="utf-8").write(html)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("replay")
    ap.add_argument("--refs", default="coaching_builds.json")
    ap.add_argument("--player", default=None)
    ap.add_argument("--build", default=None, help="reference build id (else auto-match)")
    ap.add_argument("--html", default=None)
    ap.add_argument("--json", dest="json_out", default=None)
    args = ap.parse_args()

    refs = json.load(open(args.refs, encoding="utf-8"))
    meta, events = extract_opening(args.replay, args.player)
    student_ms = milestones_of(events)

    if args.build:
        build = next((b for b in refs["builds"] if b["id"] == args.build), None)
        if not build:
            sys.exit(f"Unknown build id {args.build}")
    else:
        build = auto_match(refs, meta["matchup"], student_ms)

    overall, rows = score_against(build, student_ms)

    notes = []
    worst = sorted((r for r in rows if r["score"] < 70), key=lambda r: r["score"])[:4]
    for r in worst:
        if r["actual"] is None:
            notes.append(f"{r['milestone']}: never started in the opening window — "
                         f"coach hits it at {r['target']} (@{r['target_supply']} supply).")
        else:
            late = r["delta_s"] > 0
            notes.append(f"{r['milestone']}: {abs(r['delta_s'])}s {'late' if late else 'early'} "
                         f"({r['actual']} vs {r['target']}). "
                         + ("Check probe cut / supply block just before this." if late else
                            "Early is fine only if the economy behind it kept up."))
    if not notes:
        notes.append("Execution is within the coach's grace window on every milestone. "
                     "Next step: same build under harass pressure.")

    print(f"\n{meta['player']} — {build['name']}  [{meta['matchup']}, {meta['map']}]")
    print(f"Build Adherence: {overall:.1f}/100  grade {letter(overall)}")
    for r in rows:
        d = "MISS" if r["actual"] is None else f"{r['delta_s']:+d}s"
        print(f"  {r['milestone']:<28} target {r['target']:>5}  you {r['actual'] or '--':>5}  {d:>6}  {r['score']:.0f}")

    base = os.path.splitext(args.replay)[0]
    json.dump({"meta": meta, "build": build["id"], "overall": round(overall, 1),
               "grade": letter(overall), "rows": rows, "notes": notes},
              open(args.json_out or base + ".grade.json", "w"), indent=1)
    render_html(meta, build, overall, rows, args.html or base + ".report.html", notes)
    print(f"\nReport card: {args.html or base + '.report.html'}")

if __name__ == "__main__":
    main()
