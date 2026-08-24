#!/usr/bin/env python3
"""SC2 Tools Coaching -- personalized opening-packet generator.

Reads a student profile + coaching_builds.json and emits a branded,
print-ready HTML packet (and a PDF via headless Chromium if available).

Usage:
  python make_packet.py students/Alex/profile.json --refs coaching_builds.json \
      [--out packet.html] [--pdf packet.pdf] [--chromium /path/to/chromium]
"""
import argparse, html, json, os, shutil, subprocess, sys

ACCENT = "#2563eb"; GOLD = "#b8860b"; INK = "#111827"; MUTE = "#6b7280"

CSS = f"""
@page {{ size: letter; margin: 16mm 14mm; }}
* {{ box-sizing: border-box; }}
body {{ font: 10.5pt/1.55 'Segoe UI', system-ui, sans-serif; color: {INK}; margin: 0; background:#fff; }}
h1 {{ font-size: 21pt; margin: 0 0 2pt; letter-spacing: -.01em; }}
h2 {{ font-size: 13pt; margin: 18pt 0 6pt; color: {ACCENT}; border-bottom: 1.5pt solid {ACCENT}22; padding-bottom: 3pt; }}
h3 {{ font-size: 11pt; margin: 12pt 0 4pt; }}
.brand {{ color: {ACCENT}; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; font-size: 8.5pt; }}
.mute {{ color: {MUTE}; font-size: 9pt; }}
.tag {{ display:inline-block; background:{ACCENT}14; color:{ACCENT}; border-radius: 9pt; padding: 1pt 8pt; font-size: 8.5pt; font-weight:600; margin-right:4pt; }}
.tag.gold {{ background:#b8860b1a; color:{GOLD}; }}
.tag.warn {{ background:#dc26261a; color:#b91c1c; }}
.card {{ border: 1pt solid #e5e7eb; border-radius: 8pt; padding: 10pt 12pt; margin: 8pt 0; page-break-inside: avoid; }}
table {{ width: 100%; border-collapse: collapse; font-size: 9pt; }}
th {{ text-align: left; color: {MUTE}; font-weight: 600; border-bottom: 1pt solid #d1d5db; padding: 2pt 6pt; }}
td {{ padding: 2pt 6pt; border-bottom: .5pt solid #f3f4f6; }}
.num {{ font-variant-numeric: tabular-nums; }}
.cols {{ display: flex; gap: 12pt; }} .cols > div {{ flex: 1; }}
.cols table {{ font-size: 8pt; }} .cols td, .cols th {{ padding: 1pt 5pt; line-height: 1.2; }}
.cols .card {{ padding: 6pt 9pt; margin: 4pt 0; }} .cols h3 {{ margin: 4pt 0 3pt; }}
.buildhead p {{ margin: 3pt 0; }}
.callout {{ background: {ACCENT}0d; border-left: 3pt solid {ACCENT}; padding: 8pt 10pt; border-radius: 0 6pt 6pt 0; margin: 8pt 0; }}
.pb {{ page-break-before: always; }}
.qa {{ border-bottom: .75pt solid #d1d5db; height: 16pt; }}
ol li, ul li {{ margin: 3pt 0; }}
.grade-scale td {{ padding: 3pt 6pt; }}
footer {{ margin-top: 24pt; font-size: 8pt; color: {MUTE}; }}
"""


def fmt_order(build, max_rows=32):
    rows = []
    for o in build["order"][:max_rows]:
        rows.append(f"<tr><td class='num'>{o['supply']:.0f}</td><td class='num'>{o['clock']}</td>"
                    f"<td>{html.escape(o['name'])}</td><td class='mute'>{o['type']}</td></tr>")
    return "\n".join(rows)


def fmt_bench(build):
    rows = []
    for b in build["benchmarks"]:
        spread = f"±{b['spread_s']//2}s" if b.get("spread_s") is not None else "—"
        rows.append(f"<tr><td>{html.escape(b['milestone'])}</td><td class='num'>{b['median_clock']}</td>"
                    f"<td class='num'>{b['median_supply']}</td><td class='num'>{spread}</td>"
                    f"<td class='num mute'>{b['samples']}</td></tr>")
    return "\n".join(rows)


