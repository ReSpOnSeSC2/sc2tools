# SC2 Replay Analyzer — Feature Roadmap
**Competitive differentiation vs sc2replaystats.com and similar tools**
**Last updated:** 2026-04-26

---

## 1. 🎙️ Real-Time AI Coaching Voice Alerts
**What it is:** During a live game, the overlay listens to game events and speaks coaching tips out loud through your headset or speakers using text-to-speech.

**What it does:**
- "Supply blocked — 3rd time this game" when you hit a supply cap
- "No expansion yet — you're 45 seconds behind your average" when you're late to expand
- "Opponent is teching fast — no early aggression seen" based on unit counts
- "You're 12 workers behind your PB at this timing" for macro coaching
- Configurable per matchup: different tips for ZvT vs TvT
- Sensitivity slider so veterans can turn off basic tips, beginners get more

**Why it beats the competition:** sc2replaystats is post-game only. This coaches you *while you play*. No other tool does this.

---

## 2. 🕵️ Pre-Game Opponent Intelligence Dossier
**What it is:** The moment a game loads (detected via MMR scanner or replay watcher), pull up everything known about your opponent before the game even starts.

**What it shows:**
- Their last 10 builds vs your race (e.g. "Goes Banshee cloak 60% vs Protoss")
- Your personal head-to-head record vs this specific player
- Their average game length, aggression timing, expansion timing
- A recommended counter-strategy based on their tendencies
- "Watch out for: early Reaper aggression in 70% of their TvP games"
- If never seen before: pull from community data for their MMR bracket

**Why it beats the competition:** sc2replaystats shows your stats. This shows you how to beat *this specific person* before the game even starts.

---

## 3. 📊 Personal Weakness Report & Coaching Card
**What it is:** A weekly auto-generated report card that analyzes your loss patterns and identifies the specific habits costing you the most games.

**Examples of insights:**
- "You lose 78% of games where you don't expand before 3:30 — avg opponent expands at 2:55"
- "Your win rate drops to 22% when games go past 12 minutes in TvZ — your late game composition needs work"
- "You are supply blocked an average of 4.2 times per game — top 20% of players average 1.1"
- "You win 91% of games where you scout before 2:00 vs 38% when you don't"
- "Your macro score drops sharply after the first engagement — multitasking under pressure is your biggest gap"

Delivered as a visual report card with letter grades per category (Macro, Aggression Timing, Scouting, Expansion, Late Game).

**Why it beats the competition:** Nobody else turns raw replay data into *specific, personal, actionable coaching advice*. This replaces a $50/hr coach for the basics.

---

## 4. 🗺️ Map-Specific Performance Breakdown
**What it is:** Full win rate, build order, and timing analytics broken down by individual map — not just matchup.

**What it shows:**
- Your win rate on each map per matchup (e.g. Ruby Rock: 8-2 TvT, 2-8 ZvT)
- Your best and worst maps ranked
- Which builds you use on each map vs which builds win for you
- Map-specific build recommendations: "On Winter Madness your proxy builds win 85% — try more of them"
- Opponent map preferences pulled from their history
- "Your opponent has banned this map 0 times — they likely play it a lot"

**Why it beats the competition:** sc2replaystats has map data buried in stats. This surfaces it as a strategic tool — what to pick on map vote, what to prepare for.

---

## 5. 🏆 Rival & Player Tracker
**What it is:** Mark specific players as Rivals, Nemeses, or Teammates. Get a dedicated tracking page for each one.

**What it does:**
- Full head-to-head history with a specific player with timeline graph
- Their build tendencies *specifically vs you* (they may play different vs others)
- "You're on a 3-game losing streak vs LetaleX — here's what they've done each game"
- Rematch alert: "LetaleX just queued — you may face them again soon"
- Nemesis badge: auto-tags players you have a losing record against
- "Last time you beat them you went X build at Y timing — try that again"

**Why it beats the competition:** Personal rivalries and nemeses are a huge part of ladder psychology. Nobody tracks this. It's also incredibly engaging to watch your nemesis record turn around.

---

## 6. 📺 Dynamic Stream Scene Automation
**What it is:** Deep integration with Streamlabs/OBS that goes beyond a static overlay — the tool *controls your stream scenes* automatically based on game events.

**What it does:**
- Auto-switch to "In Game" scene when SC2 match starts
- Auto-switch to "Results" scene when match ends, showing win/loss + opponent build
- Trigger animated alerts in Streamlabs: "CHEESE DETECTED" when proxy is identified
- Auto-update stream title with current MMR and session record (e.g. "Diamond 1 | 4W-2L today")
- Trigger a "GG" overlay animation on game end
- Stream chat bot integration: `!record` shows your session W/L, `!opponent` shows current opponent's stats

