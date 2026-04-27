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

## Stage 2 — Configuration and onboarding


### Stage 2.2 — First-run wizard (React SPA)

```
Read [Master Architecture Preamble]. 

GOAL: A 6-step first-run wizard inside the React SPA at
reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html.
Triggered when GET /api/profile/exists returns { exists: false }; otherwise
the app loads normally. Non-technical user must complete it without
documentation.

UX FLOW:

Step 1 — Welcome
  - Heading: "Welcome to your SC2 stats lab."
  - 3 bullet points (what it does)
  - "Get started" button

Step 2 — Replay folder
  - Auto-detect candidate folders by scanning typical locations:
      %USERPROFILE%\Documents\StarCraft II\Accounts\*\*\Replays\Multiplayer
      %USERPROFILE%\OneDrive\Pictures\Documents\StarCraft II\... (current layout)
      C:\StarCraft II\Replays
  - Backend helper: NEW endpoint POST /api/onboarding/scan-replay-folders
    spawns SC2Replay-Analyzer/scripts/recon_sc2_install.py and returns
    its findings. Implement the endpoint if not present.
  - Show found folders with replay counts. User clicks one OR pastes a custom
    path. Folder picker via webkitdirectory <input> for native UX.
  - Validate: folder must exist AND contain at least one .SC2Replay file.

Step 3 — Player identity
  - Backend helper: NEW endpoint POST /api/onboarding/scan-identities
    body: { folder, sample_size: 100 }
    Spawns SC2Replay-Analyzer/scripts/identity_cli.py (you'll create this)
    that walks N replays and returns a frequency-sorted list of distinct
    human player names plus their character_ids.
  - Show table: Name | Character ID | Games seen | "This is me" radio.
    Default-select the most frequent.

Step 4 — Race preference
  - Four radio buttons: Protoss / Terran / Zerg / Random.
  - For Random, show a hint: "We'll track all three race-played stats and
    show your Random performance per race."

Step 5 — Optional integrations
  - Three collapsible cards: Twitch, OBS, SC2Pulse. Each has its own form
    fields and a "Test connection" button that round-trips against the real
    service:
      Twitch:   POST /api/onboarding/test/twitch  { channel, oauth_token }
      OBS:      POST /api/onboarding/test/obs     { host, port, password }
      SC2Pulse: POST /api/onboarding/test/pulse   { character_id }
    Each test endpoint actually attempts the connection (use the existing
    twitch helpers in stream-overlay-backend/index.js, obs-websocket-js for
    OBS, and the existing pulse fetch in scanner / analyzer.js for Pulse).
  - "Skip all" button for users who don't stream.

Step 6 — Apply
  - Show summary of what's about to be saved.
  - "Apply & start" button:
      PUT /api/profile, PUT /api/config (atomic; if either fails, show error)
      POST /api/onboarding/start-initial-backfill (kicks off macro backfill
        + initial replay scan in the background; reuses existing
        /macro/backfill/start endpoint).
  - On success, navigate to the main app.

FILES TO MODIFY:
- reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html
  (add a <Wizard> component, conditionally render at the very top of <App>)
- reveal-sc2-opponent-main/stream-overlay-backend/index.js (mount the new
  /api/onboarding/* router)

FILES TO CREATE:
- reveal-sc2-opponent-main/stream-overlay-backend/routes/onboarding.js
- SC2Replay-Analyzer/scripts/identity_cli.py
- (Optional) reveal-sc2-opponent-main/stream-overlay-backend/__tests__/onboarding.test.js

STYLING:
- Use the design tokens from Stage 1 (var(--color-...)) — no hard-coded hex.
- Modal-style centered card for the wizard (max-width 720px), translucent
  backdrop, can't dismiss until step 6 succeeds OR user clicks "Skip wizard
  (advanced)" at the bottom.
- Sticky progress strip showing 1-2-3-4-5-6 with the active one highlighted.

ACCESSIBILITY:
- All form inputs have <label htmlFor>.
- Tab order matches visual order.
- Errors announced via aria-live="polite".
- "Test connection" buttons disable while testing and show a spinner.

VERIFY:
1. Delete data/profile.json and data/config.json (back them up first).
2. Reload the SPA — wizard appears, walks through all 6 steps with real data
   from your replay folder.
3. After step 6, files exist on disk and contain real values (not placeholders).
4. Reload SPA — wizard does NOT appear; main app loads.
5. Restore the user's actual profile.json/config.json after testing.

NO MOCKS. The folder-scan and identity-scan endpoints actually run the
Python helpers. The "Test connection" buttons actually hit Twitch/OBS/Pulse.
If a service is unreachable, the test fails honestly.
```

### Stage 2.3 — Settings page (post-onboarding)