def build_section(build, pb=True):
    ex = build["exemplar"]
    stale = "" if build["from_current_season"] else \
        "<span class='tag warn'>pre-season example — newest on record</span>"
    chrono = " · ".join(f"{c['clock']} → {c['target']}" for c in build["chrono_plan"][:8]) or "—"
    return f"""
<div class="{'pb' if pb else ''} buildhead">
<h2 style="margin-top:0">{html.escape(build['name'])}</h2>
<p><span class="tag">{build['matchup']}</span>
<span class="tag gold">{build['winrate']}% win rate · {build['games']} games</span>
<span class="tag">season {build['season']}</span> {stale}</p>
<p class="mute">Reference game: {html.escape(ex['map'])} vs {html.escape(str(ex['opponent']))} ({ex['opp_race']}) —
{ex['date'][:10]}, {ex['result']}. Every timing below is from coach ReSpOnSe's real ladder games; the
benchmark column is the <b>median across all {build['games']} games</b> of this build.</p>
<div class="cols">
  <div class="card"><h3>Supply-by-supply opening</h3>
    <table><tr><th>Supply</th><th>Clock</th><th>Action</th><th></th></tr>{fmt_order(build)}</table>
  </div>
  <div class="card"><h3>Benchmarks you are graded on</h3>
    <table><tr><th>Milestone</th><th>Median</th><th>@Supply</th><th>Spread</th><th>n</th></tr>{fmt_bench(build)}</table>
    <h3 style="margin-top:8pt">Chrono plan (reference game)</h3>
    <p class="mute">{chrono}</p>
  </div>
</div>
</div>"""


