# SC2 Tools — Master Roadmap & Prompt Pack

**One unified production-grade roadmap** that merges:
- `FEATURE_ROADMAP.md` (Phases 1-4: Local intelligence → Streamer → Cloud → Mobile)
- `FeatureUpdatesRoadmapPrompts.md` (analyzer SPA chart upgrades)
- `Fullroadmapprompts.md` (production-readiness, fixes, onboarding, distribution)
- `BUILDORDERADDER.MD` (custom build editor with **shared community database**)

This document is built so you can execute it top-to-bottom. Every prompt is self-contained, references real files in this repo, has a Definition of Done, and assumes you have completed the prompts above it. Each prompt should be pasted into a fresh `claude-code` session.

> **Hard rule** — ALL DATA IS REAL. No mock values, no fake timestamps, no synthetic samples in any code path that ships. If a stat can't be computed from the user's actual replays, render `—` with a tooltip explaining why.

---

## Table of contents

- [Master Architecture Preamble (paste at top of every prompt)](#master-architecture-preamble)
- [Stage 0 — Critical fixes (½ day)](#stage-0--critical-fixes)
- [Stage 1 — Design system + design tokens (1 day)](#stage-1--design-system)
- [Stage 2 — Configuration, profile, onboarding wizard (3-4 days)](#stage-2--configuration-and-onboarding)
- [Stage 3 — Architecture cleanup (1-2 days)](#stage-3--architecture-cleanup)
- [Stage 4 — Diagnostics & reliability (2 days)](#stage-4--diagnostics-and-reliability)
- [Stage 5 — Quick-win analyzer charts (1 day each)](#stage-5--quick-win-analyzer-charts)
- [Stage 6 — Race-aware macro intelligence (3-4 days each)](#stage-6--race-aware-macro-intelligence)
- [Stage 7 — Build classifier + custom build editor with shared DB (1 week)](#stage-7--build-classifier-and-custom-build-editor)
- [Stage 8 — Build order library content (Phase 7 of legacy roadmap)](#stage-8--build-order-library)
- [Stage 9 — Local intelligence features (2-3 weeks)](#stage-9--local-intelligence-features)
- [Stage 10 — Bigger reach charts (1+ week each)](#stage-10--bigger-reach-charts)
- [Stage 11 — Quality / testing (ongoing)](#stage-11--quality-and-testing)
- [Stage 12 — Distribution: installer + auto-update (3-4 days)](#stage-12--distribution)
- [Stage 13 — Streamer expansion: Twitch + Chaos Mode (~2 weeks)](#stage-13--streamer-expansion)
- [Stage 14 — SC2 Tools Cloud (4-6 weeks)](#stage-14--sc2-tools-cloud)
- [Stage 15 — Mobile companion (3-4 weeks)](#stage-15--mobile-companion)
- [Appendix A — Cost estimate](#appendix-a--cost-estimate)
- [Appendix B — Privacy & compliance checklist](#appendix-b--privacy-and-compliance-checklist)
- [Appendix C — Launch checklist](#appendix-c--launch-checklist)
- [Appendix D — Suggested ship rhythm](#appendix-d--suggested-ship-rhythm)

---

## Master Architecture Preamble

> Paste this at the top of EVERY prompt below. It is the single source of context for Claude.

```
PROJECT CONTEXT — read first, do not skip.

Repo: ReSpOnSeSC2/sc2tools. Two coupled apps share data and parsers:

UI surfaces:
- React SPA (single-file, no build step):
    reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html
    Uses React 18 + Tailwind via CDN. Components are inline.
- Express backend:
    reveal-sc2-opponent-main/stream-overlay-backend/{index.js,analyzer.js}
    Routes mounted at /api/* and /games/:id/*.
- Desktop GUI (being deprecated, replaced by a launcher in Stage 3):
    SC2Replay-Analyzer/SC2ReplayAnalyzer.py
    SC2Replay-Analyzer/ui/app.py
- Stream overlay (OBS / Streamlabs Browser Source):
    reveal-sc2-opponent-main/SC2-Overlay/ + widgets/

Replay parsing:
- SC2Replay-Analyzer/scripts/macro_cli.py (called by Express)
- SC2Replay-Analyzer/scripts/buildorder_cli.py
- SC2Replay-Analyzer/core/event_extractor.py (sc2reader-based; chrono fix at c728ab0)
- SC2Replay-Analyzer/analytics/macro_score.py (SQ-based macro engine)

Data files (under data/):
- meta_database.json — keyed by build name, with games[] per build
- MyOpponentHistory.json — keyed by SC2Pulse character id
- build_definitions.json — opening signatures per matchup (built-ins)
- custom_builds.json — user-authored builds (will be cloud-synced in Stage 7)
- profile.json — created by the wizard (Stage 2)
- config.json — created by the wizard (Stage 2)

Production install: C:\SC2TOOLS\ — the user runs from here.
Worktree for dev: C:\SC2TOOLS\.claude\worktrees\<name>\

User environment:
- Windows 11
- Python 3.12, sc2reader 1.8.0
- Node 22.x, npm
- Replay folder for smoke tests:
    C:\Users\jay19\OneDrive\Pictures\Documents\StarCraft II\Accounts\
      50983875\1-S2-1-267727\Replays\Multiplayer\*.SC2Replay
- The user's character_id: 1-S2-1-267727
- The user's account_id: 50983875
- The user's preferred race: Protoss (configurable)

Hard rules:
1. ALL DATA IS REAL. No mock values, no fake timestamps, no synthetic samples
   in any code path that ships. If a stat can't be computed from the user's
   actual replays, render "—" with a tooltip explaining why. Tests may use
   real fixture replays from tests/fixtures/replays/ once Stage 11 ships.
2. Don't break the chrono fix (commits c728ab0, 4107efd). The macro engine
   uses ability_link 722 for builds < 93272 and 723 for >= 93272, with
   chained CommandManagerStateEvent counting bound to the LAST macro
   CommandEvent.
3. Match the existing dark-theme UI. Once Stage 1 lands, every new file
   pulls from design-tokens.css / design_tokens.py — no hard-coded colors.
4. Atomic file writes for any data/* mutation: write to .tmp, fsync, rename.
   Pattern lives in stream-overlay-backend/analyzer.js (persistMetaDb).
5. Never log PII at INFO level (opponent names, battle tags, push tokens,
   refresh tokens). Hash or redact.
6. The user is NOT a developer; UX must work without docs. Wizard, settings
   page, diagnostics page, and installer are all front-and-center.
7. Custom builds save to a SHARED COMMUNITY DATABASE — when one player
   adds a build, every player sees it on next sync. Local copy is a cache;
   server is canonical. (See Stage 7.)

Engineering standards (non-negotiable; CI enforces these):
- File size: target 200-400 lines, hard cap 800. If your change pushes a
  file past 800, split it before continuing. (Single-file SPA index.html
  is the only exception — its inline components still respect the
  function/class caps below; extract to public/analyzer/components/ when
  a logical unit grows past ~400 lines.)
- Function size: target ≤ 30 lines, hard cap 60.
- Class size: single responsibility, ≤ 200 lines or 7 public methods.
- Cyclomatic complexity: ≤ 10 per function (radon for Python,
  eslint-plugin-complexity for JS/TS).
- Nesting depth: ≤ 3 levels. Use early returns / extracted helpers.
- Function args: ≤ 4 (use a dataclass/object beyond that).
- Line length: 100 chars (120 hard cap).
- No magic numbers/strings — extract to named constants.
- Naming: snake_case (Python vars/files), camelCase (JS/TS vars),
  PascalCase (classes), UPPER_SNAKE_CASE (constants), kebab-case (JS files
  except React components). Booleans start with is_/has_/can_/should_.
  No single letters except loop indices and well-known math.
- Type safety: Python type hints on every public function, mypy --strict
  in CI; TypeScript strict mode, no `any`, no unjustified `as` casts;
  JSDoc for plain JS validated by tsc --checkJs.
- Error handling: never swallow exceptions silently; catch the narrowest
  type that applies; structured-field logging (no string concatenation);
  wrap third-party errors at module boundaries.
- Testing: unit test every public function; integration test every
  endpoint; real fixtures over mocks; TDD for bug fixes (failing test
  first); coverage ≥ 80% Python, ≥ 70% JS in CI.
- Documentation: docstring with Example: on every public function/class;
  top-of-file purpose comment per module; README per package; ADR for any
  non-trivial decision under docs/adr/; no commented-out code.
- Linting: ruff (check + format), eslint, prettier, stylelint, mypy,
  tsc --noEmit. Pre-commit hooks installed; CI rejects lint errors.
- Git: one concern per PR; conventional commits (feat: / fix: / refactor:
  / test: / docs: / chore: / perf: / style:); PR template with
  what/why/how-tested/screenshots/migration/rollback; squash-merge on main.
- Security: validate every HTTP input server-side (ajv / pydantic);
  parameterized queries only — never string-interpolated SQL; secrets via
  env vars never source; atomic file writes (write→fsync→rename); never
  log PII (hash/redact); subprocess calls use list args, never
  shell=True with user input; rate-limit every public endpoint;
  HMAC-sign cross-service requests.
- Performance: cache hot reads (default 5min TTL); async/streaming for
  >500ms operations; no N+1 queries; profile before optimizing; paginate
  at 100 rows; timeouts on every outbound HTTP (5s connect, 30s read).
- Observability: structured JSON logging (python-json-logger / pino);
  log levels DEBUG / INFO / WARN / ERROR / CRITICAL with documented
  meanings; per-endpoint counter + duration histogram; OTel tracing in
  Stage 14+; Sentry for exceptions.
- Refactoring: Boy Scout Rule (leave it cleaner); incremental refactors
  only — never a "big rewrite" PR; tests added BEFORE refactoring;
  deprecation cycles for public-API changes (add new → mark old
  deprecated → migrate callers → remove one minor version later).
- Dependencies: pin every dep exactly (==), commit lockfiles, weekly
  audit blocks high/critical findings, prefer one solid library over
  five micro-deps.
- Accessibility (UI work): WCAG AA contrast (4.5:1 body, 3:1 large);
  full keyboard nav with focus-visible ring; aria-label on icon-only
  buttons; respect prefers-reduced-motion; aria-live for async updates;
  every form field has a real <label htmlFor>.
- Production-readiness Definition of Done (every Stage):
    [ ] All Stage Definition-of-Done items met.
    [ ] No file > 800 lines, no function > 60 lines, no complexity > 10.
    [ ] ruff / mypy --strict / eslint / tsc --noEmit clean.
    [ ] Coverage gates pass.
    [ ] Manual smoke test on real data documented in PR.
    [ ] No new TODO/FIXME/HACK without a ticket reference.
    [ ] Logs grep clean of PII.
    [ ] Screenshots committed for UI changes.
    [ ] CHANGELOG.md updated.
    [ ] Migrations tested forward AND backward on a copy of prod data.
    [ ] Rollback plan documented in PR.

File-write protocol: Treat the Edit and Write tools as unreliable for any file with CRLF line endings or more than a few hundred lines. For any edit to an existing file in this repo: (1) make the change via the workspace bash sandbox using python3 with a read→modify→atomic-rename pattern, not the Edit/Write tools; (2) immediately after every write, verify the file is intact using wc -l, tail, and a parser check (python3 -m py_compile for .py, python3 -c "import json; json.load(...)" for .json, node --check for .js, or just tail -3 file | grep -q '<expected closing token>'). If any check fails, restore the file from git show HEAD:<path> before continuing. Do not trust what the Read tool shows you — it caches and can return phantom content that doesn't exist on disk. The workspace bash mount is the canonical view.

Pre-edit checkpoint: Before modifying any file > 200 lines, confirm it's clean in git (no uncommitted changes you'd lose). After each modification, run git diff <path> and confirm the diff matches what you intended — both in content and in size. If the diff shows lines being removed that you didn't ask to be removed, the write got truncated.


No-Edit zone: The Edit tool's old_string/new_string mode is forbidden for files > 1000 lines. Use bash + sed, or read the relevant section, do the transformation, and write back the whole file via bash heredoc.

For the long-form rationale, audit prompt, and one-time enforcement
scaffolding setup, see the "Engineering Standards & Refactoring Practices"
section directly below this preamble in MASTER_ROADMAP.md.
```
---

---


## Stage 8 — Build order library

**Why now:** the classifier branches and editor ship, but content is sparse. This stage seeds 15-20 strong meta builds per matchup so the classifier returns useful results out of the box.

**Duration:** 1 matchup per week, ongoing.

### Stage 8.template — `<MATCHUP>` build library

Repeat 9 times for: TvT, TvZ, TvP, ZvT, ZvZ, ZvP, PvT, PvZ, PvP.

```
Read [Master Architecture Preamble]. 

GOAL: Add 15-20 strong, current-meta build definitions for the TvT, TvZ and ZvZ
matchups to data/build_definitions.json. Each definition is a real build
played by pros in 2026, with verifiable signatures.

SOURCES (use real ones; don't invent):
- Spawning Tool: https://lotv.spawningtool.com/build/<MATCHUP_LOWER>/
  Filter by "professional" / "ranked Grandmaster".
- Liquipedia: liquipedia.net/starcraft2/<RACE>_vs_<RACE> (current meta).
- Recent tournaments: GSL Code S 2026 Season 1, IEM Katowice 2026,
  ESL EWC 2026.
- For TvX: Maru, Clem, herO are reference players.
- For ZvX: Reynor, Serral, Dark.
- For PvX: Zest, Classic, Trap.

WHAT EACH DEFINITION NEEDS (data/build_definitions.json):
{
  "id": "<matchup-lowercase>-<short-name-kebab>",
  "name": "Reaper Expand → 3 Rax Bio",
  "race": "Terran",
  "vs_race": "Zerg",
  "rank" GM
  "added": "2026-04-XX",
  "added_from": "spawningtool.com/build/...",
  "signature": [use the same signature logic we have already implemented in the save my build order, in fact thats a good template for how to create the build orders.
    ...
  ],
  "description": "Standard 2026 TvZ reaper expand. Reaper at ~1:30 scouts
                  and harasses; orbital at 1:00; natural at 2:00; bio
                  production with stim research starts at 3:00.",
  "win_conditions": [
    "Pull off 1-2 reaper harass runs without losing the reaper",
    "Hit a 4 medivac timing at ~7:30"
  ],
  "loses_to": [
    "zvt-12-pool-allin",
    "zvt-roach-rush"
  ],
  "transitions_into": ["tvz-3-base-bio", "tvz-mech-from-bio"]
}

PROCESS (one build at a time):
1. Pick the build.
2. Find a real recent replay that exemplifies it. Cite the URL.
3. Use extract_events to extract its event timeline.
4. Cherry-pick 8-15 timing-defining events for the signature.
5. Look up "loses_to" and "transitions_into" from existing definitions.

FILES:
- data/build_definitions.json — append (don't overwrite existing)
- data/build_definitions.schema.json (write once, reuse for all matchups)
- A new section in docs/build-library.md with the full list, sources, notes.

CONSTRAINTS:

- ALL timing values must come from actual replays, not estimated. If you
  can't find a real reference replay, omit the build.
- ID kebab-case must be unique across the whole file.

VERIFY:
1. python -c "import json; d=json.load(open('data/build_definitions.json'));
   m=[k for k,v in d.items() if v.get('race')=='<RACE>' and v.get('vs_race')=='<VS>'];
   print(len(m), 'builds in <MATCHUP>')"
   Should print >= 8.
2. Each new entry validates against the schema.
3. Run the classifier on 50 real <MATCHUP> replays. >= 60% should match
   a non-"Unclassified" build.

NO INVENTED BUILDS. If you can't substantiate a build with a real-replay
citation, leave it out. Curation > coverage.
```

### Stage 8 acceptance criteria

- [ ] Each of the 9 matchups has ≥ 8 verified builds with citations.
- [ ] Schema validation passes for every entry.
- [ ] Classifier hit rate ≥ 60% on a 50-replay sample per matchup.

---

## Stage 9 — Local intelligence features

**Why now:** the analyzer is rich, the classifier is comprehensive, the configuration system is solid. Time for the three "smart" local features that turn this into a real coach.

**Duration:** 2-3 weeks total.

### Stage 9 — Feature 1: Opening Predictor

> Before scouting, surface "78% chance of 4-Gate based on his last 23 PvP games on this map."

#### File inventory

Existing files to read first:
- `reveal-sc2-opponent-main/analytics/opponent_profiler.py`
- `reveal-sc2-opponent-main/core/sc2_replay_parser.py`
- `reveal-sc2-opponent-main/core/data_store.py`
- `reveal-sc2-opponent-main/watchers/replay_watcher.py`
- `reveal-sc2-opponent-main/stream-overlay-backend/index.js` (overlay event envelope)
- `reveal-sc2-opponent-main/SC2-Overlay/widgets/scouting.html` (similar pre-game widget)
- `reveal-sc2-opponent-main/SC2-Overlay/app.js`
- `reveal-sc2-opponent-main/data/build_definitions.json`

New files:
- `reveal-sc2-opponent-main/analytics/opening_predictor.py`
- `reveal-sc2-opponent-main/analytics/tests/test_opening_predictor.py`
- `reveal-sc2-opponent-main/scripts/train_opening_predictor.py`
- `reveal-sc2-opponent-main/data/predictor_models/.gitkeep`
- `reveal-sc2-opponent-main/SC2-Overlay/widgets/opening-predictor.html`
- `reveal-sc2-opponent-main/SC2-Overlay/widgets/opening-predictor.css`
- `reveal-sc2-opponent-main/SC2-Overlay/widgets/opening-predictor.js`

#### Stage 9.1.1 — Build the predictor module

```
Read [Master Architecture Preamble]. Stages 0-8 must be complete.

Build a per-opponent opening predictor for SC2 Tools.

Read first to understand the data:
- reveal-sc2-opponent-main/analytics/opponent_profiler.py
- reveal-sc2-opponent-main/core/data_store.py (MyOpponentHistory.json schema:
  opponent_name -> { games: [{ strategy, race, map, result, date,
  build_log, ...}], aggregates }
- reveal-sc2-opponent-main/data/build_definitions.json (canonical strategy
  names — this is the prediction label space)

Create reveal-sc2-opponent-main/analytics/opening_predictor.py with:

1. A class OpeningPredictor with these methods:

   - __init__(self, model_dir: Path, min_samples: int = 5)
       Loads pickled per-matchup models. Falls back to the global prior
       for low-data cases.

   - predict(self, opponent_name: str, matchup: str, map_name: str,
             history: dict) -> PredictionResult
       Returns top-N strategy predictions with calibrated probabilities.
       PredictionResult dataclass:
         { opponent_name, matchup, map_name, sample_size,
           is_high_confidence, predictions: [{strategy, probability, rank},
           ... up to 5], fallback_reason }

   - train(self, dataset: list[GameRecord], output_dir: Path) -> TrainReport
       Trains one logistic-regression model per matchup. Features:
         (a) opponent's recent strategy distribution (last 10 games)
         (b) opponent's all-time strategy distribution
         (c) map one-hot (top 12 ladder maps)
         (d) season/patch indicator
         (e) day-of-week, hour-of-day (cyclical encoding)
       sklearn.pipeline.Pipeline: ColumnTransformer (StandardScaler +
       OneHotEncoder) -> LogisticRegression(max_iter=1000,
       multi_class='multinomial', class_weight='balanced').
       Calibrate via CalibratedClassifierCV(method='isotonic', cv=5)
       when n_samples >= 100, else 'sigmoid'.
       Save each matchup's pipeline as joblib pickles + metadata.json.
       Skip matchups with fewer than 25 total samples.

   - explain(self, opponent_name, matchup, prediction) -> list[str]
       1-3 short bullets for the UI ("Last seen 4-Gate 3 of last 5 games").
       Pull from history; do not hallucinate.

2. Dataclass PredictionResult and exception InsufficientDataError.
   Python 3.10+ syntax.

3. Logging: stdlib logging, name "sc2tools.opening_predictor". No prints.

4. Type hints + Google-style docstrings everywhere.

5. The module must NOT import GUI or Node code. Pure analytics.

Tests at reveal-sc2-opponent-main/analytics/tests/test_opening_predictor.py:
- prediction with sufficient data returns sorted, calibrated probabilities
  summing to ~1.0
- prediction with no data raises InsufficientDataError
- prediction with low data sets is_high_confidence=False
- training on a synthetic 200-game dataset produces a working model
- explain() returns only facts traceable to history (property test)
- save/load round-trip preserves predictions exactly

Use pytest fixtures and a synthetic data generator. >85% coverage.

Definition of Done:
- File exists, imports cleanly.
- All tests pass.
- mypy --strict passes.
- ruff check passes.
- New deps in requirements.txt: scikit-learn>=1.4, joblib>=1.3.
```

#### Stage 9.1.2 — Training script and model artifacts

```
Read [Master Architecture Preamble]. Stage 9.1.1 must be complete.

Build the offline training pipeline.

Read first:
- The OpeningPredictor class
- reveal-sc2-opponent-main/core/data_store.py
- reveal-sc2-opponent-main/scripts/ (existing CLI patterns)

Create reveal-sc2-opponent-main/scripts/train_opening_predictor.py.

Behavior:
1. CLI args via argparse:
   --history-path PATH       MyOpponentHistory.json (default: auto-detect)
   --meta-path PATH          meta_database.json (default: auto-detect)
   --output-dir PATH         data/predictor_models/ (default)
   --min-matchup-samples INT default 25
   --verbose

2. Loads both files, merges into a unified dataset of GameRecord rows
   (opponent_name, matchup, map_name, strategy, result, timestamp).
   Filters: drop missing strategy/matchup. Dedupe by
   (opponent_name, timestamp, map_name).

3. Calls OpeningPredictor.train(...) and writes models.

4. After training, runs an 80/20 holdout per matchup, prints accuracy@1,
   accuracy@3, log loss, per-class F1. Saves to training_report.json.

5. Exits non-zero on training failure or zero models produced.

6. On success, one-line summary:
   "Trained 6 matchups · 1247 games · acc@1 0.42 acc@3 0.78"

Also create:
- docs/training.md (~150 words): how to retrain, what files are produced,
  troubleshooting.
- README's CLI section updated.

Definition of Done:
- Script runs end-to-end on the user's local data.
- Produces .pkl per matchup + metadata.json + training_report.json.
- Exits non-zero on bad input.
```

#### Stage 9.1.3 — Hook into the replay watcher and Node backend

```
Read [Master Architecture Preamble]. Stages 9.1.1 and 9.1.2 must be complete.

Wire the opening predictor into the live event flow.

Read first:
- reveal-sc2-opponent-main/watchers/replay_watcher.py
- reveal-sc2-opponent-main/stream-overlay-backend/index.js (look for
  overlay_event envelope, /api/replay endpoint, Socket.IO emit pattern)
- The OpeningPredictor module

PYTHON SIDE:
1. After ReplayContext + opponent name + matchup are known, call
   OpeningPredictor.predict(...). Wrap in try/except — overlay must
   never break.
2. POST http://<backend>/api/opening-prediction with:
   { opponent_name, matchup, map_name, sample_size, is_high_confidence,
     predictions: [{strategy, probability, rank}, ...],
     explanation_bullets: [str, str, str] }
3. Cache the predictor instance at module level.

NODE SIDE:
1. POST /api/opening-prediction. Validate body with ajv (same library as
   Stage 2.1).
2. Re-emit on Socket.IO as overlay_event with type "opening_prediction",
   TTL 25s.
3. Persist most recent prediction in memory only.
   GET /api/opening-prediction/latest returns it (or 204).
4. tmi.js Twitch chat command !nextopening — bot replies with top
   prediction, rate-limited 30s/channel.

Tests:
- __tests__/opening_prediction.test.js: happy path POST, 400 validation,
  204 GET no-data, Socket.IO emit on POST.
- Python: requests-mock test verifying POST shape and exception swallowing.

Definition of Done:
- Live game triggers a prediction within 5 seconds of pre-game popup.
- POST endpoint validates input.
- Socket.IO emits with right envelope.
- !nextopening works end-to-end.
- All tests pass.
- No PII leakage beyond the opponent's in-game name.
```

#### Stage 9.1.4 — Build the overlay widget

```
Read [Master Architecture Preamble]. Stage 9.1.3 must be complete.

Build the opening-predictor browser-source overlay widget.

Read first:
- SC2-Overlay/widgets/scouting.html (similar pre-game widget)
- SC2-Overlay/widgets/cheese.html
- SC2-Overlay/app.js (Socket.IO consumer pattern)
- SC2-Overlay/styles.css (Stage 1 design tokens)
- SC2-Overlay/design-tokens.css

Create:
- SC2-Overlay/widgets/opening-predictor.html
- SC2-Overlay/widgets/opening-predictor.css
- SC2-Overlay/widgets/opening-predictor.js

Visual design:
- Card 480x280px, 16px radius.
- Top-left badge: opponent's race icon.
- Header: "Predicted Opening" lg type, secondary color.
- Opponent name xl mono.
- Three horizontal probability bars:
    [icon] Strategy Name ......... [bar fill] 62%
- Bottom strip: "Based on 23 games on this map" xs muted.
- Confidence dot: green ≥10 games, amber 5-9, red <5.
- "Low confidence" pill if !is_high_confidence.
- Animation: card slides up 200ms ease-out, bars fill 0→target over 600ms
  with 80ms stagger.
- Auto-dismiss after 22s.

Behavior:
- Socket.IO subscribe to overlay_event type "opening_prediction".
- Hide unused rows (no empty placeholders).
- Listen for "clear" to dismiss early.
- Pause animations when document.hidden.

Accessibility:
- aria-live="polite".
- Reduced-motion media query disables animations.

Code:
- Vanilla JS, no frameworks, no build step.
- IIFE, no globals. ES2022.
- design tokens (var(--color-...)) only.
- .eslintrc.json at SC2-Overlay/ with eslint:recommended.

Documentation:
- Update SC2-Overlay/widgets/README.md.

Definition of Done:
- Open opening-predictor.html in Chrome with the backend running and a
  fake POST sent via curl — widget appears, animates, dismisses.
- Lighthouse Best Practices ≥ 95.
- No console errors.
- Reduced-motion produces a static, readable widget.
- README updated.
- Visual screenshot at SC2-Overlay/widgets/screenshots/opening-predictor.png.
```

#### Stage 9.1.5 — SPA "Predictions" panel (replaces the legacy Tkinter panel)

```
Read [Master Architecture Preamble]. Stage 9.1.4 must be complete.

Add a "Predictions" tab to the analyzer SPA at
reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html.

Layout (top-to-bottom):

[Top section]
  - Search box: "Look up opponent..." with autocomplete from the history
    file.
  - Dropdown: matchup selector, auto-populated.
  - Dropdown: map selector, auto-populated.
  - "Predict" button.

[Middle section]
  - Results card with the same data as the overlay widget plus:
    - Opponent name, race, sample size, confidence pill
    - Top 5 predictions as horizontal bars
    - Explanation bullets
    - "Recent games against this opponent" expandable table

[Bottom strip]
  - "Last model retrain: 2026-04-22 14:33 (4 days ago)" from
    data/predictor_models/metadata.json
  - "Retrain models" button — POST /api/predictions/retrain (new
    endpoint that subprocesses the training script and streams progress
    via Socket.IO).
  - Status label.

Behavior:
- Predict disabled until all three inputs valid.
- Errors as non-blocking toast.
- Recent games loads lazily after prediction renders.
- Right-click on a prediction copies "Strategy: 4-Gate (62%)" to clipboard.

Style: design tokens. Match the rest of the SPA.

Definition of Done:
- Tab loads without error.
- Search autocompletes < 100ms for histories under 5000 opponents.
- Predict surfaces results within 500ms for cached models.
- Retrain works end-to-end.
- Screenshot saved at docs/screenshots/predictions-panel.png.
```

#### Feature 1 acceptance criteria

- [ ] Open SC2 game vs an opponent with 10+ history → overlay predicts within 5 seconds.
- [ ] Top prediction matches opponent's most-played strategy from `MyOpponentHistory.json`.
- [ ] SPA Predictions tab renders the same data with a richer view.
- [ ] `!nextopening` chat command returns the top 3.
- [ ] Retraining via the script regenerates models with no errors.

---

### Stage 9 — Feature 2: Tilt Detector

> APM volatility, mineral float spikes, dropped accuracy across consecutive losses → soft intervention.

#### Stage 9.2.1 — Build the tilt scoring engine

```
Read [Master Architecture Preamble]. 

Build a tilt detector that combines several behavioral signals into a
single 0-100 tilt score and decides when to nudge the user.

Read first:
- reveal-sc2-opponent-main/analytics/macro_score.py
- reveal-sc2-opponent-main/core/data_store.py
- reveal-sc2-opponent-main/stream-overlay-backend/index.js (session tracking)

Create reveal-sc2-opponent-main/analytics/tilt_detector.py.

Signals (each normalized to 0-1):
  S1. Loss-streak weight: 1 - 0.6^streak; 1 loss=0.40, 2=0.64, 3=0.78,
      4=0.87, capped at 0.95.
  S2. Macro-score collapse: last 3 games avg vs session baseline; 15-pt
      drop=1.0; 0-pt=0.0; linear in between.
  S3. APM volatility: stdev/mean of per-min APM in latest game. ≥0.6=1.0;
      ≤0.2=0.0.
  S4. Mineral-float spikes: fraction of game-minutes above 800 minerals.
      ≥25%=1.0; ≤5%=0.0.
  S5. Inter-game time: <30s=0.6; 30-90s=0.3; 90-300s=0.0; >300s=-0.2
      (cools tilt).
  S6. Hour-of-day: 23-04 +0.15; 18-22 +0.05; otherwise 0.

Composite tilt_score = clamp(0..100, 100 *
   (0.30*S1 + 0.25*S2 + 0.10*S3 + 0.15*S4 + 0.10*S5 + 0.10*S6))

Thresholds (configurable in data/tilt_config.json):
   <35 = "calm"; 35-59 = "warm"; 60-79 = "tilted"; ≥80 = "molten".

Public API:
class TiltDetector:
    def __init__(self, config_path, cooldown_minutes=15)
    def update(self, game, session) -> TiltState
    def should_intervene(self, state) -> bool
    def positive_reframe(self, recent_games) -> list[str]

TiltState dataclass:
    score, level, contributing_signals (S1-S6 raw values),
    streak (negative for losing), cooldown_remaining_seconds, suggested_action

SessionState dataclass:
    games, session_start, last_intervention_at

Pure detector: no I/O, no globals, no logging side effects.

Tests at reveal-sc2-opponent-main/analytics/tests/test_tilt_detector.py:
- 0-loss session → tilt always <35
- 3-loss streak with macro decay → tilt enters "tilted"
- "molten" after 5 losses + macro collapse + late-night
- positive_reframe never invents data (property test)
- cooldown prevents back-to-back interventions
- All thresholds configurable

Definition of Done:
- 90%+ test coverage.
- Config generated on first import if missing.
- Module importable from the SPA's backend (analyzer.js spawns it).
- README mentions the new feature.
```

#### Stage 9.2.2 — Wire tilt into the live event flow

```
Read [Master Architecture Preamble]. Stage 9.2.1 must be complete.

Hook the tilt detector into post-game flow and expose state to the overlay.

Read first:
- The TiltDetector module
- replay_watcher.py and watchers/replay_watcher.py
- stream-overlay-backend/index.js (match-result event handling, session.state.json)

PYTHON SIDE:
1. Maintain a SessionState in memory (singleton). Reset on fresh start
   or after >4h inactivity.
2. After each game, call TiltDetector.update(game, session_state).
3. POST result to backend:
   POST /api/tilt-status with {
     score, level, streak, contributing_signals, should_intervene,
     suggested_action,
     positive_reframe: [str, str, str]   // only if intervening
   }
4. Persist SessionState to data/.session_state.json (gitignored). Survives
   crashes.

NODE SIDE:
1. POST /api/tilt-status — validate, store in memory + extend
   session.state.json with a tilt section (back-compat).
2. Always emit overlay_event of type "tilt_status".
3. When should_intervene is true, emit "tilt_intervention" with TTL 25s.
4. GET /api/tilt-status — returns latest (or 204).
5. !tilt chat command — replies with current level word only ("@user calm").
   Don't expose numeric score. Rate limit 60s/user.

Tests at __tests__/tilt_status.test.js:
- POST validates schema; 400 on bad input
- GET 204 when no data
- Socket.IO emits tilt_status + tilt_intervention
- !tilt rate-limits

Definition of Done:
- End-to-end: play a game, watcher posts status, backend emits, widget
  can subscribe.
- session.state.json schema back-compat.
- Crash + restart preserves session_state.
- Tests pass; chat command works.
```

#### Stage 9.2.3 — Tilt banner overlay widget

```
Read [Master Architecture Preamble]. Stage 9.2.2 must be complete.

Build the tilt-banner browser-source widget. Two modes:

Mode A: Persistent low-key indicator (always visible during a session)
- 8x44 px pill in top-right of source.
- Color reflects tilt level: green→yellow→orange→red. Semantic tokens.
- Just shows current level word; no numeric.
- Subtle pulse only when "tilted" or "molten".

Mode B: Intervention card (when tilt_intervention fires)
- 520x320 px card, slides in from right, sits center-screen 18 seconds,
  slides out.
- Layout:
   Header: "Take a breath?" (lg)
   Body line 1: empathic copy keyed to level
     - tilted: "Three losses in a row. Brain's getting heated."
     - molten: "It's been a rough run. Time for a pause."
   Body line 2: streak + reframe headline
   Three positive_reframe bullets, each with a small race-accent dot
   Footer: [ I'm good ]  [ Take 10 minutes ]
   - "I'm good" dismisses immediately.
   - "Take 10 minutes" starts a countdown ring inside the card and locks
     it. After 10:00, plays a soft chime: "Welcome back. GLHF."

Read first:
- SC2-Overlay/styles.css + design-tokens.css
- SC2-Overlay/widgets/streak.html
- SC2-Overlay/widgets/cheese.html
- SC2-Overlay/app.js
- The tilt-status / tilt-intervention envelopes

Create tilt-banner.html/.css/.js.

Behavior:
- Subscribe to overlay_event types tilt_status and tilt_intervention.
- localStorage persists last tilt_status across reloads.
- Buttons emit POST /api/tilt-action {action: "dismiss"|"break_started"
  |"break_completed"}; backend acks 204.
- Reduced-motion: disable pulse and slide; intervention card fades only.
- Tone: empathic, never clinical. Avoid "tilt" / "tilted" in user-visible
  copy.

Backend: POST /api/tilt-action handler appends to data/tilt_action_log.jsonl
(one JSON line per action with timestamp + action). 204 on success.

Definition of Done:
- Widget renders both modes.
- No console errors.
- Lighthouse Best Practices ≥ 95.
- Buttons fire backend POSTs.
- Backend log accumulates entries.
- Manual stream test: pill changes color, card appears at threshold,
  both buttons work.
- Screenshots saved.
```

#### Stage 9.2.4 — SPA tilt-status pill

```
Read [Master Architecture Preamble]. Stage 9.2.3 must be complete.

Add a tilt-status indicator to the analyzer SPA's main nav bar (now that
Tkinter is gone, the SPA is the desktop UI).

Read first:
- public/analyzer/index.html (Stage 1 tokens)
- The TiltDetector module

Behavior:
1. Small pill in top-right of nav showing current tilt level.
2. Polls /api/tilt-status every 30s while SPA is open. If backend is
   down, falls back to reading .session_state.json via the SPA's
   API proxy (404 → hidden).
3. Hover tooltip: streak + last intervention time.
4. Click opens a popover:
   - "View tilt history" → modal with last 30 game tilt scores as a
     small line chart (use the same SVG charting code from Stage 5).
   - "Reset session" → confirms then clears session state.
   - "Disable tilt detection" → toggles flag in tilt_config.json
     (PATCH /api/config).
5. Pill hidden by default for first-time users; one-time onboarding toast
   explains it after the first detected "warm" event.

Definition of Done:
- Pill appears in nav and updates within 30s of new game.
- Popover works end-to-end.
- Tilt history modal renders without lag for 100+ data points.
- Disabling tilt detection persists across restarts.
```

#### Feature 2 acceptance criteria

- [ ] 3 losses in a row in same session → intervention card appears once.
- [ ] "Take 10 minutes" countdown locks the card and rings on completion.
- [ ] Pill in OBS source matches color in SPA nav.
- [ ] `!tilt` chat command returns level word only.
- [ ] 15-min cooldown prevents repeat interventions.
- [ ] Manual play-through confirms intervention copy reads as supportive.

---

### Stage 9 — Feature 3: Achievement / Badge System

> "Survived 10 cheese opens" unlocks. "Macro Score 85+ ten games in a row." Visible on overlays.

#### Stage 9.3.1 — Declarative badge rule engine

```
Read [Master Architecture Preamble]. Stages 9.1, 9.2 must be complete.

Design and implement a rule-driven achievement system.

Read first:
- reveal-sc2-opponent-main/analytics/opponent_profiler.py
- reveal-sc2-opponent-main/core/data_store.py
- reveal-sc2-opponent-main/analytics/macro_score.py
- reveal-sc2-opponent-main/data/build_definitions.json

Constraints:
- Badges expressed as JSON rules. Engine reads
  data/badges/badge_definitions.json — no Python per badge.
  Adding a new badge is a JSON edit + an SVG drop.
- Engine evaluates after each game. Also supports retroactive evaluation.
- Unlocks append-only. Progress recomputed each game.

Step A: rule DSL.

Badge definition shape:
{
  "id": "cheese_survivor_10",
  "name": "Cheese Survivor",
  "description": "Won 10 games where the opponent opened with cheese.",
  "tier": "silver",                    // bronze|silver|gold|legendary
  "category": "defense",
  "icon": "cheese_survivor.svg",
  "hidden_until_unlocked": false,
  "criteria": {
    "type": "count",                   // count|streak|threshold|composite
    "filter": {
      "result": "win",
      "opponent_strategy_in": ["cannon_rush","12_pool","proxy_barracks",
                               "dt_rush","cheese:*"]
    },
    "target": 10
  },
  "progress_template": "{count}/{target} cheese games survived"
}

Criteria types: count | streak | threshold (last N games all match) |
composite (any/all sub-criteria).

Filter language (JSON-Logic-lite):
- exact match:        "result": "win"
- in list:            "race_in": ["zerg","protoss"]
- numeric compare:    "macro_score__gte": 85
- wildcard string:    "opponent_strategy_in": ["cheese:*"]
- negation:           "not": { ... }

Step B: implement.

Create reveal-sc2-opponent-main/core/achievements.py:

class AchievementEngine:
    def __init__(self, definitions_path, unlock_state_path)
    def evaluate(self, latest_game, history) -> EvaluationResult
    def evaluate_full(self, history) -> list[BadgeUnlock]
    def get_user_badges(self) -> list[BadgeUnlock]
    def get_progress(self) -> list[BadgeProgress]

Persist unlocks to data/.user_badges.json (gitignored). Atomic write.
On every load, validate and migrate forward.

Step C: seed badge_definitions.json with 30 starter badges across
categories — defense, offense, macro, mental, milestone, social.

Examples (full list in the spec):
  cheese_survivor_10 (silver, defense)
  cheese_survivor_50 (gold, defense)
  macro_master (gold, macro): threshold, macro_score >= 85, window 10
  matchup_specialist_zerg (silver, offense): 50 wins as Zerg
  rivalry_won (bronze, social): beat the same opponent 5 times
  rivalry_dominated (gold, social): beat the same opponent 10 times
  early_riser (bronze, social): play between 04:00 and 06:00
  night_owl (bronze, social): play between 02:00 and 04:00
  quick_finisher (bronze, offense): win in under 4:00
  patience_pays (bronze, offense): win in over 25:00
  cheese_master (gold, offense): win 10 games with own cheese
  rage_immunity (legendary, mental): 20 consecutive games without GG-out
  apex_predator (legendary, offense): 20-game win streak
  first_blood (bronze, milestone): first game logged
  century (silver, milestone): 100 games
  millennium (legendary, milestone): 1000 games
  map_explorer (silver, milestone): 15 different maps
  all_three_races (silver, milestone): 1+ win in every matchup
  perfect_macro (legendary, macro): macro_score 95+ for 5 in a row
  cheese_immune (legendary, defense): 5 consecutive cheese-defense wins
  veteran_status (bronze, milestone): account active 30 days
  season_pass (silver, milestone): 100 games in a 30-day window
+ 9 more designed by you across categories/tiers.

Tests at analytics/tests/test_achievements.py:
- evaluate idempotent on already-unlocked
- evaluate_full == sequence of evaluate
- malformed unlock-state → backup + fresh start
- DSL covers all four criteria types and all filter operators
- Wildcard strategy filters resolve against build_definitions.json
- Adding a new badge JSON makes it appear in get_progress()

Definition of Done:
- 90%+ coverage.
- 30 starter badges defined.
- evaluate_full processes 1000 games in under 200ms.
- Atomic writes; survives crash mid-write.
- mypy --strict passes.
```

#### Stage 9.3.2 — Badge artwork

```
Read [Master Architecture Preamble]. Stage 9.3.1 must be complete.

Create the SVG badge artwork. Match the dark space theme from
design-tokens.css.

Style guide:
- 128x128 viewbox.
- Dark inner gradient using surface tokens.
- Rim color matches tier:
   bronze: #B45309
   silver: #94A3B8
   gold:   #F59E0B
   legendary: animated gradient — pre-render as static stops at 30/60/90 deg
              in --color-race-zerg --color-race-terran --color-race-protoss
- Center icon monochrome on rim color, 2px stroke, no fills.
- File names match icon field in badge_definitions.json.

For each of the 30 starter badges, design a center symbol:
  cheese_survivor: shield with a wedge of cheese
  macro_master: bar chart trending up
  rivalry_won: crossed swords
  early_riser: sun with rays
  apex_predator: stylized crown with claws
  perfect_macro: diamond + asterisk
  ...

Constraints:
- Hand-authored or AI-generated then optimized via SVGO.
- Each file under 4KB.
- Shape primitives or cubic bezier — no raster.
- aria-label inside the SVG.

Drop into reveal-sc2-opponent-main/SC2-Overlay/icons/badges/.

Definition of Done:
- All 30 SVGs present, under 4KB.
- Visible at 32px, 64px, 128px without illegibility.
- A montage page SC2-Overlay/icons/badges/preview.html shows all 30.
```

#### Stage 9.3.3 — Wire achievements into the live event flow

```
Read [Master Architecture Preamble]. Stages 9.3.1 and 9.3.2 must be complete.

PYTHON SIDE:
1. After meta_database.json is updated, call
   AchievementEngine.evaluate(latest_game, history).
2. For every newly_unlocked entry, POST /api/badge-unlocked with
   { id, name, tier, description, icon, unlocked_at, category }.
3. Persist unlocks via the engine. On startup, run evaluate_full() once
   to backfill any historical badges.

NODE SIDE:
1. POST /api/badge-unlocked validates and emits overlay_event of type
   "badge_unlocked" with TTL by tier: bronze 6s, silver 8s, gold 10s,
   legendary 14s.
2. GET /api/badges returns all unlocked in order.
3. !badges chat command — bot replies with count and most recent
   ("Response has 14 badges. Latest: Cheese Survivor"). Rate limit 30s.
4. Persist unlock log to data/badge_unlock_log.jsonl.

Backfill safety: never re-emit overlay events for badges unlocked before
the engine started. Track first-evaluation state in the engine.

Tests:
- POST validates; rejects bad input
- Socket.IO emits badge_unlocked
- !badges command works
- Backfill doesn't double-emit

Definition of Done:
- Game that should unlock a badge → overlay fires within 2s of result.
- Replaying old history doesn't re-emit.
- Persistence survives restarts.
```

#### Stage 9.3.4 — Badge toast overlay widget

```
Read [Master Architecture Preamble]. Stage 9.3.3 must be complete.

Build the badge-toast browser-source widget — celebratory unlock animation.

Read first:
- SC2-Overlay/widgets/streak.html
- SC2-Overlay/styles.css + design-tokens.css
- The badge_unlocked envelope

Create badge-toast.html/.css/.js.

Visual design:
- Toast 460x140 px slides up from bottom.
- Layout: SVG badge 100x100 left, text right (UNLOCKED / Cheese Survivor /
  description).
- Background: surface elevated, border 1px tier color.
- Header word "UNLOCKED" xs caps mono tier color.
- Badge name lg type primary.
- Description sm secondary.

Tier flair:
- bronze: subtle glow
- silver: glow + 1 confetti burst (8 particles)
- gold: glow + confetti (16) + Web Audio soft ding -18 dBFS
- legendary: full-screen briefly tints background, particle storm (40),
  rising chord, slow-rotating shine pass

Display duration scales with tier (TTL from backend).

Audio:
- Web Audio API only; synthesize tones with oscillators.
- ≤ -18 dBFS.
- Query-param mute=1 silences.

Reduced-motion: skip confetti, cross-fade only.

Behavior:
- Subscribe to "badge_unlocked".
- Queue rapid unlocks (one at a time).
- Idempotent: same id arriving twice → ignore.

Definition of Done:
- Manual test all four tiers.
- Lighthouse Best Practices ≥ 95.
- Reduced-motion + mute=1 work.
- README updated. Screenshots saved.
```

#### Stage 9.3.5 — SPA Trophies tab

```
Read [Master Architecture Preamble]. Stage 9.3.4 must be complete.

Add a "Trophies" tab to the analyzer SPA.

Read first:
- The AchievementEngine
- public/analyzer/index.html
- design-tokens

Layout:
[Top stats strip]
  Unlocked: 14 / 30   |   Bronze 8 · Silver 4 · Gold 2 · Legendary 0
  Progress: ▓▓▓▓▓▓▓▓░░░░░░░░  47%

[Filter bar]
  All | Defense | Offense | Macro | Mental | Milestone | Social
  + show locked toggle

[Gallery grid]
  Each cell 160x190, badge SVG + tier border + name + status.
  - Unlocked: full color, "Unlocked Apr 12, 2026"
  - Locked-with-progress: greyscale, progress bar, "{current}/{target}"
  - Locked-hidden: silhouette, "??? - keep playing to unlock"

[Selection panel]
  Click a cell → right panel:
  - Larger badge
  - Full description
  - Unlock date / progress
  - "Recent games contributing" expandable list

Behavior:
- Lazy render (visible + 1 viewport buffer).
- Window resize re-flows.
- Right-click → "Copy link" (placeholder URL until Stage 14 cloud-backs it).

Definition of Done:
- Tab loads in < 200ms with 30 badges.
- Window resize doesn't lag.
- Screenshot saved.
```

#### Feature 3 acceptance criteria

- [ ] Game satisfying a badge → toast appears with correct tier flair.
- [ ] SPA Trophies tab shows 30 badges with correct lock state.
- [ ] `!badges` works.
- [ ] Backfill on first run unlocks historical silently (no overlay spam).
- [ ] Adding a new badge JSON + SVG appears in the SPA without code changes.
- [ ] Audio respects mute query param.

---

## Stage 10 — Bigger reach charts

**Why now:** these are the big visual splashes that the analyzer becomes famous for. They each require new endpoints, new CLIs, and richer SPA components. Scheduling them after Stage 9 means they ride on a complete data pipeline.

**Duration:** 1+ week each.

### Stage 10.1 — Engagement detector + "fight value" log

```
Read [Master Architecture Preamble]. Stages 0-9 must be complete.

Build an "Engagements" tab in the per-game drawer in the analyzer SPA.

Backend: new module SC2Replay-Analyzer/analytics/engagements.py. Walk
replay.tracker_events for SUnitDiedEvent clusters: deaths within 10
seconds AND 12 in-game-distance units of each other belong to the same
engagement. For each engagement, compute:
 - start_time, end_time, center_x, center_y
 - per-side: minerals_lost, vespene_lost, supply_lost
 - the unit composition that died on each side
 - a "winner" heuristic (the side with less value lost)

Surface as a new /games/:id/engagements endpoint in
reveal-sc2-opponent-main/stream-overlay-backend/analyzer.js, spawning a new
scripts/engagements_cli.py. Cache result on the game record like
macro_breakdown.

UI: vertical timeline list, each engagement as a card with timestamp,
mini-map dot for location, both sides' losses (icons + values), winner
badge. Click → scroll the build-order timeline to that moment.

Use unit-cost data from SC2Replay-Analyzer/core/sc2_catalog.py. Don't
fabricate composition: if sc2reader couldn't resolve a unit_type, omit it
rather than guessing.

Use design tokens from Stage 1.
```

### Stage 10.2 — Win probability curve

```
Read [Master Architecture Preamble]. Stages 0-9 must be complete.

Build a win probability curve for each game.

Train a model in SC2Replay-Analyzer/analytics/win_prob.py using gradient
boosting (scikit-learn or XGBoost — already in requirements.txt).
Features at each time sample: army value diff, worker count diff, base
count diff, tech diff, upgrade tier diff, current resource bank diff.
Label = the player who won. Train on games already in
data/meta_database.json (use result == 'Win' and per-game stats_events).
Save model to data/win_prob_model.pkl.

Inference: given a replay, run the model on each stats_events sample and
produce a [{time, my_win_prob}] curve.

New /games/:id/win-prob endpoint, new scripts/winprob_cli.py.

UI: smoothed line chart, x = time, y = win prob 0-100%, overlaid with a
50% midline and shaded above/below. Place at the very top of the macro
breakdown drawer above the existing chart.

Critical: this is a real model trained on real data. Do NOT mock the curve
with a sigmoid or hand-tuned heuristic. If the model file doesn't exist,
the endpoint returns 503 with "Model not yet trained — run
scripts/winprob_cli.py train".
```

### Stage 10.3 — Map heatmap of player camera + army positions

```
Read [Master Architecture Preamble]. Stages 0-9 must be complete.

Build a "Heatmap" tab in the per-game drawer.

Backend: new scripts/heatmap_cli.py. Walk replay.events for
SCameraUpdateEvent positions per player; walk replay.tracker_events for
SUnitPositionsEvent for combat units (filter via core.sc2_catalog.py).
Bucket positions into a 64x64 grid covering the map's playable bounds
(already in data/map_bounds.json), return per-player density grids.

Endpoint /games/:id/heatmap, cached.

UI: render the map background image (already at images/maps/large/<map>.jpg
in the Express static directory), overlay two heatmaps with player colors
at 0.5 opacity. Toggle buttons: "Camera", "Army units", "Both" per player.
Hover shows density value.

Real positions only — if the map background doesn't exist for a replay's
map, render the heatmap on a plain dark grid and surface "Map background
unavailable" instead of using a stand-in image.
```

### Stage 10.4 — Per-game replay scrubber

```
Read [Master Architecture Preamble]. Stages 0-9 must be complete.

Build a scrubbable replay viewer in the analyzer SPA.

Backend: extend SC2Replay-Analyzer/core/event_extractor.py to optionally
produce a per-second "snapshot stream" — at every second of the game, the
set of alive units + completed buildings + completed upgrades for each
player. Cache snapshots at 1Hz (cheap to compute from existing tracker
events).

Endpoint /games/:id/snapshots returning [{t, p1: {units: {name: count},
buildings: {name: count}, upgrades: [name]}, p2: {...}}, ...].

UI: time slider at the top of a new "Replay" tab in the per-game drawer.
As the user drags, render the player-state for that timestamp as icon
grids (reuse the existing units/buildings/upgrades icon registry
SC2-Overlay/icon-registry.js). Show a tooltip on hover for each icon
with name + count.

Bonus: play/pause button that auto-advances at 4x real speed.

Real data only.
```

### Stage 10 acceptance criteria

- [ ] Engagements tab lists real fights with mineral/supply losses.
- [ ] Win probability curve renders only when model exists; otherwise 503.
- [ ] Heatmap overlays real position density on real map images.
- [ ] Replay scrubber dragging shows real per-second player state.

---

## Stage 11 — Quality and testing

**Why now:** before distribution. A robust test fixture library + macro engine + Express endpoint coverage makes Stages 12-15 sustainable.

**Duration:** 1-2 weeks, ongoing.

### Stage 11.1 — Test fixtures library

```
Read [Master Architecture Preamble]. Stages 0-10 must be complete.

GOAL: A repo of 25-30 real (anonymized) .SC2Replay files covering every
matchup, replay version, and edge case. Becomes the input for all later
test suites.

FIXTURES TO COLLECT (one of each, minimum):
- Each matchup: PvP, PvT, PvZ, ZvT, ZvZ, ZvP, TvT, TvZ, TvP (9 replays)
- Each replay version: 80949 (LotV pre-balance), 89720 (mid-2023),
  92028 (late 2023), 95299 (5.0.14 boundary), 96883 (current,
  chrono-link-shifted regime). 5 minimum.
- Each game length: <5 min (rush), 5-15 min (standard), 15-30 min
  (long macro), 30+ min (epic). 4 replays.
- Edge cases: corrupted file, custom mode (not 1v1), 2v2 team, observer
  POV, DC'd game, game where one player left at 0:00. 6 replays.

FILES:
- tests/fixtures/replays/<descriptive-name>.SC2Replay
- tests/fixtures/replays/MANIFEST.json with per-replay metadata:
    { filename, build, race1, race2, length_sec, expected_winner,
      expected_macro_score_range, source, notes }

ANONYMIZATION:
- Replays should be from the user's own library OR public pro replays.
  NEVER include random users' replays without consent.
- Document source in MANIFEST.notes.

VERIFY:
1. ls tests/fixtures/replays/*.SC2Replay | wc -l → ≥ 25
2. python tests/fixtures/validate_manifest.py — script (you'll create)
   that loads each fixture with sc2reader and asserts MANIFEST values.

NO SYNTHETIC REPLAYS. They must be real .SC2Replay files; otherwise
sc2reader behavior in tests doesn't match production.
```

### Stage 11.2 — Macro engine unit tests

```
Read [Master Architecture Preamble]. Stage 11.1 must be complete.

Pytest suite for SC2Replay-Analyzer/analytics/macro_score.py and
SC2Replay-Analyzer/core/event_extractor.py with strong coverage.

FILES TO CREATE:
- SC2Replay-Analyzer/tests/test_event_extractor.py
- SC2Replay-Analyzer/tests/test_macro_score.py
- SC2Replay-Analyzer/tests/test_chrono_chain_counting.py (regression)

TESTS:
1. test_event_extractor:
   - For each fixture, extract_macro_events returns expected ability_counts
     (per MANIFEST).
   - Chrono-link cutoff at build 93272 fires correctly (722 vs 723).
   - Random Vs games extract events for both players consistently.
   - Corrupted replay returns a partial bundle, no exception.

2. test_macro_score:
   - SQ formula on a known stats_events list returns expected value.
   - Each penalty bounded (≤ MAX_PENALTY).
   - Final score clamped 0..100.
   - Race=Random not handled at this layer (profile-level).

3. test_chrono_chain_counting:
   - Synthetic event list (in-memory):
     1 SCmdEvent at link 723 followed by 5 CommandManagerStateEvent(state=1)
     → ability_counts.chrono == 6
   - Same with non-chrono events between: state events bind to LAST macro
     CommandEvent, not random other CommandEvents.

CONFIG:
- pytest.ini at SC2Replay-Analyzer/pytest.ini.
- Coverage: pytest-cov, target ≥ 80%.

VERIFY:
1. cd SC2Replay-Analyzer && pytest tests/ -v — all pass; coverage ≥ 80%.
2. CI: add to .github/workflows/test.yml.

NO MOCKED REPLAYS in test_event_extractor — those run against real fixtures.
The synthetic events in test_chrono_chain_counting are the ONLY mocked data
and are labeled as such.
```

### Stage 11.3 — Express endpoint integration tests

```
Read [Master Architecture Preamble]. 

Jest + supertest suite for every /api/* and /games/:id/* endpoint.

FILES TO CREATE:
- reveal-sc2-opponent-main/stream-overlay-backend/__tests__/profile.test.js
- ...config.test.js
- ...settings.test.js (already partial from Stage 2.1)
- ...onboarding.test.js
- ...diagnostics.test.js
- ...backups.test.js
- ...custom-builds.test.js (already partial from Stage 7.4)
- ...community-sync.test.js
- ...version.test.js
- ...games.test.js (existing /games/:id/build-order, /macro-breakdown etc.)
- ...health.test.js

FRAMEWORK:
- jest (already in devDeps; add if missing)
- supertest for HTTP simulation
- Test helper that boots Express against a temp data dir with fixtures
  pre-seeded.

COVERAGE PER ROUTE:
- 200 happy path with realistic body
- 400 validation error
- 404 not-found
- 500 backend-failure (mock the Python spawn here, that's acceptable)

DON'T MOCK: data files (use temp dirs with copies of real fixtures),
schema validation, file I/O.
DO MOCK: Python subprocess spawn (canned stdout); external services
(Twitch, OBS, Pulse, community-builds API) at the fetch level.

VERIFY:
1. cd reveal-sc2-opponent-main/stream-overlay-backend && npx jest — all pass.
2. Coverage ≥ 70% across routes.
3. CI: same workflow as 11.2.
```

### Stage 11 acceptance criteria

- [ ] `tests/fixtures/replays/` has ≥ 25 real anonymized replays + manifest.
- [ ] Python pytest suite passes with ≥ 80% coverage on macro/extractor modules.
- [ ] Jest suite passes with ≥ 70% coverage on Express routes.
- [ ] CI runs both suites on every PR.

---

## Stage 12 — Distribution

**Why now:** the suite is feature-complete and tested. Now make it installable in two clicks. Without this, only developers can run it.

**Duration:** 3-4 days.

### Stage 12.1 — Single-installer build (NSIS)

```
Read [Master Architecture Preamble]. 
GOAL: Produce a Windows .exe installer that drops the entire suite onto a
fresh machine. Non-technical user double-clicks it, hits Next a few times,
gets a desktop shortcut, launches the app.

TOOL: NSIS (Nullsoft Scriptable Install System). Free, scriptable, ~200KB.

WHAT THE INSTALLER MUST DO:
1. Detect Python 3.10+ on PATH; if missing, prompt to install or bundle it.
2. Detect Node.js 18+; same fallback.
3. Copy the suite to %ProgramFiles%\SC2Tools\ (or user-chosen dir).
4. Run `pip install -r SC2Replay-Analyzer/requirements.txt` once.
5. Run `npm ci` in reveal-sc2-opponent-main/stream-overlay-backend/ once.
6. Create Start Menu entry + Desktop shortcut pointing to
   SC2Replay-Analyzer\SC2ReplayAnalyzer.py (the Stage 3 launcher).
7. Register an uninstaller.
8. Write a fresh data/config.json with empty values (wizard fills it on
   first run).

FILES TO CREATE:
- packaging/installer.nsi
- packaging/installer-assets/icon.ico (use existing reveal-sc2-opponent-main/sc2tools.ico)
- packaging/build-installer.ps1 (orchestrates makensis.exe)
- .github/workflows/release.yml that builds the installer on tag push and
  attaches it to the release.

TESTING:
- Run on a clean Windows 11 VM (or Hyper-V).
- Verify all paths exist, shortcuts work, app launches, wizard appears.
- Run the uninstaller, verify clean removal.

VERIFY:
1. ./packaging/build-installer.ps1 produces dist/SC2Tools-Setup-<version>.exe
2. Hash output: SHA256 reproducible across runs.
3. Install on a clean VM: no manual configuration required to reach
   the wizard.

NO MOCKS — the installer copies real files and runs real package installs.
CI pinning of dependency versions in requirements.txt and package.json is
a prereq.
```

### Stage 12.2 — Auto-update mechanism

```
Read [Master Architecture Preamble]. Stage 12.1 must be complete.

GOAL: When a new release lands on GitHub, users see an unobtrusive banner
offering to update.

PIECES:
1. Version stamp: bumped on every release. Stored in `package.json` AND
   in `SC2Replay-Analyzer/__init__.py` as __version__. CI verifies they match.
2. Update check endpoint (server-side): GET /api/version returns
   { current, latest, release_url, release_notes }
   `latest` from GH Releases API:
     GET https://api.github.com/repos/ReSpOnSeSC2/sc2tools/releases/latest
   Cache 1 hour. Anonymous request.
3. UI: non-blocking banner at top of every page when latest > current.
   "Version 1.5.0 is available — view release notes | Update now".
   "Update now":
     - Downloads installer to %TEMP%\SC2Tools-Setup-<version>.exe
     - Validates SHA256 against GH Releases
     - Runs installer with /SILENT
     - Schedules current app to exit and restart after install
4. Settings → About: "Check for updates" button does the same on demand.

FILES TO MODIFY/CREATE:
- reveal-sc2-opponent-main/stream-overlay-backend/routes/version.js (new)
- SPA index.html: <UpdateBanner> at top of <App>.
- packaging/silent-update.ps1: helper that runs installer silently and
  re-launches.

VERIFY:
1. Tag a v0.0.1-test release with a synthetic installer.
2. Run suite locally with current=v0.0.0; banner appears.
3. Click Update; installer runs silently; suite restarts.
4. After restart, banner gone, current matches.

REAL DATA: version check hits real GH. Don't stub the response in production
code (mock in tests only).
```

### Stage 12 acceptance criteria

- [ ] Fresh Windows VM → installer produces a working install with 1-click setup.
- [ ] Uninstaller removes everything cleanly.
- [ ] Banner appears when a newer release tag exists on GH.
- [ ] "Update now" downloads, validates, installs, restarts.

---

## Stage 13 — Streamer expansion

**Prerequisites:** Phases 9-12 shipped. Twitch developer account. Twitch app registered with proper scopes.

The current `tmi.js` integration uses chat-only scopes (`chat:read`, `chat:edit`). This stage adds:
- `channel:manage:predictions` for Twitch Predictions
- `channel:manage:polls` for Chaos Mode (or `chat:edit` fallback)
- `channel:read:subscriptions` (optional — gates Chaos to subs)

Requires migrating from a static OAuth token to a refresh-token flow.

**Duration:** ~2 weeks.

### Stage 13 — Feature 4: Twitch Predictions Auto-Engine

> Game start → bot opens "Will Response win?" prediction; resolves on game end.

#### Stage 13.1.1 — OAuth and token management

```
Read [Master Architecture Preamble]. Stages 0-12 must be complete.

Build the OAuth flow upgrade for Twitch Predictions.

Read first:
- reveal-sc2-opponent-main/stream-overlay-backend/index.js (current tmi.js
  OAuth token usage)
- overlay.config.json
- package.json

Predictions require a Helix-capable user access token with
"channel:manage:predictions" scope, which means an authorization code flow
with refresh tokens.

Build:

1. reveal-sc2-opponent-main/stream-overlay-backend/oauth_routes.js
   exports an Express router with:

   GET /oauth/twitch/login
     - redirects to https://id.twitch.tv/oauth2/authorize with configured
       client_id, redirect_uri (http://localhost:8080/oauth/twitch/callback),
       scopes (chat:read chat:edit channel:manage:predictions
       channel:manage:polls), and state cookie for CSRF.

   GET /oauth/twitch/callback
     - exchanges code for access_token + refresh_token
     - stores in data/.twitch_tokens.json (atomic, 0o600)
     - validates against /helix/users to capture broadcaster_id
     - redirects to /static/oauth-success.html

   POST /oauth/twitch/refresh (internal)
     - reads stored refresh_token, calls /oauth2/token, persists, returns
       new access_token

   GET /oauth/twitch/status
     - returns { connected, broadcaster_id, scopes, expires_in_seconds }

2. reveal-sc2-opponent-main/stream-overlay-backend/twitch_helix.js
   exports a thin Helix client class:

   class TwitchHelix {
     constructor({ clientId, getAccessToken, getRefreshToken,
                   onTokensRefreshed }) { ... }

     async createPrediction(broadcasterId, opts) { ... }
     async endPrediction(broadcasterId, opts) { ... }
     async createPoll(broadcasterId, opts) { ... }
     async endPoll(broadcasterId, opts) { ... }
     async getUser(login) { ... }
   }

   On 401: refresh + retry once. On 429: exponential backoff respecting
   ratelimit-reset. fetch (Node 18+).

3. Mount oauth_routes at /oauth in index.js. Document new env vars in
   docs/twitch-setup.md:
     TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, TWITCH_REDIRECT_URI

   Update overlay.config.json schema with twitch.client_id,
   twitch.client_secret, twitch.redirect_uri, twitch.broadcaster_login.

4. Admin page at stream-overlay-backend/public/admin/oauth.html with a
   "Connect Twitch" button → /oauth/twitch/login. Design tokens.

5. Tests at __tests__/twitch_helix.test.js with fetch-mock:
   - 401 → refresh + retry
   - 401 after refresh → propagate error
   - 429 → backoff respecting ratelimit-reset
   - createPrediction fires the right URL + body shape

Security:
- .twitch_tokens.json never committed (.gitignore).
- Refresh token: log only last 4 chars.
- File perms 0o600 on POSIX, ACL-restricted on Windows.
- Document a "rotate tokens" path.

Definition of Done:
- Streamer connects via /oauth/twitch/login, sees success page.
- /oauth/twitch/status returns connected:true.
- TwitchHelix refreshes tokens transparently.
- All tests pass.
- docs/twitch-setup.md walks through Twitch app creation, env vars, flow.
```

#### Stage 13.1.2 — Predictions engine

```
Read [Master Architecture Preamble]. Stage 13.1.1 must be complete.

Build the auto-prediction engine.

Read first:
- TwitchHelix client
- stream-overlay-backend/index.js (game-state events: game_started,
  match_result, opponentDetected)
- overlay.config.json
- SC2Replay-Analyzer/analytics/win_probability.py (model interface)

Create stream-overlay-backend/predictions_engine.js.

Behavior:
1. Listens for "game_started" overlay event.

2. Decide whether to open a prediction:
   - Skip if no broadcaster_id (Twitch not connected)
   - Skip if a prediction is already open
   - Skip if user has predictions disabled in config
   - Skip if game is not ranked (use ranked flag from live parse if
     available; otherwise default to "open anyway")
   - Skip if matchup is mirror without a confidence model

3. Build prediction:
   - title: "Will <streamer> win this game?" (configurable template)
   - outcomes: [{ title: "Win" }, { title: "Loss" }]
   - prediction_window: configurable, default 90s
   - broadcaster_user_id from stored OAuth state

4. Stores active prediction id + outcome ids in memory and on disk at
   data/.active_prediction.json (resilient to crashes).

5. On "match_result":
   - Determine winning outcome.
   - PATCH /helix/predictions to RESOLVED with winning_outcome_id.
   - Clear active prediction state.

6. Cancellation paths:
   - Aborted (no result within 60 min) → CANCELED.
   - Manual cancel via POST /api/predictions/cancel.
   - Reconnect: re-fetch active prediction from /helix/predictions and
     reconcile.

7. Throttle: max one prediction per 5 minutes. Respect Twitch per-channel
   rate limit.

8. Configuration in overlay.config.json:
     "predictions": {
       "enabled": true,
       "title_template": "Will {streamer} win this {matchup}?",
       "prediction_window_seconds": 90,
       "min_seconds_between": 300,
       "skip_if_unranked": false,
       "auto_resolve": true
     }
   Hot-reload on config file change.

9. Emit overlay_event of type "prediction_status" on every state change.

10. Tests at __tests__/predictions_engine.test.js:
    - happy path
    - skip when prediction already open
    - skip when min_seconds_between not elapsed
    - reconcile after restart
    - cancellation paths
    - 4xx errors logged, no crash

Definition of Done:
- Predictions auto-open on game start, auto-resolve on game end.
- State persists across restarts.
- Overlay status widget reflects live state.
- Throttle prevents duplicates.
- All tests pass.
- Manual end-to-end on a test channel.
```

#### Stage 13.1.3 — Prediction status overlay widget

```
Read [Master Architecture Preamble]. Stage 13.1.2 must be complete.

Build a small widget showing prediction state on the streamer's overlay.

Create:
- SC2-Overlay/widgets/prediction-status.html
- ...prediction-status.css
- ...prediction-status.js

Visual states:
1. Idle: hidden.
2. Locking-in: 380x64 pill bottom-right. "Prediction live · 67s to lock in"
   + countdown ring.
3. Locked: "Prediction locked. Resolving on result..."
4. Resolved: pill flashes once. "Resolved: WIN · 612 pts to winners"
   Auto-fade after 8s.
5. Canceled: "Prediction canceled."

Style:
- Idle ring: info blue
- Win flash: success green
- Loss flash: danger red
- Cancel: muted

Behavior:
- Subscribe to prediction_status events.
- Memory-only state; reload re-fetches via GET /api/predictions/active
  (add this endpoint: returns {state, started_at, window_seconds} or 204).

Definition of Done:
- All five states render.
- Reload mid-prediction restores state.
- Lighthouse Best Practices ≥ 95.
- README updated.
```

#### Feature 4 acceptance criteria

- [ ] Streamer connects Twitch via OAuth flow.
- [ ] Game start triggers a prediction within 5 seconds.
- [ ] Prediction window matches config.
- [ ] Win → resolves Win; Loss → resolves Loss.
- [ ] Cancel path works (manual + game-aborted).
- [ ] Throttle prevents duplicates.
- [ ] Restart mid-prediction reconciles state correctly.
- [ ] Overlay widget shows live state.

---

### Stage 13 — Feature 5: Chaos Mode (Chat picks build)

> Viewers vote A/B/C; you must obey.

#### Stage 13.2.1 — Curated build pools

```
Read [Master Architecture Preamble]. Stage 13.1 must be complete.

Define chaos-mode build pools — curated lists of buildable, fun,
not-griefing options viewers can pick from.

Read first:
- data/build_definitions.json
- data/custom_builds.json
- data/community_builds.cache.json (Stage 7)
- core/strategy_detector.py

Create reveal-sc2-opponent-main/data/chaos_build_pools.json.

Schema:
{
  "version": 1,
  "pools": {
    "PvP": {
      "title_template": "What should {streamer} open with vs Protoss?",
      "options": [
        {
          "build_id": "proxy_two_gate",
          "display_name": "Proxy 2-Gate",
          "voter_warning": "high cheese",
          "matchup_score_estimate": "coinflip"
        },
        ... 3-5 options total
      ]
    },
    "PvT": { ... }, "PvZ": { ... },
    "TvT": { ... }, "TvP": { ... }, "TvZ": { ... },
    "ZvZ": { ... }, "ZvT": { ... }, "ZvP": { ... }
  },
  "fallback_pool": [...]
}

Constraints:
- Every option references a build_id that exists in build_definitions.json
  OR custom_builds.json OR community_builds.cache.json.
- 3-5 options per pool (Twitch polls support 2-5).
- ≥ 1 "spicy" option per pool.
- ≥ 1 "safe" option.
- Title template uses {streamer} placeholder.

Validator: scripts/validate_chaos_pools.py
- Asserts every build_id exists.
- 3-5 options per pool.
- No duplicate display_name.
- Exits non-zero if invalid.

Definition of Done:
- chaos_build_pools.json covers all 9 matchups.
- Validator passes.
- docs/chaos-mode.md (~150 words) explains how a streamer customizes the pool.
```

#### Stage 13.2.2 — Chaos engine + EventSub

```
Read [Master Architecture Preamble]. Stages 13.1.2 and 13.2.1 must be complete.

Build the Chaos Mode engine that opens Twitch Polls and locks the result.

Read first:
- TwitchHelix client and PredictionsEngine for patterns.
- chaos_build_pools.json
- Twitch Helix Polls docs:
  https://dev.twitch.tv/docs/api/reference/#create-poll
- Twitch EventSub docs (subscription type: channel.poll.end)

Build two files:

A) reveal-sc2-opponent-main/stream-overlay-backend/twitch_eventsub.js
   class TwitchEventSubClient {
     constructor({ accessToken, broadcasterId, onEvent, onReconnect })
     async connect()
     disconnect()
   }
   - Documented WebSocket lifecycle (welcome, keepalive, reconnect).
   - On poll.end, fires onEvent.
   - Auto-reconnect with backoff.
   - Tests with mocked WebSocket.

B) reveal-sc2-opponent-main/stream-overlay-backend/chaos_mode.js
   class ChaosModeEngine {
     constructor({ helixClient, eventSubClient, configPath, poolsPath,
                   onLockedIn })
     async start(matchup)
     async cancel()
     async _onPollEnded(event)
     getStatus()
   }

   Wired into index.js:
   - Trigger via POST /api/chaos/start (admin-only via shared secret) or
     chat command !chaos (broadcaster only).
   - On match_result: verify compliance via strategy_detector. Post chat
     message accordingly. Persist to data/chaos_history.jsonl.

Configuration in overlay.config.json:
   "chaos": {
     "enabled": false,
     "poll_window_seconds": 75,
     "title_template_override": null,
     "broadcaster_only_trigger": true,
     "post_compliance_to_chat": true
   }

Tests at __tests__/chaos_mode.test.js:
- start triggers helix.createPoll with right options
- poll.end triggers chaos_winner emit
- compliance verification posts right chat message
- non-broadcaster chat triggers rejected
- pool not found for matchup → fallback_pool

Security:
- Trigger endpoint requires X-Admin-Token header matching config.admin_token.

Definition of Done:
- End-to-end: trigger chaos, poll appears on Twitch, chat votes, winner
  locks in, overlay shows it, compliance posted after game.
- All tests pass.
- EventSub reconnects after a forced socket drop.
```

#### Stage 13.2.3 — Chaos overlay widget

```
Read [Master Architecture Preamble]. Stage 13.2.2 must be complete.

Build the chaos-build widget — streamer's reminder of what chat made them
play.

Read first:
- styles.css + design-tokens.css
- The chaos_winner envelope
- existing topbuilds.html for layout patterns

Create chaos-build.html/.css/.js.

Visual states:
A) Voting open: Card 420x150 upper-left. Header: "CHAOS MODE" caps danger
   red mono. Body: countdown ring + "Chat is voting · 47s remaining".
   Optional tally bars updating every 5s (poll midpoint).

B) Locked in: Card morphs.
   Header: "CHAT LOCKED IN"
   Body: build name xl mono, description below
   Subtle "must obey" easter-egg watermark.
   Stays visible for entire game.

C) Compliance:
   - success green: "CHAOS SUCCESS — you obeyed"
   - danger red: "CHAOS BROKEN — you switched"
   Auto-fade after 6s, then small persistent pill with build name for
   next 5 minutes.

Behavior:
- Subscribe to chaos events.
- localStorage persists locked-in state (survives OBS reload).
- Hidden hotkey Shift+Esc → POST /api/chaos/cancel.

Definition of Done:
- All three states render.
- Reload restores state.
- Hotkey cancel works.
- README updated.
```

#### Feature 5 acceptance criteria

- [ ] Trigger chaos before game → Twitch poll appears.
- [ ] Chat votes; winning option locks in.
- [ ] Overlay shows the locked build to streamer.
- [ ] Game ends → compliance message in chat reflects whether streamer obeyed.
- [ ] All 9 matchups have curated pools.
- [ ] Validator passes.
- [ ] Manual test on a real Twitch test channel works end-to-end.

---

## Stage 14 — SC2 Tools Cloud

> Anonymous pooled opponent data. "Your opponent has been seen 240 times by other users — here's the consensus build profile."

**Prerequisites:** Stages 0-13 done. A [Render](https://render.com) account (web service + background worker + Render Key Value addon for the rate-limit cache). A [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (free M0 tier is enough for early traffic). A [Vercel](https://vercel.com) account for the Next.js dashboard. A domain name pointing at the Vercel apex / API at the Render subdomain.

**Duration:** 4-6 weeks. The heaviest stage.

This stage has a fundamentally different shape — it's a real backend project. Treat it as a separate codebase with its own deployment, monitoring, and SLOs.

> Note: the small Stage 7.3 community-builds service can be folded into this larger cloud at this stage, OR continue running standalone. Recommend folding it in to share infra (Postgres, Redis, OAuth, observability).

### Privacy model (read first, treat as constitutional)

- The desktop client only sends data the user has opted into. Default off. Opt-in flow is explicit, granular, and revocable.
- Sent: observed games — opponent in-game name, race, matchup, map, strategy detected, game duration bucket, win/loss FROM THE OBSERVER'S PERSPECTIVE only, observation date (truncated to day).
- Never sent: replay file bytes, MMR, build logs, chat, the observer's own identity beyond a salted client_id.
- Salting: client_id is `HMAC(server_pepper, install_uuid)` — server can rate-limit per client without knowing who.
- A user can request export and deletion of all their observations at any time.
- Every observation is treated as community pool data — no private user accounts have read-only access; everything is queryable by anyone after aggregation.
- Pre-aggregation k-anonymity: a profile is only returned if it has >= K observations from >= M distinct clients (default K=5, M=2). Below that: "not enough data."

### Repo subtree at the root: `cloud/`

```
cloud/
├── api/                           FastAPI service (Render web)
│   ├── pyproject.toml
│   ├── app/{main.py,settings.py,deps.py,routes/,models/,services/,schemas/,db/,workers/}
│   ├── migrations/                MongoDB index management + data backfills
│   ├── tests/
│   └── Dockerfile
├── community-builds/              from Stage 7.3 (folded in here)
├── web/                           Next.js dashboard (Vercel deploy)
│   ├── app/{layout.tsx,page.tsx,opponent/[name]/page.tsx,meta/page.tsx,privacy/page.tsx}
│   ├── components/, lib/, public/
│   └── vercel.json                project + framework + env-var refs
├── client_sdk/                    Python desktop client
│   ├── sc2tools_cloud/{client.py,opt_in.py,batched_uploader.py}
│   └── tests/
├── infra/{render.yaml,docker-compose.dev.yml,monitoring/}
└── docs/{architecture.md,privacy.md,api-reference.md,runbook.md}
```

### Stage 14.1 — Backend scaffolding and infrastructure

```
Read [Master Architecture Preamble]. Stage 13 must be complete.

Stand up the SC2 Tools Cloud backend skeleton.

Stack:
- Python 3.12, FastAPI 0.111+
- MongoDB 7 (Atlas) via Motor (async driver) + Beanie (Pydantic ODM)
- Pydantic v2 for request/response schemas
- Render Key Value (Redis-compatible) for rate limits + cache
- pytest + httpx + pytest-asyncio + mongomock (or testcontainers-mongo)
- ruff, mypy --strict
- OpenTelemetry (OTLP), Sentry
- Hosting: Render web service (API) + Render background worker (aggregator)
  + Render Key Value addon. MongoDB Atlas external. Vercel hosts the
  Next.js dashboard from Stage 14.4.

Read first (context only — don't import; this is a separate codebase):
- reveal-sc2-opponent-main/core/data_store.py (game record shape)
- reveal-sc2-opponent-main/data/build_definitions.json (strategy ids the
  cloud accepts)

Create cloud/api/ with structure given above. In this prompt:

1. cloud/api/pyproject.toml with all deps; lock via uv. Required:
   `fastapi`, `motor`, `beanie`, `pydantic`, `pydantic-settings`,
   `redis[hiredis]` (talks to Render Key Value), `httpx`,
   `python-json-logger`, `sentry-sdk`, `opentelemetry-instrumentation-fastapi`,
   `opentelemetry-exporter-otlp`. Dev: `pytest`, `pytest-asyncio`,
   `mongomock-motor` (or `testcontainers[mongodb]`), `ruff`, `mypy`.
2. app/main.py — FastAPI, Sentry init, OTel auto-instrumentation, CORS for
   web subdomain, rate-limit middleware (slowapi or hand-rolled with Redis).
3. app/settings.py via pydantic-settings v2. Required env vars:
   MONGODB_URL (mongodb+srv://... from Atlas), MONGODB_DB_NAME,
   REDIS_URL (from Render Key Value addon, injected as
   RENDER_REDIS_URL by the platform — alias it to REDIS_URL),
   SENTRY_DSN, SERVER_PEPPER (32+ random bytes),
   ALLOWED_CLIENT_VERSIONS (csv), ENVIRONMENT, OTLP_ENDPOINT.
   On Render, every env var is configured per-service in the
   dashboard or `render.yaml`. Use `sync: false` in render.yaml for
   secrets so they are not committed.
4. app/db/ with Motor + Beanie. Each collection is a Beanie
   `Document` subclass; `init_beanie(database, document_models=[...])`
   runs at FastAPI startup. Documents:
   - Client: { _id ObjectId, salted_id_hash, first_seen_at, last_seen_at,
              client_version, total_observations, opt_in_consent_version,
              banned_at, created_at }
   - Observation: { _id ObjectId, client_id (ref Client),
                    opponent_name_normalized, opponent_race,
                    observer_race, matchup, map_name, strategy_id,
                    observed_at_day (ISODate), game_duration_bucket,
                    won_by_observer, region, created_at }
   - OpponentProfile: { _id opponent_name_normalized,
                        total_observations, distinct_clients,
                        race_distribution (subdoc), strategy_distribution
                        (subdoc), map_distribution (subdoc),
                        last_aggregated_at, visible }
   - AggregationRun: { _id ObjectId, started_at, finished_at,
                       observations_processed, profiles_updated,
                       errors (array) }
   Indexes (declared via Beanie `Settings.indexes`):
     - Observation: compound (opponent_name_normalized, observed_at_day);
       compound (client_id, created_at)
     - OpponentProfile: descending (total_observations); ascending (visible)
     - Client: unique (salted_id_hash)
   Run `python -m app.migrations.sync_indexes` to ensure indexes match
   the source declarations on each deploy.

5. cloud/api/app/migrations/ — index sync + data backfill scripts.
   MongoDB is schemaless so we do not run schema migrations, but we DO
   need: (a) `sync_indexes.py` that builds every Beanie-declared index
   and drops any not-in-source indexes (idempotent, safe to re-run on
   every deploy); (b) one numbered `0001_*.py` style script per data
   backfill, each writing to a `_migrations` collection so re-runs are
   skipped. The Render deploy hook calls `python -m app.migrations.run`
   before promoting the new web service revision.
6. app/routes/health.py — GET /health, GET /ready (db + redis ping).
   Returns build version + git SHA from env.
7. cloud/api/Dockerfile — multi-stage, non-root, healthcheck.
8. cloud/infra/render.yaml — Render Blueprint with:
     - `services[].type=web` for the FastAPI API. Dockerfile build;
       healthCheckPath=/health; envVars referencing Atlas + KV + Sentry;
       autoDeploy=true on main; preDeployCommand runs migrations.
     - `services[].type=worker` for the Stage 14.3 aggregator
       (`python -m app.workers.aggregate_profiles loop`). Same image,
       different start command.
     - `services[].type=keyvalue` (Render Key Value addon, Redis-compatible).
     - The MongoDB cluster is external (Atlas), referenced via the
       MONGODB_URL secret env var.
   cloud/web/vercel.json — Next.js project config: framework=nextjs,
   env vars NEXT_PUBLIC_API_URL pointing at the Render web service URL
   plus production/preview/development scoping.
9. cloud/infra/docker-compose.dev.yml — `mongo:7` + `redis:7` + API.
   Mongo with `--replSet rs0` so dev parity with Atlas (Atlas is always
   a replica set; some Beanie/Motor features require it). Init script
   runs `rs.initiate()` on first boot.
10. cloud/api/tests/ — fixtures, health-check tests, factories.
11. cloud/api/Makefile (or justfile): dev, test, lint, type, migrate, seed,
    deploy.
12. cloud/docs/architecture.md (~600 words).
13. cloud/docs/runbook.md.

Quality gates:
- ruff check passes
- mypy --strict passes
- pytest passes (unit + integration with mongomock-motor)
- `docker compose -f cloud/infra/docker-compose.dev.yml up` brings the
  stack up clean and the API health endpoint returns 200
- `render blueprint launch --dry-run cloud/infra/render.yaml` validates
  the blueprint without deploying

Definition of Done:
- All files present.
- Local dev stack runs via docker compose.
- Health endpoint returns 200 with version info.
- Sentry receives test event when DEBUG_TRIGGER_SENTRY=1.
- OTel spans visible in local Jaeger sidecar.
```

### Stage 14.2 — Observation ingest and rate limiting

```
Read [Master Architecture Preamble]. Stage 14.1 must be complete.

Build observation ingest with strict validation, rate limiting, abuse
protection, HMAC client identity.

Read first:
- cloud/api scaffolding (14.1)
- The privacy model section above (constitutional).

Build:

1. cloud/api/app/schemas/observation.py — Pydantic v2:
   class ObservationIn(BaseModel):
       opponent_name: constr(min_length=1, max_length=64)
       opponent_race: Literal["terran","zerg","protoss","random"]
       observer_race: Literal["terran","zerg","protoss","random"]
       map_name: constr(max_length=64)
       strategy_id: constr(max_length=64)
       observed_at: datetime
       game_duration_seconds: conint(ge=0, le=14400)
       won_by_observer: bool
       region: Literal["NA","EU","KR","SEA","CN","UNKNOWN"]
       client_version: constr(max_length=32)

   ObservationsBatch(observations: list[ObservationIn], min=1, max=50)

2. cloud/api/app/services/ingest.py:
   - normalize_opponent_name: lowercase, strip clan tag, NFKC normalize,
     drop trailing #digits if Battle.net format.
   - bucket_duration: 0-3 / 3-6 / 6-10 / 10-15 / 15-25 / 25+ min.
   - day-truncate observed_at to UTC date.
   - reject if strategy_id not in known set (cloud/api/app/data/
     build_definitions.json — copy from main repo + CI job that fails on drift).

3. cloud/api/app/services/rate_limit.py:
   - Sliding window via Redis: 60 obs/minute per client_id, 1000 obs/hour.
   - Per-IP fallback: 200 obs/minute.
   - Banned client_ids → 403.
   - Suspected abuse → harder rate limit.

4. cloud/api/app/routes/observations.py:
   POST /v1/observations
     headers:
       X-Client-Id: hex client_id
       X-Client-Signature: HMAC-SHA256(server_pepper, body)
     body: ObservationsBatch
     responses:
       202 { received, accepted, rejected, errors }
       400 schema; 401 bad signature; 403 banned; 429 rate limit
   - Validate signature first.
   - Dedupe by (client_id, opponent_name_normalized, observed_at_day,
     strategy_id, game_duration_bucket) within 12h window.
   - Batch DB writes into one transaction.

5. cloud/api/app/services/kanonymity.py — never returns data unless K=5
   and M=2.

6. Tests at cloud/api/tests/test_observations.py: happy path 202,
   bad signature 401, rate limited 429, duplicate dropped, schema 400,
   normalization, banned 403, bucketing math.

Logging:
- Structured JSON via stdlib logging + python-json-logger.
- Never log opponent_name in plaintext at INFO. Hash only. Plaintext at
  DEBUG only.

Definition of Done:
- Endpoint live in dev.
- All tests pass.
- Locust load test (100 concurrent, 50 obs/batch) sustains > 500 RPS.
- Sentry captures synthetic 500.
- No PII in production logs (verify with 1000-request load grep).
```

### Stage 14.3 — Profile aggregation worker

```
Read [Master Architecture Preamble]. Stages 14.1, 14.2 must be complete.

Build the periodic aggregation that turns Observation into OpponentProfile.

Constraints:
- Aggregation every 5 minutes.
- Idempotent.
- Incremental: only opponents with new observations since last run.
- Always respects k-anonymity.

Build:
1. cloud/api/app/workers/aggregate_profiles.py
   async def run_aggregation(db, redis, since=None) -> RunReport:
     - Load AggregationRun.last_finished_at if since is None.
     - One MongoDB aggregation pipeline does the heavy lifting:
       ```
       Observation.aggregate([
         {"$match": {"created_at": {"$gt": since}}},
         {"$group": {
             "_id": "$opponent_name_normalized",
             "total_observations": {"$sum": 1},
             "distinct_clients": {"$addToSet": "$client_id"},
             "races": {"$push": "$opponent_race"},
             "strategies": {"$push": "$strategy_id"},
             "maps": {"$push": "$map_name"},
         }},
         {"$project": {
             "total_observations": 1,
             "distinct_clients": {"$size": "$distinct_clients"},
             "race_distribution": <bucket transform via $reduce>,
             "strategy_distribution": <bucket transform>,
             "map_distribution": <bucket transform>,
         }},
         {"$merge": {"into": "opponent_profiles", "whenMatched": "replace",
                     "whenNotMatched": "insert"}},
       ])
       ```
       `$merge` handles the upsert atomically server-side.
     - Second pass updates `visible` via a single `update_many` that
       matches `{ total_observations: { $gte: K }, distinct_clients:
       { $gte: M } }`.
     - Write AggregationRun document.

2. Schedule: a Render Background Worker service running
   `python -m app.workers.aggregate_profiles loop`. The worker shares
   the API's image so MongoDB + Redis credentials come from the same
   env var bundle. Document the tradeoff vs. a Render Cron Job
   (cron is cheaper but loses warm Mongo connection pool between runs).

3. cloud/api/app/routes/profiles.py:
   GET /v1/profiles/{opponent_name}?matchup=PvZ&map=Goldenaura&region=NA
     200 {
       opponent_name, total_observations, distinct_clients,
       strategy_distribution, race_distribution, map_distribution,
       last_updated_at
     }
     404 if K-anonymity not met
     422 on bad query params
   - Cache 5 min in Redis.
   - Filtered queries only for opponents with > 50 total observations.

4. Tests:
   - Aggregator produces correct distributions.
   - K-anonymity blocks small samples.
   - Idempotency.
   - Profile endpoint 404 below threshold.
   - Cache invalidation.

5. OTel metrics:
   - histogram aggregation.duration_ms
   - counter aggregation.opponents_processed
   - counter aggregation.errors

Definition of Done:
- Aggregator runs every 5 min, visible in logs.
- 10k observations → profiles in < 5s.
- Profile endpoint cached and fast (P95 < 50ms cache hit).
- All tests pass.
```

### Stage 14.4 — Web dashboard (Next.js)

```
Read [Master Architecture Preamble]. Stage 14.3 must be complete.

Build the public web dashboard at sc2tools.cloud.

Stack:
- Next.js 14+ App Router, TypeScript strict
- Tailwind CSS + shadcn/ui (Stage 1 design tokens ported into Tailwind theme)
- Server components default; client only where needed
- Zod for runtime validation
- Vercel deploy

Read first:
- cloud/api/app/routes/profiles.py
- design tokens from Stage 1
- docs/design-system.md

Pages:
1. / (landing) — Hero, 3-column "what is this", live counter (1.2M
   observations, etc.) from /v1/meta/stats. Privacy commitment box.
   CTA → /connect.
2. /opponent/[name] — Server fetches /v1/profiles/{name}. Top section:
   opp name, totals. Strategy distribution horizontal bars (top 10).
   Race donut. Map table. Matchup filter chips. "Insufficient data"
   empathic copy when 404.
3. /meta — Global meta dashboard: most-played strategies per matchup,
   top maps, contributor distribution by region. Heatmap of strategy
   popularity over last 90 days.
4. /privacy — Plain-language privacy notice.
5. /connect — Walkthrough for desktop client opt-in.
6. /community-builds — (folded in from Stage 7.3) Browse community-shared
   build definitions with vote counts.

UI quality:
- Responsive 320 to 2560+.
- Dark theme default; light theme toggle (localStorage).
- WCAG AA throughout. axe-core in CI.
- Lighthouse perf ≥ 90 each page.
- Skeleton loaders; no CLS > 0.1.
- Empty states. 404 + 500 pages.

Tests:
- Playwright E2E: landing → opponent search → opponent page.
- Component tests with synthetic props.
- API mock tests for fetch layer.

Definition of Done:
- All pages render with mock and live data.
- Lighthouse perf ≥ 90, a11y ≥ 95, best practices ≥ 95.
- Playwright passes.
- Deployed to staging URL.
- README in cloud/web/.
```

### Stage 14.5 — Client SDK + opt-in flow

```
Read [Master Architecture Preamble]. Stage 14.4 must be complete.

Build the desktop-side client SDK that uploads observations and the in-SPA
opt-in flow.

Read first:
- cloud/api/app/routes/observations.py
- core/data_store.py
- replay_watcher.py
- analyzer SPA (the Tkinter app is gone after Stage 3)

Build:

1. cloud/client_sdk/sc2tools_cloud/ — installable Python package
   `sc2tools-cloud-client`.
   class CloudClient:
     def __init__(base_url, install_uuid, server_pepper)
     def opt_in_state() -> OptInState
     def set_opt_in(state)
     def queue_observation(obs)
     async def flush() -> FlushResult
   - Queue to data/.cloud_queue.jsonl.
   - Flush every 5 min (configurable). Up to 50/batch.
   - X-Client-Signature via HMAC-SHA256 with server_pepper from
     /v1/meta/handshake at first run.
   - 4xx → drop batch + log. 5xx → exponential backoff.
   - Circuit breaker: 10 failures → pause 1 hour.

   OptInState dataclass:
     enabled, consent_version, opted_in_at,
     scopes (currently ["observations"]; future ["observations","tilt","mmr"])

2. Integrate into replay_watcher.py:
   - After deep parse, build ObservationData and queue it.
   - Only if opt_in_state().enabled.

3. SPA opt-in flow (replaces the Tkinter version):
   - On first launch after this version, show a one-time consent dialog
     in the SPA explaining what's sent (privacy.md copy), with three
     buttons: "Opt in", "Not now", "Never".
   - "Not now" re-prompts after 7 days; "Never" is final.
   - Settings → Privacy panel:
     - Toggle: enabled/disabled
     - "View what was sent" → opens .cloud_queue.jsonl read-only
     - "Request data deletion" → DELETE /v1/clients/{client_id}
     - "Connection status" line: last upload, queue depth, breaker state.

4. Tests:
   - Unit tests for CloudClient queue, signature, retry, breaker.
   - Integration: opt-in, simulate 100 obs, mock API, verify all flushed.
   - SPA dialog smoke test.

5. Docs:
   - cloud/client_sdk/README.md — install, configure, troubleshoot.
   - Update reveal-sc2-opponent-main/README.md with cloud opt-in section.

Privacy guardrails:
- No observation queued unless opt-in is enabled at game-end.
- Disabling immediately stops queueing; existing queue offered for review +
  optional flush before deletion.
- Bumping consent_version forces re-consent.

Definition of Done:
- Opt-in toggle works end-to-end.
- Queued observations flush to cloud.
- Deletion request cascades server-side.
- Privacy dialog matches docs/privacy.md word-for-word.
- All tests pass.
```

### Stage 14 acceptance criteria

- [ ] Two desktop clients on different machines opt in.
- [ ] Both play games against the same opponent.
- [ ] After K=5 observations from M=2 clients, the profile becomes visible.
- [ ] Web dashboard shows the profile.
- [ ] Desktop also fetches and displays via `/api/cloud-profile/{opponent}` proxy.
- [ ] Deletion request from one client purges only that client's data.
- [ ] Lighthouse, mypy, ruff, eslint all clean.
- [ ] Load test sustains 500 RPS, P95 < 100ms cache-hit profile reads.
- [ ] Privacy doc reviewed by a second pair of eyes.

---

## Stage 15 — Mobile companion

> Push notification when queue pops on desktop; scouting card on your phone before the game even starts.

**Prerequisites:** Stage 14 cloud is live with stable APIs and an account/auth system.

**Duration:** 3-4 weeks.

### Repo subtree at the root: `mobile/`

```
mobile/
├── package.json
├── app.config.ts
├── eas.json
├── app/{_layout.tsx,index.tsx,pair.tsx,dashboard.tsx,match/[id].tsx,settings.tsx}
├── components/{ScoutingCard.tsx,SessionStats.tsx,BadgePill.tsx,...}
├── lib/{api.ts,auth.ts,push.ts,storage.ts}
├── assets/icons/
└── __tests__/

cloud/api/app/routes/
├── pairing.py
├── push.py
└── match.py
```

### Stage 15.1 — Cloud-side pairing and push registration

```
Read [Master Architecture Preamble]. Stage 14 must be complete.

Add pairing and push to the cloud API.

Build:

1. New model PairedDevice:
   id, client_id_fk, device_id, platform (ios|android), push_token,
   pair_code, pair_code_expires_at, paired_at, last_seen_at, nickname,
   is_revoked

2. cloud/api/app/routes/pairing.py:
   POST /v1/pairing/generate
     headers: X-Client-Id + signature (desktop auth)
     returns: { pair_code: "ABC-123", expires_at, qr_payload: "..." }
     - 6-character pair codes (uppercase alphanumeric, 5min TTL).
     - QR payload deep-link: sc2tools://pair?code=ABC-123&pepper=...
   POST /v1/pairing/claim
     body: { pair_code, device_id, push_token, platform, nickname }
     returns: { device_uuid, jwt (90 day refresh), paired_client_id }
     - Validates code, marks consumed, persists PairedDevice.
     - JWT bound to (client_id, device_id), 24h, refresh 90d.
   POST /v1/pairing/revoke (auth: device JWT) — marks revoked.

3. cloud/api/app/routes/push.py:
   POST /v1/devices/heartbeat (auth: device JWT)
     - Updates push_token if changed; updates last_seen_at.
   Internal helper: send_push_to_paired_devices(client_id, payload)
     - FCM (Firebase Admin SDK) + APNs (apns2 or http2 directly).
     - Tolerates per-device failures, removes invalid tokens.

4. cloud/api/app/routes/match.py:
   POST /v1/match/started     (called by desktop)
     - Stores active match in Redis keyed by client_id, 30min TTL.
     - Triggers push: "Match starting vs <opp>".
   POST /v1/match/ended       (called by desktop)
     - Clears active match.
     - Triggers push: "Match ended — <result>".
   GET /v1/match/active (auth: device JWT)
     - Returns active match for paired client_id, or 204.
   GET /v1/match/scouting/{match_id} (auth: device JWT)
     - Enriched scouting card: opponent profile, last 5 games, opening
       predictor top 3 (cached from desktop's queue).

5. Privacy:
   - Mobile devices only see data for their paired desktop client.
   - JWT bound to client_id at issue; cannot be re-bound.
   - Pair code single-use.

6. Tests: pair flow happy path, code expiry, push delivery (mocked),
   JWT validation, active match retrieval.

7. Update privacy.md with "paired devices" section.

Definition of Done:
- Desktop generates code, mobile claims, JWT issued.
- Desktop POSTs match/started, push lands on real test device.
- Mobile fetches scouting card via JWT.
- All tests pass.
- Push token rotation handled.
```

### Stage 15.2 — React Native app shell

```
Read [Master Architecture Preamble]. Stage 15.1 must be complete.

Build the mobile companion using Expo SDK 50+ and React Native.

Stack:
- TypeScript strict, Expo (managed)
- expo-router for nav
- @tanstack/react-query for API state
- zod for response validation
- nativewind (Tailwind for RN — port Stage 1 tokens)
- expo-notifications, expo-secure-store, expo-camera (QR)
- jest + @testing-library/react-native
- EAS Build for production binaries

Pages:
1. mobile/app/index.tsx — check JWT in secure-store; redirect to /pair or
   /dashboard.
2. mobile/app/pair.tsx — QR scan default; manual 6-char fallback.
   POST /v1/pairing/claim. Stores JWT, registers push, → /dashboard.
3. mobile/app/dashboard.tsx — paired desktop nickname + connection pill;
   active match banner; session stats; recent matches list (last 10);
   recent badges strip; settings cog.
4. mobile/app/match/[id].tsx — pull-to-refresh; opponent header;
   opening predictor section (top 3 with confidence bars); community
   profile section (if K-anon met); personal history vs opponent
   (last 5 with W/L pills); "Updated 12s ago".
5. mobile/app/settings.tsx — notification settings; theme; unpair.

UI quality:
- 60fps animations, skeleton loaders, pull-to-refresh on dashboard +
  match, haptics, safe-area handling, dynamic type, accessibility labels.

Push notifications (mobile/lib/push.ts):
- Register device on first launch + every app open (heartbeat).
- Deep-link handlers: tap match-start → /match/{id}; tap match-end →
  /dashboard.
- Permission flow with empathic explainer.

Tests:
- Component tests for ScoutingCard, SessionStats, BadgePill.
- API hook tests with mocked fetch.
- Pair flow E2E with Detox or Maestro.

Quality gates:
- pnpm lint clean
- pnpm test passes
- EAS build produces installable .apk and .ipa
- React DevTools profiler — no unexpected re-renders.

Definition of Done:
- Sideloaded on real Android: pair flow works.
- TestFlight on real iPhone: same.
- Push arrives within 3s of desktop POSTing match/started.
- Scouting card renders within 500ms of notification tap.
- Settings unpair fully clears state.
- README in mobile/ with setup, EAS build, TestFlight publish instructions.
```

### Stage 15.3 — Desktop-side pairing UI (in the SPA)

```
Read [Master Architecture Preamble]. Stage 15.2 must be complete.

Add the pairing UI to the analyzer SPA's Settings page (the Tkinter app
was retired in Stage 3).

Read first:
- Cloud API pairing endpoints (15.1)
- public/analyzer/index.html
- design tokens

In Settings → "Mobile companion" section:

- Pair button → POST /v1/pairing/generate → modal with:
  - Big QR code (use a JS QR library; render as <img> or <svg>).
  - 6-character pair code in monospace below.
  - 5-minute countdown.
  - Cancel button.
  - On success (poll /v1/pairing/status/{code} every 2s): close modal,
    toast "Paired with <nickname>".

- Paired devices list:
  - Each row: nickname, platform icon, paired at, last seen.
  - Per-row "Revoke" button → POST /v1/pairing/revoke.

Match-start notification trigger:
- Hook into existing game_started event flow.
- POST /v1/match/started with live-parse data.
- POST /v1/match/ended on match_result.

Tests:
- QR generation produces a scannable code.
- Paired devices list renders, revoke works.
- Match start triggers cloud POST.

Definition of Done:
- Pair modal shows working QR.
- Real mobile device scans the QR and pairs within 30s.
- Match-start push lands on mobile within 5s.
- Revoke from desktop instantly invalidates JWT on mobile.
```

### Stage 15 acceptance criteria

- [ ] Pair a real iPhone and a real Android device to the same desktop.
- [ ] Start a match → both phones receive the push within 5s.
- [ ] Tap notification → scouting card shows opening predictor + community profile + last-5 history.
- [ ] End match → push notification arrives.
- [ ] Unpair from either side immediately invalidates the connection.
- [ ] App stores submission ready: privacy policy linked, screenshots, descriptions.
- [ ] No PII in logs or analytics.

---

## Appendix A — Cost estimate

| Stage | Item | Monthly cost |
|---|---|---|
| 0-12 | None — local only | $0 |
| 7.3 | Community-builds Fly.io tiny | ~$5 |
| 13 | Twitch app — free | $0 |
| 14 | Fly.io 2x shared-cpu-1x + 1GB RAM | ~$10 |
| 14 | Postgres 1GB | ~$15 |
| 14 | Redis 256MB | ~$5 |
| 14 | Sentry (developer plan) | $0 |
| 14 | Cloudflare (free tier) | $0 |
| 14 | Domain | ~$15/year |
| 14 | Vercel (web dashboard) | $0–$20 |
| 15 | FCM | $0 |
| 15 | APNs | $99/yr Apple Dev |
| 15 | EAS Build (free tier) | $0 |

Floor: ~$35/month + $114/year. Scales with cloud usage; budget for a 5x burst the first month after launch.

---

## Appendix B — Privacy and compliance checklist

Before Stage 14 ships:

- [ ] privacy.md drafted and reviewed.
- [ ] Opt-in flow language reviewed by someone outside the project.
- [ ] Server pepper is at least 32 bytes, random, never logged.
- [ ] No PII in production logs (verified with synthetic load).
- [ ] Deletion request flow tested end-to-end.
- [ ] Data retention policy documented (raw observations: 24 months, then aggregate-only).
- [ ] Region tags inferred from public ladder regions only — never IP geolocation persisted.
- [ ] EU-style data subject access request supported (CSV export).
- [ ] Children's data: in consent flow, attestation that user is 13+.
- [ ] Terms of Service drafted.
- [ ] Cookie policy (web dashboard) drafted.
- [ ] Community-builds (Stage 7.3) policy: authors are public via display name; flag/moderation pipeline documented.

---

## Appendix C — Launch checklist

For each feature, before declaring done:

- [ ] All acceptance criteria checked.
- [ ] Tests pass in CI.
- [ ] Manual play-through on a real account.
- [ ] No new lint/type errors.
- [ ] Documentation updated (README, docs/, in-app help).
- [ ] Screenshots captured and committed.
- [ ] Roadmap entry moved from "in progress" to "shipped".
- [ ] Release notes drafted.
- [ ] Telemetry verified (overlay events fire, cloud metrics record).
- [ ] Rollback plan documented.

---

## Appendix D — Suggested ship rhythm

| Week | Milestone |
|---|---|
| 1 | Stages 0 + 1 (fixes + design tokens). Ship 0.9-rc. |
| 2 | Stage 2 (config + wizard + settings). Ship 1.0-rc. |
| 3 | Stages 3 + 4 (launcher + diagnostics). Ship 1.0. |
| 4 | Stage 5 (4 quick-win charts). Ship 1.1. |
| 5-6 | Stage 6 (race-aware macro). Ship 1.2. |
| 7-8 | Stage 7 (custom build editor + community DB). Ship 1.3. |
| 9+ | Stage 8 (build library content) — one matchup per week, ongoing. |
| 9-11 | Stage 9 (opening predictor, tilt detector, achievements). Ship 1.4. |
| 12-14 | Stage 10 (engagements, win prob, heatmap, scrubber). Ship 1.5. |
| 13-14 | Stage 11 (test fixtures + suites). Ship 1.5.1. |
| 15 | Stage 12 (installer + auto-update). Ship 1.6 with proper distribution. |
| 16-17 | Stage 13 (Twitch Predictions + Chaos Mode). Ship 2.0. |
| 18-23 | Stage 14 (cloud). Ship 2.1. |
| 24-27 | Stage 15 (mobile). Ship 3.0. |

If you want me to spawn one of these prompts right now, say which Stage and I'll kick it off. Stage 0.1 is the most contained (~30 minutes).

---

## Phase order rationale (why this sequence)

1. **Stages 0-4 first** — fixes, design tokens, wizard, launcher, diagnostics. The user couldn't pleasantly run the app without these. Everything else assumes they exist.
2. **Stages 5-6 next** — the analyzer SPA is the user's daily driver. Charts + race-awareness make every replay drawer dense with insight.
3. **Stage 7** — opening up authoring with shared community DB unlocks compounding value. One user's good build helps everyone.
4. **Stage 8** — content-heavy. Seeds the classifier so it actually works for non-Protoss matchups and rare openings.
5. **Stage 9** — local intelligence (predictor, tilt, badges) compounds: they share data layers and patterns.
6. **Stage 10** — the big "wow" charts. Earned by the prior stages' data plumbing.
7. **Stage 11** — testing before distribution. Skipping this is technical debt.
8. **Stage 12** — distribution. Without it, only developers can run it.
9. **Stage 13** — streamer features ride on existing OBS overlays + chat-bot infra.
10. **Stage 14** — Cloud is the heaviest lift and most consequential decision.
11. **Stage 15** — Mobile depends entirely on the cloud being live.

Skipping ahead is fine for prototypes but hurts at scale: a mobile app without a cloud is a chat client; a chat-bot Predictions feature without local features is a feature without a moat.

---

## How to use this document

1. Pick the Stage you're starting. Confirm prerequisites are done.
2. Open the relevant prompt in a fresh `claude-code` (or equivalent) session.
3. Paste the Master Architecture Preamble, then the prompt body.
4. The prompt contains everything the AI needs — file paths, libraries, acceptance criteria.
5. After the AI produces code, run the Definition-of-Done checks before moving on.
6. Don't stack prompts. One prompt → one PR → review → merge → next prompt. Treat each as an atomic unit.

Good luck. Build something that people actually use every day.