**Why it beats the competition:** This turns the app into a full streaming production tool, not just a stats tracker. Streamers will love this — it's a unique category entirely.

---

## 7. 🎯 Build Order Drill Mode
**What it is:** An interactive build order trainer that teaches and tests you on SC2 build orders in real time, like a rhythm game meets a coaching tool.

**What it does:**
- Choose a build from the library (e.g. "Reaper FE into Bio")
- The trainer plays a metronome and shows you the next action: "Build Supply Depot — now" at the exact game second
- After a practice replay, import it and see how your timing compared to the ideal: "Supply Depot: 0:17 actual vs 0:15 target — 2 seconds late"
- Tracks improvement over multiple practice sessions
- Community leaderboard: fastest/most accurate execution of each build among all users
- "You've improved your Reaper FE opening timing by 4 seconds over the last 10 practice games"

**Why it beats the competition:** sc2replaystats shows you what builds are played — this actually *teaches* you to execute them. It's a training tool, not just analytics.

---

## 8. 🌐 Community Meta Snapshot (Ladder Intel)
**What it is:** Aggregated (anonymized) data from all app users showing what builds are being played in your MMR bracket *right now* — a live ladder meta report.

**What it shows:**
- "This week in Diamond 1 ZvT: 41% Roach-Ravager timing, 28% Ling-Bane-Muta, 18% Fast Muta"
- Build frequency trends over time: "Banshee cloak openings are up 12% this month"
- Win rate by build at your MMR: "Ling-Bane-Muta has a 58% win rate at your MMR bracket this week"
- "The meta is shifting — Hydra-Lurker is seeing a resurgence in the top 200"
- Map-specific meta: what's being played on each map at your level

**Why it beats the competition:** This is live ladder intelligence nobody else provides. Instead of just reviewing your own games, you understand what the whole ladder is doing and can prepare accordingly.

---

## 9. 📈 MMR Trajectory & Session Analytics
**What it is:** A smart session tracker that goes beyond just win/loss — tracks your performance arc across a session and over time with predictive MMR modeling.

**What it shows:**
- Session performance graph: MMR gained/lost over the current play session with trend line
- "Tilt detector": flags when your macro score drops after consecutive losses (you may be tilting)
- Optimal session length analysis: "Your win rate drops from 58% to 34% after 2 hours — you play better in shorter sessions"
- Time-of-day performance: "You win 64% of games between 7-9pm, only 41% after 11pm"
- MMR prediction: "At your current 7-day trajectory you'll hit Masters in ~18 days"
- "Stop/Continue" recommendation: "You're 0-3 in the last 30 minutes — your macro score is down 22%. Consider taking a break."

**Why it beats the competition:** This is performance psychology built into a stat tracker. It helps players understand not just what they're doing but *when* and *how* they perform best.

---

## 10. 🤖 AI Replay Summary & Natural Language Q&A
**What it is:** After each game, generate a plain-English summary of what happened and why you won or lost — and let you ask questions about your replays in natural language.

**What it does:**
- Auto-generated post-game summary: "You opened Reaper FE and expanded safely. Your opponent went 1-1-1 Banshee — you didn't have detection up in time and lost 9 SCVs. You recovered with a Marine push but your bio timing was 40 seconds slower than your average, allowing them to take a 3rd base."
- Ask questions: "Why do I keep losing to Banshee openings?" → pulls patterns from all your relevant games
- "What should I have done differently in my last game?" → specific, replay-grounded suggestions
- "Show me my best game this week" → surfaces the replay where your macro score and execution were highest
- Highlight reel generation: clips the top 3 moments from each session (biggest army value swing, fastest expand, biggest mistake)

**Why it beats the competition:** This is the killer feature. It makes the app accessible to players who don't know how to read replay data — they just ask it questions. Nobody else has this. It turns raw stats into a conversation.

---

## Priority Order (Recommended Build Sequence)

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| 1 | Pre-Game Opponent Dossier | Medium | Very High |
| 2 | Personal Weakness Report | Medium | Very High |
| 3 | Map-Specific Performance | Low | High |
| 4 | MMR Trajectory & Session Analytics | Medium | High |
| 5 | Rival & Player Tracker | Low | High |
| 6 | Dynamic Stream Scene Automation | Medium | High |
| 7 | Build Order Drill Mode | High | High |
| 8 | Community Meta Snapshot | High | Very High |
| 9 | Real-Time AI Coaching Voice Alerts | High | Very High |
| 10 | AI Replay Summary & NL Q&A | Very High | Highest |

Start with 1-5 — they're built on data you already have. Features 6-10 require new infrastructure but are the ones that create an unbridgeable gap vs the competition.