def make_html(profile, refs):
    name = profile["name"]
    assigned = [b for b in refs["builds"] if b["id"] in profile["assigned_builds"]]
    missing = set(profile["assigned_builds"]) - {b["id"] for b in assigned}
    if missing:
        print(f"WARNING: assigned build ids not in refs: {missing}", file=sys.stderr)
    goals = "".join(f"<li>{html.escape(g)}</li>" for g in profile.get("goals", []))
    builds_html = "\n".join(build_section(b) for b in assigned)
    mmr = profile.get("mmr", {})
    mmr_row = " · ".join(f"{k} {v}" for k, v in mmr.items()) or "—"

    return f"""<!doctype html><html><head><meta charset="utf-8">
<title>SC2 Tools Coaching — Opening Packet — {html.escape(name)}</title><style>{CSS}</style></head><body>

<div class="brand">SC2 Tools Coaching · sc2tools.com</div>
<h1>Welcome, {html.escape(name)}.</h1>
<p class="mute">Personal opening packet · prepared by coach ReSpOnSe · season {refs['season']} · packet v{profile.get('packet_version', 1)}</p>

<div class="callout"><b>The program in one sentence:</b> you will be run like a pro-team player —
my builds from my current-season ladder games, automated execution grading on every replay you submit,
and a personal analytics record that shows exactly what improved and when.</div>

<h2>How this works</h2>
<ol>
<li><b>You get my real builds.</b> Each matchup section below is generated from my own ladder database
({refs['source_games']} parsed games this cycle) — the exact game it came from is cited, and the benchmark
timings are my medians, not copied guides.</li>
<li><b>You play them on ladder</b> and drop your replays in your submission channel. Every replay is
machine-graded against my benchmarks the same day: a letter grade, a milestone-by-milestone delta table,
and focus points. I personally review and annotate your lowest and strongest replay each week.</li>
<li><b>We meet weekly.</b> Sessions start from your data — the recurring deviation, the trend, one drill.
No generic lectures.</li>
<li><b>The packet is alive.</b> When the season rolls or the meta moves, this document regenerates and
you get a changelog. Your build library stays current for as long as you train with me.</li>
</ol>

<h2>Your profile & goals</h2>
<div class="card">
<p><b>Current MMR:</b> {mmr_row}<br>
<b>Focus matchups:</b> {html.escape(", ".join(profile.get("focus_matchups", [])) or "all")}<br>
<b>Assigned builds:</b> {", ".join(html.escape(b["name"]) for b in assigned)}</p>
<ul>{goals}</ul>
</div>

<h2>How grading works</h2>
<div class="cols">
<div class="card"><h3>The report card</h3>
<p>Each milestone in your assigned build has a target (my median). Hit it within <b>12 seconds</b> for
full credit; credit decays to zero at 90 seconds off. Buildings weigh double, upgrades 1.5×, units 1×.
The weighted average is your <b>Build Adherence Score</b>.</p>
<table class="grade-scale"><tr><th>Score</th><th>Grade</th><th>Meaning</th></tr>
<tr><td class="num">93+</td><td>A</td><td>Pro-level execution — we work on decisions</td></tr>
<tr><td class="num">80–92</td><td>B</td><td>Solid — one or two leaks to close</td></tr>
<tr><td class="num">60–79</td><td>C–D</td><td>The build isn't automatic yet — drill weeks</td></tr>
<tr><td class="num">&lt;60</td><td>F</td><td>Wrong build or major derailment — we watch it together</td></tr></table>
</div>
<div class="card"><h3>Submitting replays</h3>
<ol>
<li>Play your <b>assigned</b> build for the matchup — grading is against that assignment.</li>
<li>Drop the .SC2Replay in your private channel (or submission folder).</li>
<li>Same day you get the report card. Cheese games under 4 minutes don't count against your trend.</li>
<li>Aim for <b>10+ graded games per matchup per week</b>. Consistency beats volume.</li>
</ol>
<p class="mute">Scores are graded on trend, not absolutes — early weeks are your baseline, not a judgment.</p>
</div>
</div>

<h2>Practice protocol</h2>
<div class="card">
<ul>
<li><b>Warm-up (10 min):</b> one no-opponent build execution vs Elite AI or in-unit-tester — full build to 8:00, benchmarks open on second screen.</li>
<li><b>Ladder block:</b> 3–5 games max per sitting, same build every game regardless of result.</li>
<li><b>One-mistake review (2 min/game):</b> open the report card, find the single worst milestone, say out loud why it slipped, queue again.</li>
<li><b>Stop rule:</b> two tilted losses in a row = end the block. Tilted reps train the wrong thing.</li>
</ul>
</div>

{builds_html}

<div class="pb"></div>
<h2>Intake questionnaire (bring to session 1)</h2>
<div class="card">
<p>1. Current / peak MMR per matchup this season:</p><div class="qa"></div>
<p>2. Three recent losses that <i>hurt</i> — map, matchup, what you think went wrong:</p><div class="qa"></div><div class="qa"></div><div class="qa"></div>
<p>3. What do you blame most for lost games? (macro / builds / scouting / engagements / mental):</p><div class="qa"></div>
<p>4. Practice hours per week you can actually commit:</p><div class="qa"></div>
<p>5. Setup: camera hotkeys? rapid-fire? control-group layout? warp-in habit?</p><div class="qa"></div><div class="qa"></div>
<p>6. Send 5 recent replays (any result) <b>before</b> our first call — your baseline report cards will be ready when we start.</p>
</div>

<h2>Logistics</h2>
<div class="card">
<ul>
<li><b>Sessions:</b> weekly 60 min, booked via your scheduling link; 24-hour reschedule policy.</li>
<li><b>SC2 Tools access:</b> your account includes the full app — opponent dossiers, auto build classification of your own games, and the OBS overlay. Activation steps arrive with your Discord invite.</li>
<li><b>Between sessions:</b> unlimited replay submissions on assigned builds; questions in your private channel answered within 24h on weekdays.</li>
<li><b>Roster:</b> this program takes a maximum of six students at a time.</li>
</ul>
</div>

<footer>SC2 Tools Coaching · coach ReSpOnSe · generated from the season-{refs['season']} build database ·
StarCraft® II is a trademark of Blizzard Entertainment, Inc. SC2 Tools is an independent project,
not affiliated with or endorsed by Blizzard Entertainment.</footer>
</body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("profile")
    ap.add_argument("--refs", default="coaching_builds.json")
    ap.add_argument("--out", default=None)
    ap.add_argument("--pdf", default=None)
    ap.add_argument("--chromium", default=None)
    args = ap.parse_args()

    profile = json.load(open(args.profile, encoding="utf-8"))
    refs = json.load(open(args.refs, encoding="utf-8"))
    out = args.out or os.path.join(os.path.dirname(args.profile) or ".",
                                   f"{profile['name'].replace(' ', '_')}-opening-packet.html")
    open(out, "w", encoding="utf-8").write(make_html(profile, refs))
    print(f"packet HTML -> {out}")

    if args.pdf:
        chrom = args.chromium or shutil.which("chromium") or shutil.which("chrome") \
            or shutil.which("msedge") or "/opt/pw-browsers/chromium"
        if os.path.exists(chrom) or shutil.which(chrom):
            subprocess.run([chrom, "--headless", "--disable-gpu", "--no-sandbox",
                            f"--print-to-pdf={args.pdf}", "--no-pdf-header-footer",
                            os.path.abspath(out)], check=True, capture_output=True)
            print(f"packet PDF  -> {args.pdf}")
        else:
            print("no chromium found; skipped PDF (pass --chromium)", file=sys.stderr)

if __name__ == "__main__":
    main()
