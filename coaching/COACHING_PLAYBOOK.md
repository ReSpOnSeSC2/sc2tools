# SC2 Tools Coaching — Program Playbook

**Coach:** ReSpOnSe (Protoss) · **Brand:** SC2 Tools Coaching · **Model:** boutique, few students, precision-catered
**Data foundation:** 679 parsed ladder games, 26 reference builds with median benchmark timings, refreshed every season.

---

## 1. Positioning: what the market sells vs. what you can actually operationalize

A scan of the current market (Metafy SC2 coaches, Fiverr/Gumroad coaching packages, and AI analyzers like starcraft2.ai and hobby replay-LLM projects) shows two clusters:

**Table stakes — nearly every coach offers these. Offer them, but never lead with them:**
live 1:1 sessions over Discord with screen share, async replay/VOD reviews, a build order sheet or Spawning Tool link, Discord DM access between sessions, and "personalized practice plans" that are in practice a text note. Generic AI analyzers exist too, but they grade against *global* heuristics, not against a specific coach's game.

**Genuinely differentiated — what almost nobody operationalizes, and what you already have the infrastructure for:**

1. **Automated Build Execution Grading.** Student plays their assigned build on ladder, drops the replay, and gets an objective report card graded against *your* median timings from *your* real games — letter grade, per-milestone deltas, focus points — without waiting for a session. Other coaches physically cannot offer this; it requires a replay engine with a build-rules system, which you own.
2. **Personal benchmarks, not generic ones.** Every timing in the packet is the median across your actual games of that build this season, with the win rate printed next to it (e.g. PvZ DT into 3 Stargate Void Ray: 85% over 27 games). "Hit 2:27 Stargate because that is my median over 117 PvT games" lands very differently from a copied Spawning Tool page.
3. **Living, versioned build library.** The packet regenerates from `parsed.jsonl` each season. Builds carry a season tag; anything without a current-season example is flagged stale and backed by the newest game on record. Students see the library *change* when the meta changes — a subscription-shaped reason to stay.
4. **Longitudinal student analytics.** Every graded replay appends to the student's history: adherence trend, per-milestone consistency, matchup win rate while on-build vs off-build. After a month you can show a student a chart of themselves improving. This is the retention engine.
5. **Proactive analyst work between sessions.** Because grading is automated, your human time goes where it's irreplaceable: watching the 2–3 lowest-scoring replays, annotating the report cards, and opening each session with an agenda the data already wrote.
6. **Opponent intel as a perk.** Students get SC2 Tools access — permanent opponent dossiers, auto-classification of their own ladder games, the OBS overlay. No other coach bundles their own product.

**The pitch in one sentence:** *"Most coaches sell you an hour. I run you like a pro-team player: my builds from my current-season games, automated execution grading on every replay you submit, and a personal analytics record that shows exactly what improved."*

---

## 2. The offer (boutique, capacity-capped)

Keep it to **4–6 active students maximum** and say so publicly — scarcity is honest here because the model is high-touch.

**Suggested structure — one tier, done properly:**

- Weekly 60-min 1:1 session (live game review + drill work, not lecture)
- Assigned build(s) for the week, from your library, matched to the student's profile
- **Unlimited replay submissions with automated grading**, with the guarantee: *"I personally review and annotate your lowest-scoring and your best replay every week."*
- Personalized opening packet (see §4), regenerated when the season rolls or their focus changes
- SC2 Tools full access + coaching cohort Discord channel
- Monthly progress report: adherence trend, benchmark deltas, ladder MMR overlay

Pricing guidance (not advice, just market frame): established Masters+/GM coaches list roughly $25–75+/hr on marketplaces; a data-backed program justifies a monthly package (e.g. 4 sessions + unlimited grading + analytics) priced above the equivalent hourly sum rather than below it. Consider a **founding-student rate** for the first 3 in exchange for testimonials and tolerance of rough edges.