```
Read [Master Architecture Preamble]. Stages 2.1 and 2.2 must be complete.

GOAL: A persistent /settings route in the React SPA that lets the user edit
every value in profile.json and config.json. Same fields as the wizard but
laid out as a tabbed page; users return here whenever they want.

FILES TO MODIFY:
- reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html
  Add: <SettingsPage>, plumbed into the existing tab/route system. Add a
  "Settings" item to the top nav (the same nav that has Overview, Builds,
  Opponents, etc.).

LAYOUT (tabs along the left, content right):
- Profile             (battle tag, character id, race preference, mmr target)
- Replay folders      (list with add/remove, "test" button per folder)
- Macro engine        (enabled disciplines, min game length, engine version readonly)
- Build classifier    (active build definitions checkbox list, custom builds toggle,
                       community shared builds toggle — Stage 7)
- Stream overlay      (Twitch / OBS sub-cards with the same test buttons as wizard)
- Backups             (read-only list of *.backup-* files in data/, restore button)
- Diagnostics         (link to /diagnostics — Stage 4)
- Privacy             (telemetry opt-in toggle, retention policy, cloud opt-in (Stage 14))
- About               (version, link to GitHub, "check for updates" button)

EACH FIELD:
- Inline-editable with dirty-state tracking
- Save bar at the top (sticky) shows "X unsaved changes — Save | Discard"
- Save calls PATCH /api/profile or PATCH /api/config (whichever applies)
- Validation errors render inline next to the field
- All form controls accessible via keyboard

INTERACTIONS:
- Replay folders → "Test" button: POST /api/onboarding/scan-replay-folders
  with { single_path: "<the path>" } returns replay count. Show "✓ 1842 replays
  found" or "✗ no replays detected".
- Replay folders → "Remove": confirm dialog with replay count.
- Build classifier → "Active builds" checkbox list reads
  data/build_definitions.json AND data/custom_builds.json AND
  (after Stage 7) data/community_builds.cache.json, lets user toggle.
  Saves the IDs into config.build_classifier.active_definition_ids.
- Backups → "Restore" button: confirm dialog → POST /api/backups/restore
  with { snapshot } (you'll need to add this endpoint; it copies the snapshot
  back over the live file).

FILES TO CREATE:
- reveal-sc2-opponent-main/stream-overlay-backend/routes/backups.js
  endpoints:
    GET  /api/backups            → list of *.backup-* and *.broken-* files in data/
    POST /api/backups/create     → snapshot meta_database.json with timestamp
    POST /api/backups/restore    → body { snapshot } restores it (creates a
                                   new pre-restore backup first, then renames)
    DELETE /api/backups/:name    → delete a snapshot

VERIFY:
1. Open /settings, navigate every tab. No console errors.
2. Change race_preference, save, refresh. Persisted on disk.
3. Click "Test" on the replay folder. Real count shows up.
4. Add a fake folder, save. Reload. The fake folder is in config.json.
   Remove it. Save. It's gone.
5. Backups tab shows the existing pre-chrono-fix-* file (and any others).
   "Restore" creates a new pre-restore-* snapshot before restoring,
   then swaps.

NO MOCKS — every test button hits real services. Backup restore actually
swaps real files (with a safety snapshot first).

(AI BROKE THIS UP INTO 2.3 and 2.4)

# Stage 2.4 — SettingsPage UI (paste this prompt in a fresh session)

## Pre-flight

Before doing anything else, confirm the working tree is clean and the Stage 2.3
backend is in place:

```bash
cd C:\SC2TOOLS
git log --oneline -3
# Top of log should include:
#   feat(stage-2.3): backups router for snapshot/restore lifecycle
#   feat(stage-2.2): first-run wizard, onboarding API, identity CLI
#   feat(stage-2.1): profile/config schemas + ajv-validated settings router
git status
# Should be clean (or only the long-standing CRLF-noise modifications
# on files unrelated to Stage 2.4).
```

Confirm the four backups endpoints respond:

```bash
cd C:\SC2TOOLS\reveal-sc2-opponent-main\stream-overlay-backend
node -e "fetch('http://127.0.0.1:3000/api/backups').then(r=>r.json()).then(b=>console.log(b.backups.length+' snapshots'))"
```

## Goal

Persistent `/settings` route in the React SPA at
`reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html`,
laid out as a tabbed page. Same fields as the Stage 2.2 wizard but the user
can return whenever they want. Wires up to the routers committed in Stage 2.1
(`/api/profile`, `/api/config`), Stage 2.2 (`/api/onboarding/*`), and Stage
2.3 (`/api/backups/*`).

## File to modify

- `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html`

This file is **8,820+ lines**. The roadmap preamble's "no-edit zone" rule
forbids the Edit tool's old_string/new_string mode for files > 1000 lines.
Use bash + python3 with read → modify → atomic-rename. Verify with
`tail`, `wc -l`, and an HTML closing-token grep after every write.
Confirm `git diff` only shows the inserted hunks before staging.

## Layout (tabs along the left, content right)

| Tab | Source | Maps to                                                          |
|-----|--------|-------------------------------------------------------------------|
| Profile           | `/api/profile`            | battle_tag, character_id, race preference, mmr_target |
| Replay folders    | `/api/config` paths       | list with add/remove + per-row Test button            |
| Macro engine      | `/api/config` macro_engine| enabled disciplines, min game length, engine_version (readonly) |
| Build classifier  | `/api/config` build_classifier | active builds checkbox list (built-ins + custom only — Stage 7 community deferred), use_custom_builds toggle |
| Stream overlay    | `/api/config` stream_overlay | Twitch/OBS sub-cards reusing the wizard's test buttons |
| Backups           | `/api/backups`            | read-only list with create/restore/delete actions     |
| Diagnostics       | (link to /diagnostics)    | placeholder; real page in Stage 4                     |
| Privacy           | `/api/config` telemetry   | telemetry opt-in toggle, retention policy, cloud opt-in (Stage 14) |
| About             | `/api/config` ui          | version, GitHub link, "check for updates" button      |

## Field interactions

Every field is **inline-editable with dirty-state tracking**:

- Sticky save bar at the top: "X unsaved changes — Save | Discard"
- Save calls `PATCH /api/profile` or `PATCH /api/config` (whichever the field belongs to)
- Validation errors render inline next to the field
- All form controls accessible via keyboard (focus-visible ring, aria-label on icon buttons)
- Respect `prefers-reduced-motion` for transitions

## Behavioral specifics

- **Replay folders → Test button**: `POST /api/onboarding/scan-replay-folders`
  with `{ single_path: "<path>" }`. Renders "✓ 1842 replays found" or
  "✗ no replays detected". No mocks.

- **Replay folders → Remove button**: confirm dialog with replay count.

- **Build classifier → Active builds**: read from
  `data/build_definitions.json` AND `data/custom_builds.json` (NOT
  `data/community_builds.cache.json` — that's Stage 7 territory; render a
  disabled "Community builds (Stage 7)" section with a tooltip). Saves
  IDs to `config.build_classifier.active_definition_ids`.

- **Backups tab**:
  - On mount: `GET /api/backups` and render the table with name, base,
    kind (chip color: `pre`=amber, `broken`=red, `backup`=blue,
    `bak`=gray), size (humanized), modified date.
  - "Create snapshot" button → `POST /api/backups/create`
    body `{ base: "meta_database.json" }`, then refresh the list.
  - Per-row "Restore" → confirm dialog → `POST /api/backups/restore`
    body `{ snapshot: <name> }`. Show the response's `pre_restore_snapshot`
    inline as "Safety snapshot: <name>".
  - Per-row "Delete" → confirm dialog → `DELETE /api/backups/:name`,
    then refresh.
  - Refuse to render the Restore / Delete buttons if the row's
    `kind === 'pre'` AND label starts with `restore-` (don't let the
    user delete the safety snapshot they just created — at least not
    until they've dismissed an "Are you sure?" with extra wording).

## Not in scope (Stage 2.4)

- Diagnostics tab body — Stage 4 owns that
- Cloud sync opt-in — Stage 14
- Community builds checkboxes — Stage 7
- Schema migrations of profile/config — Stage 14

## Definition of done

- [ ] `/settings` reachable from the top nav alongside Overview / Builds / Opponents.
- [ ] Every field round-trips: edit → Save → reload page → value persists.
- [ ] Replay-folder Test button shows real count for the user's default replay folder.
- [ ] Backups tab shows all 7+ existing snapshots from the install.
- [ ] Create / Restore / Delete buttons work end-to-end on a freshly created
      throw-away snapshot of `profile.json` (don't restore over the user's
      live `meta_database.json` during the smoke test).
- [ ] No console errors. Lighthouse a11y >= 90.
- [ ] `git diff --stat` shows changes ONLY to `public/analyzer/index.html`.
- [ ] PR template filled in (what / why / how-tested / screenshots).

## Hand-off

Stage 2.3 backend committed at `7ef14a1`. Stage 2.4 is the UI half.


```

### Stage 2 acceptance criteria

- [ ] Fresh user with no `profile.json` sees the wizard automatically.
- [ ] Wizard's 6 steps complete with real folder/identity scans.
- [ ] `/settings` lets the user edit every field after the wizard finishes.
- [ ] Replay-folder "Test" returns a real replay count.
- [ ] Backup tab snapshots and restores real `data/meta_database.json`.

---

## Stage 3 — Architecture cleanup

**Why now:** before adding any more UI, retire the slow Tkinter app. The browser-based analyzer is faster, prettier, and easier to extend.

**Duration:** 1-2 days.

### Stage 3.1 — Replace `SC2ReplayAnalyzer.py` with a tiny launcher

```
Read [Master Architecture Preamble]. Stages 0-2 must be complete.

GOAL: Stop maintaining the slow Tkinter desktop app. Replace it with a small
launcher script that starts the Express backend and opens the React SPA in
the user's default browser. The desktop user gets the same UX as before but
faster, prettier, and with more features.

FILES TO MODIFY:
- SC2Replay-Analyzer/SC2ReplayAnalyzer.py (replace contents)
- reveal-sc2-opponent-main/Reveal-Sc2Opponent.ps1 (audit; may already do this)
- reveal-sc2-opponent-main/START_SC2_TOOLS.bat (audit)

FILES TO ARCHIVE (don't delete; rename):
- SC2Replay-Analyzer/ui/app.py            → SC2Replay-Analyzer/ui/app.py.deprecated
- SC2Replay-Analyzer/ui/visualizer.py     → ...similarly
- (anything else under SC2Replay-Analyzer/ui/ that's GUI-specific)

NEW SC2ReplayAnalyzer.py:
import os, subprocess, sys, time, webbrowser, atexit, signal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "reveal-sc2-opponent-main" / "stream-overlay-backend"
PORT = int(os.environ.get("SC2_TOOLS_PORT", "3000"))

def main():
    if not BACKEND.exists():
        print(f"FATAL: stream-overlay-backend not found at {BACKEND}",
              file=sys.stderr)
        sys.exit(1)

    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    proc = subprocess.Popen(
        [npm_cmd, "start"],
        cwd=str(BACKEND),
        env={**os.environ, "PORT": str(PORT)},
        creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
    )

    def shutdown(*_):
        try:
            if os.name == "nt":
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
    atexit.register(shutdown)

    import urllib.request, urllib.error
    url = f"http://127.0.0.1:{PORT}/api/health"
    for _ in range(30):
        try:
            urllib.request.urlopen(url, timeout=1).read()
            break
        except (urllib.error.URLError, ConnectionRefusedError):
            time.sleep(1)
    else:
        print(f"FATAL: backend did not become ready at {url}",
              file=sys.stderr)
        sys.exit(2)

    webbrowser.open_new_tab(f"http://127.0.0.1:{PORT}/analyzer/")
    proc.wait()

if __name__ == "__main__":
    main()

ALSO ADD:
- A /api/health endpoint in reveal-sc2-opponent-main/stream-overlay-backend/index.js
  that returns 200 { ok: true, version, uptime_sec }. Use this for the
  readiness poll above and for the /diagnostics page (Stage 4).

UPDATE THE BAT:
START_SC2_TOOLS.bat should call the new SC2ReplayAnalyzer.py via `py`.

VERIFY:
1. python SC2ReplayAnalyzer.py
2. Backend starts; /api/health responds 200.
3. Default browser opens to http://127.0.0.1:3000/analyzer/.
4. Closing the terminal kills the backend.
5. On Windows, double-clicking START_SC2_TOOLS.bat does the same thing.
6. The Tkinter app no longer launches (and doesn't need to — it's now archived).

REPORT BACK: paths archived, new launcher line count, /api/health response
shape.

No mock data. Real readiness poll, real browser launch.
```

### Stage 3 acceptance criteria

- [ ] Double-click `START_SC2_TOOLS.bat` → backend boots, browser opens, analyzer SPA loads.
- [ ] Closing the terminal kills the backend cleanly.
- [ ] Tkinter modules archived as `.deprecated`, no longer imported.
- [ ] `/api/health` returns 200 with version + uptime.

---

## Stage 4 — Diagnostics and reliability

**Why now:** before adding 30+ feature prompts, the user (and you) need a glance-level health check. Any later issue diagnoses itself.

**Duration:** 2 days.

### Stage 4.1 — `/diagnostics` page

```
Read [Master Architecture Preamble]. Stages 0-3 must be complete.

GOAL: A health dashboard that lets a non-technical user (and you) tell at a
glance whether the suite is set up correctly.

FILES TO CREATE:
- reveal-sc2-opponent-main/stream-overlay-backend/routes/diagnostics.js
- A <DiagnosticsPage> component in the SPA index.html.

CHECKS (each renders one card with status, message, and an actionable fix link):

1. Python interpreter: `py --version` runs, returns >= 3.10. OK / WARN / ERR.
   Fix link: install Python.
2. sc2reader: `python -c "import sc2reader; print(sc2reader.__version__)"`.
   Note datapack max LotV build (read os.listdir of sc2reader/data/LotV/
   and find the highest NNNNN_abilities.csv). If max < 89720, WARN.
3. Replay folder: each entry in config.replay_folders — exists? readable?
   has N replays? newest replay age (last_modified).
4. meta_database.json: present, valid JSON, size, count of build keys,
   count of total games, last write time.
5. profile.json + config.json: present and validate against the schemas.
6. Battle.net character_id: resolve via /api/pulse/character/<id> (existing
   endpoint? add if missing) — returns 200 with a real character record.
7. Twitch (if enabled): GET https://api.twitch.tv/helix/users?login=<channel>
   with the configured token. 200 = OK, 401 = bad token, 403/404 = bad channel.
8. OBS (if enabled): try to connect to the configured WebSocket URL with the
   password. Quick handshake test.
9. Disk space: free bytes on the data drive. WARN below 1 GB.
10. Recent errors: tail of data/replay_errors.log + data/analyzer.log,
    showing the last 5 ERROR-level lines.
11. Macro engine version: read from config.json, compare to the value
    embedded in analytics/macro_score.py (a constant). If they differ,
    suggest a re-backfill.
12. (After Stage 7) Community-builds API reachable: GET /v1/community-builds/health.
13. (After Stage 14) Cloud opt-in queue depth: number of unflushed observations.

EACH CHECK has:
- title
- status: 'ok' | 'warn' | 'err'
- summary (one line)
- detail (optional, expandable)
- fix_action (optional): { label, kind: 'link'|'cmd'|'modal', target }

ENDPOINT:
- GET /api/diagnostics → 200 { checks: [<above>], generated_at }
- The endpoint runs the checks IN PARALLEL (Promise.all) so the page doesn't
  take 10 seconds.
- Caches for 30 seconds; "Refresh" button bypasses cache.

UI:
- Grid of status cards (3 columns on desktop, 1 on mobile).
- Each card has a status dot (green/yellow/red), title, one-line summary,
  expandable details, and a fix button if applicable.
- "Re-run all checks" button at the top.
- "Copy diagnostic bundle" button — generates a zip with profile.json
  (redacted), config.json (redacted), recent log tails, sc2reader version,
  Python version. For support tickets / GH issues.

VERIFY:
1. Open /diagnostics on a clean install → most checks fail with clear
   messages.
2. Run the wizard, then re-open /diagnostics → most checks turn green.
3. Break something on purpose (rename a replay folder) — that one card
   turns red with the right error.
4. The "Copy diagnostic bundle" actually produces a .zip with the right
   contents.

REAL DATA: every check actually runs. The "Twitch" check actually hits
Twitch's API. Don't mock any of them.
```

### Stage 4 acceptance criteria

- [ ] `/diagnostics` shows all 11+ checks, color-coded.
- [ ] Breaking a real config field flips the relevant card to red.
- [ ] "Copy diagnostic bundle" produces a real zip with redacted secrets.

---

## Stage 5 — Quick-win analyzer charts

**Why now:** the analyzer SPA is the user's daily driver. Four chart upgrades, each one day, transform every replay drawer into something dense with insight. They share the same data path (the macro breakdown endpoint) so they can ship in two PRs.

**Duration:** 1 day each, ~4 days total.

### Stage 5.1 — Active Army & Workers chart on the macro breakdown panel

```
Read [Master Architecture Preamble]. Stages 0-2 must be complete.

Add an "Active Army & Workers" chart to the existing MacroBreakdownPanel
React component in
reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html.

Source data: GET /games/:id/build-order already returns macro_breakdown.raw
with stats_events under the hood — extend the backend to also pass through
the full stats_events array (time, food_workers, food_used,
minerals_collection_rate, vespene_collection_rate). The Python side is in
SC2Replay-Analyzer/core/event_extractor.py extract_macro_events; pass
stats_events through compute_macro_score in analytics/macro_score.py so it
survives into the breakdown dict, then expose it in scripts/macro_cli.py
and read it in stream-overlay-backend/analyzer.js at the
/games/:id/macro-breakdown endpoint.

Chart: SVG line chart, two y-axes (left = army supply value via food_used*8;
right = food_workers count), x-axis = game seconds. Shade vertical bands
during supply-blocked periods (compute from food_used >= food_made - 1).
Use design tokens (Stage 1) — bg-base-800, ring-soft, text-neutral-200;
race-accent for army, info color for workers, warning at 30% opacity for
supply-block bands.

No mock data — if stats_events is empty (older replay), render the panel
with "Resource samples unavailable for this replay" instead of fake numbers.

Test: open a recent replay, click the macro score, expand the panel —
chart should appear above the discipline-metrics grid.
```

### Stage 5.2 — Full abilities-used table per player

```
Read [Master Architecture Preamble]. Stages 0-2 must be complete.

Add a per-player "Abilities Used" tab to the GamesTableWithBuildOrder drawer
in the React SPA at
reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html.
The drawer already has 'build' and 'macro' modes — add an 'abilities' mode.

Backend: extend SC2Replay-Analyzer/core/event_extractor.py extract_macro_events
to optionally return ALL ability_link → count tuples for each player (not
just the macro buckets), with chained CommandManagerStateEvent counting
like the existing chrono fix uses. Add a new /games/:id/abilities-used
endpoint in reveal-sc2-opponent-main/stream-overlay-backend/analyzer.js that
re-parses on demand and returns {me: [{name, count}], opp: [{name, count}]}
sorted by count.

Use sc2reader's bundled datapack for ability NAMES (replay.datapack.abilities),
falling back to "AbilityLink_<id>" for unknowns. Group rare abilities
(count ≤ 2) under "Other" with a tooltip listing them.

UI: two-column table (Name | Count), striped rows, hover highlight,
scrollable to ~400px. Match the existing macro-panel styling using Stage 1
design tokens.

Real data only. If sc2reader fails to parse the replay, return 500 with the
error and let the panel show "Could not parse replay: <error>". Don't paper
over failures.
```

### Stage 5.3 — APM/SPM curves over time (not just totals)

```
Read [Master Architecture Preamble]. Stages 0-2 must be complete.

Add an "Activity over time" chart to the same /games/:id/build-order drawer
in the analyzer SPA (same file as Stage 5.1).

Compute server-side in SC2Replay-Analyzer: walk replay.events, count
CommandEvent + SelectionEvent + ControlGroupEvent timestamps per second
per player, then compute a 30-second sliding-window APM and SPM. Add this
as a /games/:id/apm-curve endpoint in stream-overlay-backend/analyzer.js,
following the existing macro-cli spawn pattern. Add SC2Replay-Analyzer/
scripts/apm_cli.py.

Chart: two stacked area charts (APM and SPM, one above the other), x-axis
= game seconds. Color = race (Protoss=accent-amber, Zerg=accent-purple,
Terran=accent-blue from Stage 1 design tokens). Show both players overlaid
with 0.5 opacity. Match dark-theme.

Real data only — if the replay has no command events (corrupt), show
"Activity data unavailable" instead of empty axes.
```

### Stage 5.4 — Resource collection / unspent / spending efficiency over time

```
Read [Master Architecture Preamble]. Stages 0-2 must be complete.

Add a "Resources over time" chart, sibling to the macro breakdown panel,
in public/analyzer/index.html. Three lines per player on one chart:
 - Income rate (minerals + vespene per minute)
 - Unspent (current minerals + vespene)
 - Used in progress (mineralsUsedInProgress fields summed)

Source: stats_events already returned by extract_macro_events (per existing
fix). Plumb it through from compute_macro_score → macro_cli.py →
/games/:id/build-order.

Chart styling: 3 lines per player on a shared time axis, dotted = me, solid
= opp. X-axis time labels at 1-min intervals. Y-axis on the right shows the
"good band" (income rate target = 60-80 minerals per worker per minute).
Use design tokens.

If stats_events is empty (older format), show a placeholder explaining the
replay is too old to have resource samples; do NOT synthesize values.
```

### Stage 5 acceptance criteria

- [ ] Open any recent replay → all four charts render with real data.
- [ ] Older replays without stats_events show clear "data unavailable" messages.
- [ ] No new hard-coded color hex codes — every chart uses design tokens.

---

## Stage 6 — Race-aware macro intelligence

**Why now:** with the foundational charts in place, race-specific deep-dives become the next layer. Also makes the macro panel correct for non-Protoss replays (which it isn't currently).

**Duration:** 3-4 days each.

### Stage 6.1 — Race-aware MacroBreakdownPanel in the SPA

```
Read [Master Architecture Preamble]. Stages 0-5 must be complete.

GOAL: The macro breakdown panel currently labels everything as if the user
is Protoss. Make it switch dynamically on race:
- Zerg: shows "Inject Efficiency" + (optional) Missed Injects timeline (6.2)
- Terran: shows "MULE Efficiency" + (optional) MULE drops timeline (6.4)
- Protoss: shows "Chrono Efficiency" (current) + Chrono allocation (6.3)
- Random: render Inject + MULE + Chrono sections, but only show the section
  whose data is non-zero (i.e., the race that game actually used)

FILES TO MODIFY:
- reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html
  Look for: function MacroBreakdownPanel({ gameId, initialMacro })
  And the racePenaltyLabel logic around line 2215.

CHANGES:
1. Read race from breakdown.race (already populated by the backend).
2. Replace the single "racePenaltyLabel" with a per-race panel section.
   When the user is Random, decide which race-specific panel to render based
   on which discipline_metrics field is non-null:
     raw.injects_actual !== null  → Zerg section
     raw.mules_actual !== null    → Terran section
     raw.chronos_actual !== null  → Protoss section
3. The "What you did well" / "Where you lost economy" sections need their
   matching messages — Zerg gets "Inject cadence", Terran gets "MULE drops",
   Protoss gets "Chrono usage". The strings already exist in the file —
   make sure they're picked correctly per race.
4. The discipline metrics block should NEVER show all three when only one
   applies. Right now it might because the conditions are loose.
5. Visual: each race section gets a small race icon next to its heading,
   pulled from the existing icon registry.

ALSO: The leaks panel ("Where you lost economy") shows a hardcoded
race-mechanic leak per game. Make sure when a Random user has a Zerg game
and a Protoss game side-by-side in their table, each shows the correct
discipline.

VERIFY:
1. Find a Zerg game in the meta DB. The user is currently Protoss-only,
   so test by temporarily changing profile.race_preference to "Random"
   via PATCH.
2. Open the macro breakdown for a Protoss game — chrono section, "Chrono
   usage matched nexus uptime" message.
3. Take a pro replay (TY vs Maru) where the user-perspective is Terran,
   and manually run macro_cli compute on it to verify the JSON shape your
   panel expects to receive.

REAL DATA ONLY: the panel renders whatever the breakdown JSON says. No
fake "switch to Zerg view" toggle that synthesizes data.
```

### Stage 6.2 — Missed-injects timeline per Hatchery (Zerg)

```
Read [Master Architecture Preamble]. Stage 6.1 must be complete.

Build a "Missed Injects" chart for Zerg replays in the analyzer SPA's
MacroBreakdownPanel (public/analyzer/index.html), only rendered when
race === 'Zerg'.

Backend computation in SC2Replay-Analyzer: for each Hatchery/Lair/Hive
lifetime (we already track these as 'bases' in extract_macro_events),
build a timeline of expected inject windows (every 29s while the building
is alive) and mark each as hit (an inject CommandEvent for that target
unit_id within ±3s of the expected window) or missed.

Surface as macro_breakdown.raw.inject_timeline = [
  {hatch_id, hatch_label: "Hatch 1"|"Hatch 2"|...,
   expected: [t0, t1, ...], hit: [t0, t1, ...], missed: [t0, ...]}
].

UI: horizontal scatter plot, one row per hatchery, x = time, dot per inject
window. Green dot = hit, red dot = missed, gray = before-spawn / after-death.
Show the overall efficiency % above the chart (already have it as
raw.injects_actual / raw.injects_expected). Use design tokens.

Use the actual hatch unit_id from sc2reader to attribute injects to the
right hatch (not just "first inject = first hatch"). The macro engine
already has the data — extend it, don't recompute.

No mock data. If a replay has no inject CommandEvents, render the chart
empty with "No injects detected" — do not interpolate.
```

### Stage 6.3 — Chrono allocation by target building (Protoss)

```
Read [Master Architecture Preamble]. Stage 6.1 must be complete.

Add a "Chrono allocation" donut + table to the MacroBreakdownPanel for
Protoss replays only.

Backend: extend extract_macro_events in
SC2Replay-Analyzer/core/event_extractor.py so each chrono ability_event
records its target building name (resolved from the target_unit_id via
sc2reader's unit lookup). Plumb through to
macro_breakdown.raw.chrono_targets = [{building_name, count}, ...].

The chain-counting logic must apply: when a chrono is chained via
CommandManagerStateEvent, the target stays the same as the head SCmdEvent.
Track that with a "last_chrono_target_per_pid" map, exactly parallel to the
existing last_bucket_per_pid map.

UI: SVG donut with the top 5 targets colored by SC2 race-tech-tier
conventions (probe=blue, gateway=green, robotics=purple, etc. — pick from
a tokenized palette), table next to it with %share and absolute counts.
Place this between the "How calculated" panel and the "What you did well" /
"Where you lost economy" panels.

Real targets only. If a chrono target is unknown (sc2reader couldn't
resolve the unit), bucket it as "Unknown" — do not invent.
```

### Stage 6.4 — MULE drop timeline (Terran)

```
Read [Master Architecture Preamble]. Stage 6.1 must be complete.

Build a "MULE drops" chart for Terran replays in the analyzer SPA. Same
shape as the Missed Injects chart in Stage 6.2: horizontal timeline, one
row per OrbitalCommand/PlanetaryFortress, dot per MULE drop.

Backend: in extract_macro_events, track per-OC MULE casts (CalldownMULE,
link 92). Compute a "wasted energy" timeline per OC: for each 64s window
after OC creation, mark it green if a MULE was dropped, red if no drop
occurred AND the OC had ≥50 energy at the start of the window. Compute
energy by integrating regen since last cast (energy_max=200,
energy_per_sec=0.7875 = 200/254s typical).

Surface as macro_breakdown.raw.mule_timeline = [
  {oc_id, oc_label, drops: [t0, ...], wasted_windows: [t0, ...]}
].

UI: same scatter pattern as Stage 6.2 but with the wasted-window red dots.
Show total wasted energy seconds above the chart (sum of wasted_windows ×
80, since 80 seconds is what a MULE costs in regen).

Don't mock energy state — if OC tracking fails for a replay, render "MULE
data unavailable" rather than synthesizing drop times.
```

### Stage 6.5 — Spending efficiency curve with "leak" annotations

```
Read [Master Architecture Preamble]. Stage 6.1 must be complete.

Add a "Spending efficiency over time" chart to the macro breakdown panel.

Compute: for each stats_event sample, compute the instantaneous SQ (same
formula as analytics/macro_score.py _compute_sq, but per-sample instead
of game-average). Smooth over a 30-second window. Plumb through
extract_macro_events as stats_events[i].instantaneous_sq.

Detect leak windows: any 30-second stretch where instantaneous_sq drops
below 50 AND avg_unspent > 600. Output annotations =
[{start, end, avg_unspent, avg_income}] in macro_breakdown.raw.

UI: SVG line chart of SQ over time with "leak" red bars overlaid on the
detected windows; clicking a leak band scrolls the build-order timeline
to that timestamp and highlights the contemporaneous events. Tie this in
with the existing BuildOrderTimeline component. Use design tokens.

Real data only.
```

### Stage 6.6 — Random-race profile support

```
Read [Master Architecture Preamble]. Stage 6.1 must be complete.

GOAL: When a user picks "Random" in their profile, every UI panel that
aggregates by race needs to split metrics by race-played-that-game, not by
preferred race.

FILES TO MODIFY:
- reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html
  Components: <Overview>, <BuildsTab>, <OpponentProfile>, anywhere that
  shows aggregated metrics.
- reveal-sc2-opponent-main/stream-overlay-backend/analyzer.js
  Aggregation queries: anything that buckets games by race.

CHANGES:
1. Add a new API parameter `?group_by_race_played=1` on the existing
   /api/aggregations/* endpoints. When set, the response groups results
   into { Protoss: {...}, Terran: {...}, Zerg: {...} }.
2. The SPA reads profile.race_preference; if "Random", every aggregated
   widget (build win rates, opponent stats, macro averages) renders three
   side-by-side panels — one per race-played.
3. New widget on the home/Overview tab for Random users: "Random luck +
   performance over time" — shows
     - Race assignment frequency (P/T/Z counts)
     - Win rate per race (when assigned that race)
     - Best/worst race for them
4. When NOT Random, hide the per-race split — current layout unchanged.

VERIFY:
1. PATCH profile.race_preference to "Random" for testing.
2. Reload SPA. Overview tab shows the new Random widget. Builds and
   Opponents tabs split into P/T/Z columns.
3. PATCH back to "Protoss". UI returns to single-race view.
4. The aggregations are computed from the real meta_database.json — no
   placeholder counts.

If no Random data exists, the widget renders explanatory text: "You haven't
played any Random games yet." Don't fake data into the DB.
```

### Stage 6 acceptance criteria

- [ ] Protoss / Terran / Zerg / Random replays each render the correct discipline panel.
- [ ] Inject, Chrono, MULE timelines render real per-building data.
- [ ] Spending efficiency curve highlights real leak windows; clicking jumps to build-order timestamp.
- [ ] Random users see per-race-played splits across every aggregation widget.

---

## Stage 7 — Build classifier and custom build editor

**Why now:** the analyzer is feature-complete. Now we open the door for users to author and **share** their own builds. This stage converts custom builds from local-only (legacy Tkinter) to a **shared community database** so when one player adds a build, all players see it on next sync.

**Duration:** ~1 week.

### Stage 7.1 — Build classifier branches for Z and T

```
Read [Master Architecture Preamble]. Stage 0.1 must be complete (the build
definitions module imports cleanly).

GOAL: The build classifier currently only matches Protoss openings. Extend
it to handle Zerg and Terran builds with the same tolerance/scoring logic.

FILES:
- reveal-sc2-opponent-main/core/build_definitions.py
- SC2Replay-Analyzer/core/build_definitions.py (matching copy)
- The classifier itself — find it via:
    grep -rn "classify_build\|match_build\|BUILD_DEFINITIONS" \
      reveal-sc2-opponent-main/core/ \
      SC2Replay-Analyzer/core/ \
      SC2Replay-Analyzer/detectors/

CHANGES:
1. Audit BUILD_DEFINITIONS for race coverage. Likely it's mostly Protoss.
2. Stub Zerg and Terran sections with the structure required (don't fill
   in actual builds yet — that's Stage 8). Use 1 placeholder per matchup
   so the data shape is testable:
     "ZvT - Roach Ravager Allin": {
        "race": "Zerg", "vs_race": "Terran",
        "signature": [...],  // single placeholder; real ones in Stage 8
        "tier": "?", ...
     }
3. The classifier function should switch on the player's race in the replay
   (replay.players[me_index].play_race), then iterate only the candidate
   definitions for that race x vs_race combination.
4. If no match is found, return "Unclassified - <Race>" rather than the
   default catch-all (so the UI can show a meaningful "we don't have
   definitions for this matchup yet" hint).

VERIFY:
1. python -c "from core.build_definitions import BUILD_DEFINITIONS; print({k.split(' ')[0] for k in BUILD_DEFINITIONS})"
   Should print {'PvP', 'PvZ', 'PvT', 'ZvP', 'ZvT', 'ZvZ', 'TvP', 'TvT', 'TvZ', ...}.
2. Run the classifier on one PvP game (existing): still classified correctly.
3. Run it on a Z replay (find a friend's or use a pro replay) — at minimum
   doesn't crash and returns something coherent.

REAL DATA: don't ship the placeholder build signatures. Mark them clearly
with a TODO comment so Stage 8 finds them.
```

### Stage 7.2 — Audit existing custom-build implementation

```
Read [Master Architecture Preamble]. Stages 0-6 must be complete.

GOAL: Before building the new shared editor, document EXACTLY how the
existing custom-build feature works in the legacy Tkinter desktop app.
Read-only task — no code changes.

PROCEDURE:
1. Find every reference to custom builds in the Python codebase:
     grep -rn "custom_build\|customBuild\|CustomBuild\|create_build\|new_build" \
       SC2Replay-Analyzer/ reveal-sc2-opponent-main/core/ reveal-sc2-opponent-main/gui/
   Also look at:
     SC2Replay-Analyzer/custom_builds.json
     SC2Replay-Analyzer/data/custom_builds.json (if exists)
     reveal-sc2-opponent-main/data/custom_builds.json
     reveal-sc2-opponent-main/core/custom_builds.py (if exists)
     SC2Replay-Analyzer/core/custom_builds.py (if exists)
2. Trace the user flow end-to-end:
   a. How does the user pick a game?
   b. How is the build-order shown?
   c. How does the user mark a subset of events as "the signature"?
   d. What metadata can they enter?
   e. How is it saved?
   f. How is it picked up by the classifier?
3. Document the data shape of custom_builds.json TODAY (paste a real entry).
4. Document the existing classifier algorithm (read the function, not just
   call sites). Specifically:
   - How are events matched? (exact vs substring, time tolerance)
   - How is a "score" computed when multiple builds could match?
   - What's the minimum match confidence to assign a build name?
5. Identify gaps where the Tkinter UX is awkward and we can do better in
   the SPA. Examples to consider:
   - Editing an existing custom build
   - Renaming
   - Auto-suggesting tier from win rate
   - Showing "matches N of your past games" preview before saving
   - Bulk re-classification of historical games
   - Sharing with the community (Stage 7.3 introduces this)

OUTPUT:
Write docs/custom-builds-spec.md with sections:
  ## Current Tkinter Implementation
  ## Classifier algorithm
  ## Gaps and SPA-specific improvements
  ## Proposed data model for the SPA port
  ## API surface needed (local + community)
  ## Migration plan from existing custom_builds.json
  ## Open questions

VERIFY:
1. The doc exists and is committed.
2. Every claim about current behavior has a file:line citation.
3. Run one of the existing custom builds through the classifier on a real
   replay and document the actual matching behavior.

NO MOCKS, NO ASSUMPTIONS. If the Tkinter feature isn't actually present
(which the user thinks may be the case in some forms), document THAT
clearly. The spec writes whatever's true on disk.
```

### Stage 7.3 — Community-shared backend (canonical store + sync)

```
Read [Master Architecture Preamble]. Stage 7.2 must be complete (spec exists).

GOAL: Establish a SHARED COMMUNITY DATABASE for custom build definitions.
When one player saves a build, every other player sees it on next sync.

This is a small, dedicated cloud service. Simpler than Stage 14's full
opponent-data cloud — just a CRUD API for build definitions.

ARCHITECTURE:
- Cloud service: cloud/community-builds/  (Node + Express OR FastAPI; pick
  whichever is faster to ship — recommend Node since the rest of the
  backend is Node).
- Storage: SQLite on a small VM, OR Postgres if you're already
  provisioning one for Stage 14. Start with SQLite for simplicity; migrate
  later. File: cloud/community-builds/data/builds.db.
- Hosting: Fly.io or Railway tiny instance, ~$5/month.
- Auth: each desktop client has a salted client_id (HMAC of install_uuid).
  Authors are tracked by client_id — no real accounts needed for v1. The
  battle_tag from profile.json is sent as a display name only; the
  client_id is the authoritative author key.

DATA MODEL (SQLite):

  CREATE TABLE community_builds (
    id              TEXT PRIMARY KEY,             -- kebab-case
    name            TEXT NOT NULL,
    race            TEXT NOT NULL,
    vs_race         TEXT NOT NULL,
    tier            TEXT,                         -- S/A/B/C/null
    description     TEXT NOT NULL DEFAULT '',
    win_conditions  TEXT NOT NULL DEFAULT '[]',   -- JSON
    loses_to        TEXT NOT NULL DEFAULT '[]',
    transitions_into TEXT NOT NULL DEFAULT '[]',
    signature       TEXT NOT NULL,                -- JSON array of events
    tolerance_sec   INTEGER NOT NULL DEFAULT 15,
    min_match_score REAL NOT NULL DEFAULT 0.6,
    author_client_id TEXT NOT NULL,
    author_display  TEXT NOT NULL,                -- battle_tag or "anon"
    created_at      INTEGER NOT NULL,             -- epoch ms
    updated_at      INTEGER NOT NULL,
    deleted_at      INTEGER,                      -- soft delete
    upvotes         INTEGER NOT NULL DEFAULT 0,
    downvotes       INTEGER NOT NULL DEFAULT 0,
    flagged         INTEGER NOT NULL DEFAULT 0,   -- spam moderation
    version         INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE build_votes (
    client_id   TEXT NOT NULL,
    build_id    TEXT NOT NULL,
    vote        INTEGER NOT NULL,                 -- +1 or -1
    voted_at    INTEGER NOT NULL,
    PRIMARY KEY (client_id, build_id)
  );

  CREATE INDEX idx_builds_race ON community_builds(race, vs_race);
  CREATE INDEX idx_builds_updated ON community_builds(updated_at);

ENDPOINTS (mounted at /v1/community-builds):

  GET  /v1/community-builds/health              → 200 {ok, version}
  GET  /v1/community-builds                     → list (paginated, filterable)
       query: race, vs_race, since (epoch ms), q (search), sort (votes|recent)
       returns: { builds: [...], next_cursor: str|null }
  GET  /v1/community-builds/:id                 → single build
  POST /v1/community-builds                     → create (auth: client signature)
  PUT  /v1/community-builds/:id                 → replace (must be author)
  DELETE /v1/community-builds/:id               → soft-delete (must be author)
  POST /v1/community-builds/:id/vote            → +1 or -1 (one per client)
  POST /v1/community-builds/:id/flag            → spam report
  GET  /v1/community-builds/sync?since=<epoch>  → diff for incremental sync
       returns: { upserts: [...], deletes: [id, ...], server_now: epoch }

SECURITY:
- Every write request includes:
    X-Client-Id: hex client_id
    X-Client-Signature: HMAC-SHA256(server_pepper, body)
- Server pepper handshake: GET /v1/community-builds/handshake on first run.
- Rate limit: 30 writes/hour per client_id, 1000 reads/hour per IP.
- Author check: PUT/DELETE require author_client_id == X-Client-Id.
- Spam: builds with flagged > 5 are hidden from list responses until
  reviewed.

VALIDATION (server-side, identical to client-side schema):
- id matches /^[a-z0-9-]{3,80}$/
- name length 3..120
- race in {Protoss, Terran, Zerg}
- vs_race in {Protoss, Terran, Zerg, Random}
- tier in {S, A, B, C, null}
- signature is an array of 4..30 items
  each: t in [0, 3600], what is non-empty, weight in [0,1]
- tolerance_sec in [5, 60]
- min_match_score in [0.3, 1.0]

FILES TO CREATE:
- cloud/community-builds/package.json
- cloud/community-builds/index.js
- cloud/community-builds/migrations/001_init.sql
- cloud/community-builds/Dockerfile
- cloud/community-builds/fly.toml
- cloud/community-builds/__tests__/*.test.js  (jest + supertest)
- docs/community-builds-api.md

DEPLOYMENT:
- One-line `fly launch` from cloud/community-builds/.
- Persistent volume for SQLite at /data.
- Daily SQLite snapshot to S3-compatible (R2 or B2 free tier).

VERIFY:
1. cd cloud/community-builds && npm test → all pass
2. fly deploy → service is reachable at https://sc2-community-builds.fly.dev
3. curl https://sc2-community-builds.fly.dev/v1/community-builds/health → 200
4. POST a real build → 201 Created with the new id.
5. GET /sync?since=0 → returns the build you just created.

NO MOCKS. The service runs against a real SQLite DB, real HMAC signatures,
real Fly deployment.
```

### Stage 7.4 — Local custom-builds API + classifier integration

```
Read [Master Architecture Preamble]. Stages 7.2 and 7.3 must be complete.

GOAL: Implement the local persistence layer, REST API, and classifier
integration for user-authored build definitions. The local API is a thin
caching wrapper around the Stage 7.3 community service.

DATA SHAPE — local cache only:

data/custom_builds.json  (user's own authored builds, pending sync):
{
  "version": 2,
  "builds": [
    {
      "id": "user-pvz-stargate-into-blink",
      "name": "PvZ Stargate into Blink",
      "race": "Protoss",
      "vs_race": "Zerg",
      "tier": "A",
      "description": "...",
      "win_conditions": [...],
      "loses_to": [],
      "transitions_into": [],
      "signature": [
        { "t": 18,  "what": "BuildPylon",          "weight": 0.4 },
        { "t": 95,  "what": "BuildStargate",       "weight": 1.0 },
        ...
      ],
      "tolerance_sec": 15,
      "min_match_score": 0.6,
      "source_replay_id": "2026-04-22T18:30:00|opponent|map|600",
      "created_at": "2026-04-27T12:00:00Z",
      "updated_at": "2026-04-27T12:00:00Z",
      "author": "ReSpOnSe",
      "sync_state": "pending" | "synced" | "conflict"
    }
  ]
}

data/community_builds.cache.json  (local mirror of community DB):
{
  "version": 2,
  "last_sync_at": "2026-04-27T12:00:00Z",
  "server_now": 1234567890,
  "builds": [ ... same shape, plus upvotes/downvotes/author_display ]
}

LOCAL ENDPOINTS (mounted at /api/custom-builds/*):

  GET    /api/custom-builds                       → list ALL (custom + community
                                                     cache, deduped by id)
  GET    /api/custom-builds/:id                   → single build
  POST   /api/custom-builds                       → create from body
                                                     (writes locally + queues
                                                     a community POST)
  PUT    /api/custom-builds/:id                   → replace (must be author;
                                                     queues community PUT)
  PATCH  /api/custom-builds/:id                   → partial update
  DELETE /api/custom-builds/:id                   → remove (queues community
                                                     DELETE if author)

  POST   /api/custom-builds/from-game             → derive a draft from a
                                                     replay's events
  POST   /api/custom-builds/preview-matches       → for an unsaved candidate,
                                                     return matching games
  POST   /api/custom-builds/reclassify            → re-run classifier on all
                                                     historical games

  POST   /api/custom-builds/sync                  → pull latest from community
                                                     service, push pending
                                                     uploads
  GET    /api/custom-builds/sync/status           → last sync, pending count,
                                                     errors

  POST   /api/custom-builds/:id/vote              → +1 / -1 forwarded to
                                                     community service

FILES TO CREATE:
- reveal-sc2-opponent-main/stream-overlay-backend/routes/custom-builds.js
- reveal-sc2-opponent-main/stream-overlay-backend/services/community_sync.js
- data/custom_builds.schema.json
- SC2Replay-Analyzer/scripts/build_classify_cli.py  (if not present)
- reveal-sc2-opponent-main/stream-overlay-backend/__tests__/custom-builds.test.js

FILES TO MODIFY:
- reveal-sc2-opponent-main/stream-overlay-backend/index.js
  (mount the new router; wire Socket.io progress for /reclassify)
- reveal-sc2-opponent-main/core/build_definitions.py
  AND SC2Replay-Analyzer/core/build_definitions.py
  (load custom_builds.json AND community_builds.cache.json on import,
   merge into BUILD_DEFINITIONS with collision rule:
   built-in id wins on exact match; among customs, most recent updated_at.)
- The classifier function (location identified in 7.2's spec). Update so
  it iterates BUILD_DEFINITIONS (built-ins) AND custom builds AND community
  cache.

CLASSIFIER ALGORITHM:
For a game's event list E (sorted by t) and a build B with signature S:
  matched = 0
  for each (sig_t, sig_what, sig_weight) in S:
    candidates = [e in E where e.what == sig_what
                              and |e.t - sig_t| <= B.tolerance_sec]
    if candidates not empty:
      matched += sig_weight
  total_weight = sum(s.weight for s in S)
  match_score = matched / total_weight
  if match_score >= B.min_match_score: B is a candidate
Return the candidate with highest match_score.

SYNC WORKER:
- On startup, run a sync against the community service.
- Repeat every 15 minutes while the backend is up.
- Pending uploads are retried with exponential backoff.
- Sync conflicts (server has newer version of a build the user authored
  on two devices) get marked sync_state="conflict" and surfaced in the UI.

VERIFY:
1. cd reveal-sc2-opponent-main/stream-overlay-backend && npx jest custom-builds.test.js
2. POST /api/custom-builds with a real custom build → data/custom_builds.json
   updated atomically; sync queue has one entry.
3. POST /api/custom-builds/sync → entry uploaded; sync_state flips to
   "synced".
4. From a SECOND machine (or simulate via DELETE local cache + GET
   /api/custom-builds/sync), the build appears in the list.
5. POST /api/custom-builds/reclassify — actually runs the classifier on
   all meta_database games, streams progress, uses both built-in and
   community builds.

REAL DATA, NO MOCKS:
- Tests use real fixture replays (Stage 11 Task 11.1) if available;
  otherwise commit a single fixture for these tests.
- The reclassify endpoint actually mutates the real meta_database.json
  (with backup taken first).
```

### Stage 7.5 — SPA: "Save this build" flow + editor modal

```
Read [Master Architecture Preamble]. Stage 7.4 must be complete.

GOAL: From any game in the React SPA, the user can click "Save as build"
on the build-order timeline, opens a polished editor modal, picks a subset
of events as the signature, fills in metadata, previews how many of their
historical games match, and saves. After save, the editor offers to
"Reclassify all my games now" AND "Share with community" (default ON).

WHERE THE CTA APPEARS (every game-row drawer):
- reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html
- Find <BuildOrderTimeline> component.
- Add a primary button at the top-right of the timeline header:
  "Save as new build"
- Disabled if profile.json is missing (with tooltip linking to /settings).

EDITOR MODAL:
Component: <BuildEditorModal game, onClose, initialDraft?>

Sections:

  Section 1 — Basics
    - Name (required, 3-120 chars)
    - Description (optional, multi-line, 0-500 chars)
    - Race (auto-filled from game; user can change)
    - Vs race (auto-filled; user can change to "Random")
    - Tier (S/A/B/C dropdown, optional)
    - Tolerance (slider 5-60s, default 15)
    - Min match score (slider 0.3-1.0, default 0.6)
    - Share with community: toggle (default ON, with "Visible to all
      players" caption + privacy link)

  Section 2 — Signature events
    Two-column layout:
    Left:  the FULL build-order timeline of the source game. Each row has
           a checkbox. Default-check the "tech-defining" events (use the
           existing event_priority logic — likely buildings + key
           upgrades + first-of-each-unit).
    Right: a live preview of the SIGNATURE that will be saved.
    For each checked event:
      * Adjust weight (slider 0..1; default 1.0 for auto-chosen, 0.5 for
        user-additions)
      * Adjust target time (slider ±15s)
      * Remove from signature
    "Add custom event" lets user pick any event from the source game's
    timeline.

  Section 3 — Match preview
    - Live count: "Matches X of your Y games" (POST
      /api/custom-builds/preview-matches with the current draft).
    - Show top 5 matching games as compact rows.
    - Updates debounced (300ms).
    - If 0 matches: hint "Try lowering min_match_score or increasing
      tolerance".

  Section 4 — Save bar (sticky bottom)
    - "Cancel" (closes without saving)
    - "Save build" (POST /api/custom-builds; on 200 toast "Saved 'X'.
      Reclassify your games to apply now?" with a "Reclassify" button)
    - "Save & Reclassify" (saves then triggers
      /api/custom-builds/reclassify)
    - If "Share with community" was ON, the same Save also queues an
      upload; toast confirms "Shared with community."

DATA FLOW:
1. User clicks "Save as new build"
2. SPA POSTs /api/custom-builds/from-game with { game_id }
3. Backend returns a draft with auto-selected events
4. Modal opens with the draft
5. As user toggles events / changes thresholds, SPA POSTs to
   /api/custom-builds/preview-matches
6. On Save, SPA POSTs the full draft to /api/custom-builds
7. Backend writes locally AND queues a POST to the community service
8. Optional reclassify streams progress via Socket.io

UX POLISH:
- Esc closes; confirms unsaved changes.
- Form errors render inline.
- Tooltips on threshold sliders explain the tradeoff.
- Disable Save while a /preview-matches request is in flight.
- On successful save, toast offers "View this build" → /builds/<id>.

ACCESSIBILITY:
- Full keyboard nav (Tab, Esc, Enter to save).
- aria-labels on icon-only buttons.
- Focus trap in the modal.
- Errors announced via aria-live.

VERIFY:
1. Open a real game in the OpponentProfile games table.
2. Click "Save as new build" → modal opens with draft from real game data.
3. Toggle a few events. Match preview updates with real counts.
4. Save with "Share with community" ON → data/custom_builds.json updated
   AND a POST to community service shows up in community DB.
5. Click "Reclassify" — meta DB updates.
6. Close and re-open the SPA. The build persists.
7. From a SECOND user (or simulating via clearing community cache and
   re-syncing), the build appears in /builds → My builds → "Shared by
   <author>".

NO MOCKS:
- Match preview uses real meta DB games.
- Reclassify mutates real DB (with backup).
- Community share goes to the real Stage 7.3 service.
```

### Stage 7.6 — SPA: Custom Builds management page (with community browse)

```
Read [Master Architecture Preamble]. Stage 7.5 must be complete.

GOAL: A dedicated /builds page in the SPA where the user manages all build
definitions — built-ins, their own customs, and the community library.

NAV:
Add a sub-tab inside the existing /builds page:
  /builds → tabs: "Built-in" | "My builds" | "Community" | "Editor"

LAYOUT (My builds tab):
- Left: filterable/searchable table of the user's custom builds:
    Name | Race | vs Race | Tier | Created | Match count | Win rate |
    Sync | Actions
- Right (when a row is selected): detail panel:
    - Full signature (read-only timeline)
    - Description
    - Top 5 matching games
    - Edit / Duplicate / Delete buttons
    - Win rate breakdown by map and by opponent race
    - Sync status: "Shared (12 upvotes)" or "Pending sync" or "Local only"

LAYOUT (Community tab):
- Top: filter chips (race, vs_race, tier, sort: top|recent|trending)
- Search box
- Card grid: each card shows
    - Author display name + race icons
    - Build name + tier badge
    - Description (truncated to 2 lines)
    - Upvote/downvote arrows with count (+1 / -1 buttons)
    - "Use this build" button (clones into My builds, marked
      "from <author>")
    - "View" button → opens a read-only detail modal showing signature,
      match preview against the user's own games, top win rates from the
      author's games (if shared in their profile)
- Pagination via /v1/community-builds?cursor=...

ACTIONS (My builds):
- Edit         → opens <BuildEditorModal> in edit mode. PUT on save.
- Duplicate    → opens the editor with the build copied, name suffixed
                 " (copy)".
- Delete       → confirm dialog → DELETE /api/custom-builds/:id; if there
                 are games classified under this build, warn the user.
                 If shared, also queues community DELETE.
- Export       → download the user's full custom_builds.json.
- Import       → file picker; parses, validates, shows a diff preview,
                 commits on confirm.
- Sync now     → POST /api/custom-builds/sync, shows progress.

ACTIONS (Community):
- Use this    → copies the community build into custom_builds.json and
                marks it active.
- Vote        → POST /api/custom-builds/:id/vote with +1 / -1.
- Flag        → POST /api/custom-builds/:id/flag with a reason.

WIN-RATE COMPUTATION:
- New endpoint GET /api/custom-builds/:id/stats →
  { total, wins, losses, win_rate, by_map, by_opp_race, recent_games }

UX POLISH:
- Empty states (My builds: "Open a game and click 'Save as new build'";
  Community: "No builds match your filters. Try changing race or vs_race.").
- Sortable columns.
- Bulk actions: select multiple → delete or export.
- When a community build is one the user already imported, show a "Already
  in your library" badge instead of "Use this build".
- When clicking a "matching game" in My builds detail panel, navigate
  to that game in the games table.

VERIFY (with REAL data):
1. Create 3 custom builds via Stage 7.5's editor with "Share with community"
   ON.
2. Open /builds → "My builds" tab. All 3 listed with real counts and "Shared"
   sync state.
3. Open the Community tab. The 3 builds appear (alongside any other users').
4. Vote +1 on a community build. The count updates.
5. Click "Use this build" on a community build authored by someone else.
   It appears in My builds with "from <author>" tag and is now classifying
   the user's games.
6. Edit your own community-shared build. Saving uploads the new version
   (community service shows version: 2).
7. Export / Import works round-trip.

NO MOCKS:
- Win rates computed from real meta_database.json.
- Match counts from real classifier runs.
- Community votes hit the real Stage 7.3 service.
```

### Stage 7 acceptance criteria

- [ ] User authors a custom build → saved locally + uploaded to community service.
- [ ] Second user (or test client) sees the build in their Community tab on next sync.
- [ ] "Use this build" copies the build to local custom_builds.json and reclassifies.
- [ ] Voting and flagging round-trip to the community service.
- [ ] Sync status visible in /settings → Build classifier and in My builds table.
- [ ] Built-in / custom / community precedence rules behave as documented.

---

## Stage 8 — Build order library

**Why now:** the classifier branches and editor ship, but content is sparse. This stage seeds 8-12 strong meta builds per matchup so the classifier returns useful results out of the box.

**Duration:** 1 matchup per week, ongoing.

### Stage 8.template — `<MATCHUP>` build library

Repeat 9 times for: TvT, TvZ, TvP, ZvT, ZvZ, ZvP, PvT, PvZ, PvP.

```
Read [Master Architecture Preamble]. Stage 7.1 must be complete.

GOAL: Add 8-12 strong, current-meta build definitions for the <MATCHUP>
matchup to data/build_definitions.json. Each definition is a real build
played by pros in 2026, with verifiable signatures.

SOURCES (use real ones; don't invent):
- Spawning Tool: https://lotv.spawningtool.com/build/<MATCHUP_LOWER>/
  Filter by "professional" / "ranked diamond+".
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
  "tier": "S",
  "added": "2026-04-XX",
  "added_from": "spawningtool.com/build/...",
  "signature": [
    { "t": 18,  "what": "BuildBarracks",       "weight": 1.0 },
    { "t": 22,  "what": "BuildRefinery",       "weight": 0.8 },
    { "t": 30,  "what": "TrainReaper",         "weight": 1.0 },
    { "t": 60,  "what": "BuildOrbitalCommand", "weight": 1.0 },
    { "t": 90,  "what": "BuildCommandCenter",  "weight": 0.6 },
    { "t": 130, "what": "BuildBarracksReactor","weight": 0.7 },
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
- Tier S means top-3 win rate at GM in the current Aligulac ladder; B is
  meta-but-not-optimal; below B, don't add it.
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
Read [Master Architecture Preamble]. Stage 9.1 features must be complete.

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
Read [Master Architecture Preamble]. Stages 2.1, 4.1, 7.4 must be complete.

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
Read [Master Architecture Preamble]. Stage 11 must be complete.

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

**Prerequisites:** Stages 0-13 done. A hosting account on Fly.io or Railway. A domain name. Postgres-as-a-service or self-hosted PG.

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
├── api/                           FastAPI service
│   ├── pyproject.toml
│   ├── app/{main.py,settings.py,deps.py,routes/,models/,services/,schemas/,db/,workers/}
│   ├── alembic/versions/
│   ├── tests/
│   └── Dockerfile
├── community-builds/              from Stage 7.3 (folded in here)
├── web/                           Next.js dashboard
│   ├── app/{layout.tsx,page.tsx,opponent/[name]/page.tsx,meta/page.tsx,privacy/page.tsx}
│   ├── components/, lib/, public/
├── client_sdk/                    Python desktop client
│   ├── sc2tools_cloud/{client.py,opt_in.py,batched_uploader.py}
│   └── tests/
├── infra/{fly.toml,railway.toml,docker-compose.dev.yml,monitoring/}
└── docs/{architecture.md,privacy.md,api-reference.md,runbook.md}
```

### Stage 14.1 — Backend scaffolding and infrastructure

```
Read [Master Architecture Preamble]. Stage 13 must be complete.

Stand up the SC2 Tools Cloud backend skeleton.

Stack:
- Python 3.12, FastAPI 0.111+, SQLAlchemy 2.x async with asyncpg
- Pydantic v2, PostgreSQL 16, Redis 7, Alembic
- pytest + httpx + pytest-asyncio, ruff, mypy --strict
- OpenTelemetry (OTLP), Sentry
- Fly.io (also produce Railway config)

Read first (context only — don't import; this is a separate codebase):
- reveal-sc2-opponent-main/core/data_store.py (game record shape)
- reveal-sc2-opponent-main/data/build_definitions.json (strategy ids the
  cloud accepts)

Create cloud/api/ with structure given above. In this prompt:

1. cloud/api/pyproject.toml with all deps; lock via uv.
2. app/main.py — FastAPI, Sentry init, OTel auto-instrumentation, CORS for
   web subdomain, rate-limit middleware (slowapi or hand-rolled with Redis).
3. app/settings.py via pydantic-settings v2. Required env vars:
   DATABASE_URL, REDIS_URL, SENTRY_DSN, SERVER_PEPPER (32+ random bytes),
   ALLOWED_CLIENT_VERSIONS (csv), ENVIRONMENT, OTLP_ENDPOINT.
4. app/db/ with SQLAlchemy 2.x async pattern. Models:
   - Client(id, salted_id_hash, first_seen_at, last_seen_at,
            client_version, total_observations, opt_in_consent_version,
            banned_at, created_at)
   - Observation(id, client_id_fk, opponent_name_normalized,
                 opponent_race, observer_race, matchup, map_name,
                 strategy_id, observed_at_day, game_duration_bucket,
                 won_by_observer, region, created_at)
   - OpponentProfile(opponent_name_normalized, total_observations,
                     distinct_clients, race_distribution_jsonb,
                     strategy_distribution_jsonb, map_distribution_jsonb,
                     last_aggregated_at)
   - AggregationRun(id, started_at, finished_at, observations_processed,
                    profiles_updated, errors_jsonb)
   Indexes: Observation(opponent_name_normalized, observed_at_day);
            Observation(client_id_fk, created_at);
            OpponentProfile(total_observations DESC).

5. Alembic init + first migration.
6. app/routes/health.py — GET /health, GET /ready (db + redis ping).
   Returns build version + git SHA from env.
7. cloud/api/Dockerfile — multi-stage, non-root, healthcheck.
8. cloud/infra/fly.toml AND cloud/infra/railway.toml — production-ready
   with autoscale, persistent volumes, env var refs.
9. cloud/infra/docker-compose.dev.yml — PG + Redis + API.
10. cloud/api/tests/ — fixtures, health-check tests, factories.
11. cloud/api/Makefile (or justfile): dev, test, lint, type, migrate, seed,
    deploy.
12. cloud/docs/architecture.md (~600 words).
13. cloud/docs/runbook.md.

Quality gates:
- ruff check passes
- mypy --strict passes
- pytest passes
- docker compose up brings the stack up clean
- fly launch --no-deploy succeeds

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
     - SELECT distinct opponent_name_normalized FROM Observation
       WHERE created_at > last_finished_at
     - For each opponent: compute total_observations, distinct_clients,
       race_distribution, strategy_distribution, map_distribution.
       SQL aggregates (COUNT, COUNT DISTINCT, jsonb_agg).
     - UPSERT OpponentProfile.
     - Mark profiles below K/M as visible=false.
     - Write AggregationRun row.

2. Schedule: separate Fly machine running
   `python -m app.workers.aggregate_profiles loop`. Document tradeoffs.

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