Do the money admin boring and safe: a scheduling link with time-zone handling (Cal.com/Calendly), payment up front by month (Stripe payment link or the marketplace's rails while you bootstrap), 24-h reschedule policy, and a written scope note in the packet so "unlimited grading" means replays-on-assigned-builds, not 40 random games a day expecting essays.

---

## 3. The per-student system (how "precisely individually catered" becomes a process)

One folder per student, one small JSON profile that everything else reads:

```
coaching/students/<name>/
  profile.json      # race, league/MMR, hotkey setup, goals, weaknesses,
                    # assigned_builds: [ids from coaching_builds.json]
  packet/           # their personalized packet (regenerated, versioned)
  replays/          # submitted replays
  grades/           # one .grade.json + report card per replay (the history)
```

**Intake (before session 1, in the packet):** current + peak MMR per matchup, 3 recent losses that *hurt*, what they blame (their answer tells you more than the replays), practice hours/week, mechanical setup (camera keys? rapid-fire? warpgate cycling habit?), and 5 submitted replays. You grade those five *before* the first call — so session 1 opens with their baseline report cards on screen. That first "whoa" moment is the money's-worth moment.

**Build assignment:** pick from your library by profile, not by meta fashion — e.g. a mechanically sloppy 4.4k: PvT Phoenix into Robo (your 117-game bread and butter), PvZ Stargate Opener, PvP 2 Gate Expand; a sharp-but-passive player: your DT into 3 Stargate Void Ray (85% WR) to force proactive play. One build per matchup, held for 2+ weeks. Depth over novelty is the whole coaching thesis at Masters+.

**Weekly loop (the service model competitors don't run):**

1. Student plays assigned builds on ladder; drops replays in their folder/Discord.
2. `grade_replay.py` runs on each (manual now; watcher later) → report card back same day.
3. You skim the grade table (seconds per replay), deep-watch the outliers, and add 2–3 coach lines to those cards.
4. Session agenda auto-writes itself: worst recurring milestone, best improvement, one new situation to drill.
5. Friday: one-paragraph week note + adherence trend. Ten minutes of your time, pro-team feel.

**Session shape (60 min):** 5 review of week's data → 20 replay deep-dive on the recurring deviation → 20 live drill (they play a custom/ladder game executing the fix while you watch) → 10 reset goals, assign next week, update profile.

---

## 4. The opening packet (the day-one value bomb)

Generated per student by `make_packet.py` from their profile + the current `coaching_builds.json`. Contents:

1. Welcome letter — the program promise, capacity note, how the weekly loop works
2. **Their** assigned builds, one per matchup: full supply-by-supply order from a real current-season game of yours (map, date, opponent, result printed), chrono plan, and the median benchmark table with sample sizes
3. How grading works: the report card explained, what an A vs C means, the grace window, how to submit replays
4. Benchmarks & goals page: their intake baseline next to your medians — the gap is the curriculum
5. Practice protocol: warm-up routine, how many games, when to stop, one-mistake review method
6. Intake questionnaire (first packet only)
7. Program logistics: scheduling, Discord, SC2 Tools activation steps, policies

Delivery: **PDF** (the tangible "I paid for this" object) + the **web build library** (living reference that updates seasonally). Both branded SC2 Tools.

---

## 5. The seasonal refresh SOP (keeps the library "living")

At each new ladder season (or balance patch):

1. Export/refresh `parsed.jsonl` from the replay engine over your ladder replays.
2. `python extract_builds.py parsed.jsonl -o coaching_builds.json --season 69 --season-start <date>`
   — current-season exemplars preferred; stale builds flagged `from_current_season: false` automatically.
3. Regenerate each active student's packet; changelog note in Discord ("PvT Robo timing moved 10s earlier this patch — packet v3").
4. Archive last season's `coaching_builds.json` — that history *is* the build versioning story.

---

## 6. Roadmap: fold coaching into the SC2 Tools product

Near term (manual, zero build cost): run the pipeline by hand, deliver cards as HTML in Discord.
Mid term: a `coaching/` watch-folder so submitted replays auto-grade; student packet page hosted on sc2tools.com behind their login; adherence trend chart from the accumulated `.grade.json` files.
Long term: "Coach mode" as a product feature — coaches upload reference builds, students link accounts, grading + longitudinal analytics in-app. Your coaching practice becomes the design lab for a SaaS feature no competitor (human or AI-analyzer) currently ships.

---

## 7. Marketing that fits a 4–6 student practice

You don't need funnels; you need proof. Post one anonymized before/after report card pair + adherence trend to r/allthingsprotoss and Team Liquid; a 60-second clip of a replay being auto-graded (that demo is inherently shareable); the SC2 Tools site gets a /coaching page with the capacity counter. Marketplace listings (Metafy) are fine as discovery, but route the actual program through your own rails where the tooling lives.

---

## 8. Honest edges to manage

- **Auto-match is a convenience; assignment is the contract.** Grade against the *assigned* build id (`--build`); auto-match can mislabel close PvP variants.
- The grader measures **openings** (first 8 min). Say so: execution grading covers the build; game sense is what sessions are for.
- Medians come from *your* MMR context; a 4.2k student hitting +15s across the board is fine early — grade the *trend*, and consider a per-student grace multiplier at intake.
- "Game Too Short" and cheese losses shouldn't tank a week's average — exclude sub-4-minute games from trend stats.
- Blizzard IP: keep branding "independent, not affiliated" (already on the site).
