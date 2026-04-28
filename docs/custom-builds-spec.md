# Custom Builds — Spec for SPA Port (Stage 7.2)

> Status: read-only audit of the **current** custom-build feature on disk.
> Author: Claude (auto). Generated 2026-04-28.
> Purpose: Document exactly how custom builds work today so Stage 7.3 / 7.4
> can replace the hand-edited JSON workflow with a real shared editor in
> the React SPA. **No code changes were made by this audit.**
>
> Every claim about current behavior is anchored to a `path:line` citation
> against the working tree at audit time (commit `git rev-parse HEAD` —
> see PR for the exact SHA).

---

## TL;DR

* The **legacy Tkinter app never had a UI for authoring custom builds**.
  The user has always had to hand-edit `custom_builds.json` in a text
  editor and restart the analyzer for the change to take effect.
  Confirmed by grepping the deprecated GUI
  (`SC2Replay-Analyzer/ui/app.py.deprecated`) — zero references to
  `custom_build`, `signature`, or `Save Build` (`grep -n` returned only
  a passing comment about a one-letter race prefix at line 2006).
* The active GUI (`reveal-sc2-opponent-main/gui/analyzer_app.py`)
  imports `load_custom_builds` (line 76) but **never calls it** — the
  import is dead in that module. Custom-build matching happens in the
  parser, not the GUI.
* The matching is **first-match-wins, exact-name, time-bounded** — there
  is no scoring, no fuzzy matching, no minimum-confidence threshold.
* `custom_builds.json` lives in **two different locations** today, one
  for the legacy app and one for the merged SPA-backed pipeline. They
  drift independently.
* The SPA settings page exposes a `use_custom_builds` toggle, but
  nothing on the Python side reads it — the parser always loads the
  file unconditionally.

---

## Current Tkinter Implementation

### What the GUI exposes

The active analyzer GUI is `reveal-sc2-opponent-main/gui/analyzer_app.py`
(4229 lines, customtkinter, line 46 imports `customtkinter as ctk`).
The deprecated single-file desktop app
`SC2Replay-Analyzer/ui/app.py.deprecated` (Stage 3 retirement, see
`SC2Replay-Analyzer/ui/__init__.py:1-13`) is no longer in the import
graph.

Search for any custom-build authoring affordance in the active GUI:

```
$ grep -n "custom_build\|CustomBuild\|Add Custom\|Save Build" \
    reveal-sc2-opponent-main/gui/analyzer_app.py
76:from core.custom_builds import load_custom_builds  # noqa: E402
```

That is the **only** reference. The import is unused — there is no
button labelled "New Custom Build", no signature-marking UI, no
metadata form. The single mutation the GUI offers on the per-game
detail dialog is a free-text **rename** (`reveal-sc2-opponent-main/gui/analyzer_app.py:4166-4187`):

```
def make_custom_name_cmd(gid, old, top):
    def cmd():
        new_name = simpledialog.askstring(
            "New Build Name", "Enter new build name:", parent=top
        )
        if new_name and new_name != old:
            self.analyzer.move_game(gid, old, new_name)
            ...
```

That **only re-keys a single game inside `meta_database.json`** via
`AnalyzerDBStore.move_game` (`reveal-sc2-opponent-main/gui/analyzer_app.py:594-610`,
mirrored at `SC2Replay-Analyzer/db/database.py:330-339`). It does not
touch `custom_builds.json`. Future games of the same shape will
**still** be classified by the hardcoded race tree, not by the new
name.

The legacy `app.py.deprecated` was the same — `grep` for any
custom-build keyword returned no matches:

```
$ grep -niE "custom_build|signature|Save Build|new_build" \
    SC2Replay-Analyzer/ui/app.py.deprecated
(no output for any of those terms)
```

So **the answer to "is there an existing Tkinter UX for custom
builds?" is: no, there never was**. The user's only path today is
the file-edit-and-restart workflow.

### What the user actually does today (end-to-end)

1. **Pick a game** — the user has no in-app picker that connects a
   game to a custom-build editor. There is no "Mark this game as the
   template for a custom build" affordance anywhere in the codebase
   (verified by `grep -rn "Mark as\|Template\|new_build" --include='*.py'`).
2. **See the build order** — game-detail rendering happens in the
   browser SPA at `reveal-sc2-opponent-main/stream-overlay-backend/public/analyzer/index.html`
   (build-log endpoint at `analyzer.js:1739`
   `router.get('/games/:gameId/build-order', ...)`). Build orders are
   displayed read-only — there is no "select these events" affordance.
3. **Mark a subset of events as the signature** — **not supported**.
   The user authors a `rules` list by hand using the rule-type
   vocabulary documented in `reveal-sc2-opponent-main/core/custom_builds.py:21-27`:
   `building`, `unit`, `unit_max`, `upgrade`, `proxy`.
4. **Enter metadata** — by editing JSON. The expected fields are
   `name`, `target` (`Opponent`|`Self`), `race`, `matchup`, optional
   `description`, and `rules`. Defined in the example block at
   `reveal-sc2-opponent-main/core/custom_builds.py:28-40`.
5. **Save** — by saving the file (no atomic-write helper is invoked
   from the user side; the loader uses `json.load` and silently
   swallows parse errors at line 71-72).
6. **Pickup by classifier** — happens at parser-construction time:
   `reveal-sc2-opponent-main/core/sc2_replay_parser.py:269-271`:

   ```
   custom = load_custom_builds()
   opp_detector = OpponentStrategyDetector(custom["Opponent"])
   my_detector  = UserBuildDetector(custom["Self"])
   ```

   `load_custom_builds` reads the file once per `parse()` call (no
   caching, no watcher); the analyzer process must be **restarted** if
   the file was loaded into a long-lived process and you want it
   re-read mid-session.

---

## Data shape on disk today

There are **two** `custom_builds.json` files in the working tree:

| Path | Used by | Source line |
|------|---------|-------------|
| `SC2Replay-Analyzer/custom_builds.json` | Legacy desktop (deprecated detectors path) | `SC2Replay-Analyzer/core/paths.py:21` |
| `reveal-sc2-opponent-main/data/custom_builds.json` | Active SPA + watchers | `reveal-sc2-opponent-main/core/paths.py:42` |

Both files presently contain the same default seed (verified
byte-by-byte). The full seed at `reveal-sc2-opponent-main/data/custom_builds.json`
as of this audit:

```json
{
    "instructions": "Add custom Spawning Tool build orders here. 'target' can be 'Opponent' or 'Self'. 'race' is Zerg, Protoss, or Terran. 'matchup' can be 'vs Zerg', 'vs Protoss', 'vs Terran', or 'vs Any'. Rules types: 'building', 'unit', 'unit_max', 'upgrade', 'proxy'.",
    "builds": [
        {
            "name": "Zerg - 12 Pool (Custom Engine Example)",
            "target": "Opponent",
            "race": "Zerg",
            "matchup": "vs Any",
            "description": "Custom JSON definition of a 12 pool.",
            "rules": [
                {"type": "building", "name": "SpawningPool", "time_lt": 55},
                {"type": "unit_max", "name": "Drone", "count": 13, "time_lt": 60}
            ]
        }
    ]
}
```

### Field semantics (verified in source)

| Field | Required | Values | Source |
|-------|----------|--------|--------|
| `name` | yes | free string | used as the returned classification at `core/strategy_detector.py:96` and `detectors/opponent.py:67` |
| `target` | yes | `"Opponent"` or `"Self"` | bucketed at `core/custom_builds.py:71-73` |
| `race` | yes | `"Zerg"`, `"Protoss"`, `"Terran"`, or `"Any"` | filter at `core/strategy_detector.py:90-92` |
| `matchup` | optional (default `"vs Any"`) | `"vs Zerg"`, `"vs Protoss"`, `"vs Terran"`, `"vs Any"` | filter at `core/strategy_detector.py:91-92` |
| `description` | optional | free string | not consumed by the classifier; informational only |
| `rules` | yes (else always-true) | array of rule dicts | iterated at `detectors/base.py:39-69` |

### Rule-type vocabulary (only these 5 are honored)

Source: `SC2Replay-Analyzer/detectors/base.py:34-69` and the byte-identical
copy at `reveal-sc2-opponent-main/core/strategy_detector.py:113-150`.

| Rule `type` | Required keys | Optional keys | Semantics |
|-------------|---------------|---------------|-----------|
| `building`  | `name` | `count` (default `1`), `time_lt` (default `9999`) | At least `count` building events whose `name` matches and whose `time` is `<= time_lt` |
| `unit`      | `name` | `count` (default `1`), `time_lt` (default `9999`) | Same, for units |
| `unit_max`  | `name` | `count` (default `999`), `time_lt` (default `9999`) | **Inverted**: at most `count` units of `name` by `time_lt` (used to exclude econ-heavy variants) |
| `upgrade`   | `name` | `time_lt` (default `9999`) | Substring match: any upgrade event whose `name` *contains* the rule `name` and whose `time <= time_lt` |
| `proxy`     | `name` | `dist` (default `50`), `time_lt` (default `9999`) | At least one building of `name` with `time <= time_lt` AND distance from main base `> dist` |

Quirks worth flagging now (because the SPA editor will surface them):

* `name` is **exact match for buildings/units** (line 47 / 51 of
  `detectors/base.py`) but **substring match for upgrades** (line 60).
  This asymmetry is undocumented in the in-file `instructions` string.
* `time_lt` is **inclusive** (`<=`) despite the name reading "less
  than" (line 47, etc.).
* `unit_max` returns False if **count > rule.count**, which means
  setting `count: 0` is the only way to express "must not exist at all".
  Probably not what most users would expect.
* All times are **integer seconds** of game time, not real time.
* The `description` field is **never read by the classifier**; it
  exists only for the human reader of the JSON file.

---

## Classifier algorithm

### Top-level flow

For the **opponent** classification (the main use case in custom builds):

1. `core.sc2_replay_parser.parse_replay()` calls `extract_events()` at
   line 264 to get `(my_events, opp_events, ext_stats)`.
2. It loads custom builds at line 269 and constructs detectors (lines 270-271).
3. It calls `OpponentStrategyDetector.get_strategy_name(race, opp_events,
   matchup)` at line 274 and stores the returned label in
   `ctx.opp_strategy`.

### Inside `get_strategy_name` (custom-build branch)

`reveal-sc2-opponent-main/core/strategy_detector.py:153-167` is the entire
custom-build-matching block:

```
buildings = [e for e in enemy_events if e["type"] == "building"]
units     = [e for e in enemy_events if e["type"] == "unit"]
upgrades  = [e for e in enemy_events if e["type"] == "upgrade"]
main_loc  = self._get_main_base_loc(buildings)

for cb in self.custom_builds:
    if cb.get("race") == race or cb.get("race") == "Any":
        cb_matchup = cb.get("matchup", "vs Any")
        if cb_matchup == "vs Any" or cb_matchup == matchup:
            if self.check_custom_rules(cb.get("rules", []), buildings, units, upgrades, main_loc):
                return cb["name"]
```

(Identical structure for `UserBuildDetector.detect_my_build` at lines
410-419 of the same file, and for the legacy detector pair at
`SC2Replay-Analyzer/detectors/opponent.py:62-67` and `detectors/user.py:46-51`.)

The `check_custom_rules` body is the rule-type switch documented in the
table above (`detectors/base.py:34-69`).

### Matching semantics — the questions the prompt asked

* **Exact vs substring matching?** Exact for `building`, `unit`,
  `unit_max`, `proxy`; substring (`name in u['name']`) for `upgrade`
  only. (`detectors/base.py:60`)
* **Time tolerance?** None. Each rule carries its own `time_lt`. There
  is **no per-build "tolerance window"** like the Stage 7.4 spec
  proposes (`MASTER_ROADMAP.md:1390-1397`); this is a new concept.
* **How is a score computed when multiple builds could match?** **It
  isn't.** The detector iterates `self.custom_builds` in list order and
  returns on the **first** rule-set that passes (line 167). Order in
  the JSON file matters. There is no scoring, no tie-breaking, no
  weighting.
* **Minimum match confidence?** None. A build matches if **all** of
  its `rules` pass; otherwise it does not. Boolean.
* **What if no custom rule matches?** The function falls through to
  the hardcoded race-specific tree (lines 169+ of
  `strategy_detector.py`), and ultimately to the
  `_composition_fallback_name()` derived from the unit catalog
  (`strategy_detector.py:78-81`).

### Order of precedence (verified end-to-end)

`Custom builds → Hardcoded race tree → Composition-based fallback name`

Custom builds **always win** if they match. Returning a name that
collides with an existing hardcoded label (e.g. `"Zerg - 12 Pool"`)
silently overrides the hardcoded classification — **even for past
games on the next reclassify**.

### Verified-on-real-data trace

I picked the earliest-`SpawningPool` Zerg-opponent game in the
production `reveal-sc2-opponent-main/data/meta_database.json`:

* file: `C:\Users\jay19\OneDrive\...\Multiplayer\Acid Plant LE (420).SC2Replay`
* opponent: `JuteMonster` (Zerg) on Acid Plant LE
* result: Loss
* SpawningPool first-event time: **26 s**
* `opp_strategy` value already in the DB: `"Zerg - 12 Pool"` (set by
  the hardcoded tree at `detectors/opponent.py:107-110`)

I then reconstructed an event list from the stored
`opp_early_build_log` strings (each `"[m:ss] EventName"` parsed and
typed via `core.sc2_catalog.lookup`), loaded the actual
`reveal-sc2-opponent-main/data/custom_builds.json`, and ran the live
detector:

```
Opponent custom builds: 1
  - 'Zerg - 12 Pool (Custom Engine Example)' (race=Zerg, matchup=vs Any,
     rules=[{'type':'building','name':'SpawningPool','time_lt':55},
            {'type':'unit_max','name':'Drone','count':13,'time_lt':60}])

OpponentStrategyDetector returned: 'Zerg - 12 Pool (Custom Engine Example)'
DB-stored opp_strategy was:        'Zerg - 12 Pool'
match? False
```

Findings from this run:

1. The custom rule **did fire** — confirming that custom builds take
   absolute precedence over the hardcoded `"Zerg - 12 Pool"` label.
2. The classifier name returned **differs** from what is currently in
   `meta_database.json`. That is exactly the silent-override risk: any
   user adding a custom rule will start producing labels that conflict
   with their historical data, and **nothing reclassifies the past
   games to match**.
3. **Caveat on the trace**: the event list reconstructed from
   `opp_early_build_log` is the analyzer's already-aggregated build
   log (filtered through `build_log_lines`). It does **not include
   every `Drone` born event** — which is why the `Drone <= 13 by 60s`
   rule trivially passed. A re-run from the original `.SC2Replay` via
   `extract_events` would produce the full Drone train and might
   invalidate the `unit_max` rule. The `.SC2Replay` source file is
   not mounted in the audit environment; the user (or CI) should
   re-run the same trace through `core.sc2_replay_parser.parse_replay`
   on the original file to confirm.

---

## Gaps and SPA-specific improvements

### Gaps in the current Tkinter / hand-edit experience

1. **No UI to author a build.** The user must open `data/custom_builds.json`
   in Notepad, hand-write JSON with the right rule vocabulary, save,
   and restart the analyzer. The default seed contains a typo-prone
   instructions string that does not document the exact-vs-substring
   asymmetry, the inclusive `<=`, or the "set count: 0 to forbid" trick.
2. **No edit/rename for an existing build.** The user must mutate JSON
   in place; there is no way to safely rename or version a build.
3. **No way to mark a real game as the template** for a new build.
   Today the user has to read the game's build-order timeline, then
   manually transcribe the relevant events back into the rule
   vocabulary. The signature-event idea from the prompt has no current
   implementation surface.
4. **No tier metadata** on custom builds. The hardcoded
   `BUILD_SIGNATURES` table tracks `tier` (`"S"|"A"|"B"|"C"|"?"`,
   `detectors/definitions.py:128`) but `custom_builds.json` does not
   even define the field. The Stage 7.4 spec (`MASTER_ROADMAP.md:1310-1325`)
   adds `tier` and asks the editor to suggest one from win rate;
   today there is no such suggestion logic.
5. **No "matches N of your past games" preview** before saving. The
   user discovers — only after restarting and watching the next replay
   parse — whether their rule fires too often, too rarely, or not at
   all.
6. **No bulk re-classification.** Adding a custom build does not
   re-tag past games. The user's `meta_database.json` keeps every
   stored game under its original hardcoded label until that game is
   re-parsed individually.
7. **Two divergent files.** Both `SC2Replay-Analyzer/custom_builds.json`
   and `reveal-sc2-opponent-main/data/custom_builds.json` are loaded
   by separate code paths today. A user editing one but not the other
   gets inconsistent behavior between the deprecated GUI and the SPA.
8. **`use_custom_builds: true` SPA toggle is non-functional.** The
   wizard renders it (`public/analyzer/index.html:11496-11502`) and the
   profile schema seeds it (line 10340), but `load_custom_builds`
   never consults it (`core/custom_builds.py:54-74`). Toggling it off
   has no effect on classification today.
9. **Silent error swallowing.** Both `initialize_custom_builds` and
   `load_custom_builds` `print()` and continue on JSON errors
   (`core/custom_builds.py:51, 71-72`). A user with malformed JSON
   gets no visible signal; the file is just silently ignored.
10. **No atomic write.** The legacy initializer does
    `open(..., 'w')` + `json.dump` (no tmp+fsync+rename), violating
    the engineering standard listed in the master preamble. The
    merged code at `core/custom_builds.py:50` does call
    `atomic_write_json`, but there is no equivalent for user-driven
    saves because there is no save endpoint.

### Concrete SPA improvements to land in Stage 7.4

* Inline editor in the SPA (single-file `index.html` component)
  scoped to `/analyzer/builds/edit/:id`.
* "Derive from this game" button on the game-detail dialog that
  pre-fills the rule list from the game's actual events.
* Autosave to `data/custom_builds.json` via a new
  `POST /api/custom-builds` endpoint that calls `atomic_write_json`
  and emits a Socket.io event so other tabs reload.
* "Matches N of your past games" preview, computed by replaying the
  candidate rule list against `meta_database.json` events on save.
* "Reclassify all" command that re-runs the classifier on every
  stored game and writes diffs back via `analyzer.move_game` (or a
  new bulk variant).
* Tier and `vs_race` metadata fields on the new shape (matching
  `MASTER_ROADMAP.md:1310-1325`).
* Wire the existing `use_custom_builds` toggle to actually gate
  `load_custom_builds()` so the profile flag is honored.

---

## Proposed data model for the SPA port

The roadmap (`MASTER_ROADMAP.md:1305-1335`) already drafts a v2 shape;
this section reproduces it for the audit and notes departures from
the v1 file currently on disk.

```jsonc
{
  "version": 2,
  "builds": [
    {
      "id": "user-pvz-stargate-into-blink",   // NEW: stable url-safe id
      "name": "PvZ Stargate into Blink",      // existing
      "race": "Protoss",                       // existing
      "vs_race": "Zerg",                       // NEW: replaces "matchup"
      "tier": "A",                             // NEW: S|A|B|C|null
      "description": "...",                    // existing
      "win_conditions": [],                    // NEW: optional notes
      "loses_to": [],                          // NEW: optional notes
      "transitions_into": [],                  // NEW: optional notes
      "signature": [                           // NEW: replaces "rules"
        { "t": 95, "what": "BuildStargate", "weight": 1.0 }
      ],
      "tolerance_sec": 15,                     // NEW: per-build window
      "min_match_score": 0.6,                  // NEW: scoring threshold
      "source_replay_id": "...|opponent|map|600",  // NEW: provenance
      "created_at": "2026-04-27T12:00:00Z",
      "updated_at": "2026-04-27T12:00:00Z",
      "author": "ReSpOnSe",
      "sync_state": "pending|synced|conflict"  // NEW: cloud-sync state
    }
  ]
}
```

Departures from today's v1 shape (`reveal-sc2-opponent-main/core/custom_builds.py:28-40`):

* `target` (`Opponent`/`Self`) is **dropped**. Stage 7.4 keys
  classification by `(race, vs_race)` so the same build can be matched
  for either side.
* `matchup: "vs X"` becomes the cleaner `vs_race: "X"`.
* `rules` (named-thing predicates) becomes `signature` (timed
  events with weights), so the classifier can score partial matches
  instead of all-or-nothing booleans (`MASTER_ROADMAP.md:1390-1397`).
* All fields are now strict-typed for ajv validation
  (`docs/custom-builds.schema.json` to be created in 7.4).
* `id` is canonical for community-sync deduplication.

---

## API surface needed (local + community)

### Local (`/api/custom-builds/*`, served by Express)

Lifted from `MASTER_ROADMAP.md:1346-1383`:

* `GET    /api/custom-builds` — list all (custom + community cache, deduped by `id`)
* `GET    /api/custom-builds/:id` — single build
* `POST   /api/custom-builds` — create from body (writes locally + queues community POST)
* `PUT    /api/custom-builds/:id` — replace (must be author; queues PUT)
* `PATCH  /api/custom-builds/:id` — partial update
* `DELETE /api/custom-builds/:id` — soft-delete (queues DELETE)
* `POST   /api/custom-builds/from-game` — derive a draft from a replay's events
* `POST   /api/custom-builds/preview-matches` — for an unsaved candidate, return matching games
* `POST   /api/custom-builds/reclassify` — re-run classifier on all historical games
* `POST   /api/custom-builds/sync` — pull latest from community service, push pending uploads
* `GET    /api/custom-builds/sync/status` — last sync, pending count, errors
* `POST   /api/custom-builds/:id/vote` — +1/-1 forwarded to community service

All POST/PUT/PATCH bodies validated server-side via ajv against
`data/custom_builds.schema.json` (per master preamble security rule).

### Community (`/v1/community-builds/*`, hosted Fly service)

Lifted from `MASTER_ROADMAP.md:1234-1263`:

* `GET  /v1/community-builds/health`
* `GET  /v1/community-builds` (paginated, filterable: `race`, `vs_race`, `since`, `q`, `sort`)
* `GET  /v1/community-builds/:id`
* `POST /v1/community-builds` (HMAC-signed)
* `PUT  /v1/community-builds/:id` (author check)
* `DELETE /v1/community-builds/:id` (soft-delete, author check)
* `POST /v1/community-builds/:id/vote`
* `POST /v1/community-builds/:id/flag`
* `GET  /v1/community-builds/sync?since=<epoch>` (incremental diff)

Auth: `X-Client-Id` + `X-Client-Signature` (HMAC-SHA256 with a
server-issued pepper). Rate limits: 30 writes/hour per client_id,
1000 reads/hour per IP. Source: `MASTER_ROADMAP.md:1252-1259`.

---

## Migration plan from existing custom_builds.json

### Inventory at audit time

* `SC2Replay-Analyzer/custom_builds.json` — 915 bytes, 1 default build
  (`Zerg - 12 Pool (Custom Engine Example)`), v1 shape.
* `reveal-sc2-opponent-main/data/custom_builds.json` — 915 bytes,
  identical content to the legacy file.

### Migration steps (Stage 7.4)

1. **Choose the canonical file.** `reveal-sc2-opponent-main/data/custom_builds.json`
   wins. The legacy `SC2Replay-Analyzer/custom_builds.json` becomes
   read-only and is loaded only as a fallback if the canonical file
   does not exist. This matches the engineering preamble rule that
   the deprecated GUI is no longer in the import path.
2. **Add a one-shot migrator** at `scripts/migrate_custom_builds_v2.py`
   that reads the current file and emits the new shape:
   * Each build gets a deterministic `id =
     slugify(name)` (collisions: append `-2`, `-3`, ...).
   * `matchup: "vs Zerg"` → `vs_race: "Zerg"`. `vs Any` becomes the
     three-element list `["Protoss", "Terran", "Zerg"]` exploded
     into three builds OR carried as `vs_race: "Any"` with classifier
     support for that token (decide before 7.4 — see Open Questions).
   * `rules` → `signature` translation:
     * `building` / `unit` rule → `{t: time_lt, what: "Build" + name,
       weight: 1.0/N}` where N is the rule count.
     * `upgrade` rule → `{t: time_lt, what: "Research" + name, weight: 1.0}`
       (substring matching is dropped; will need a fuzzy lookup table).
     * `unit_max` and `proxy` rules → **flagged for manual review**
       in the migration report. The new scoring model has no direct
       equivalent for "must-not-exist" or geometric predicates;
       Stage 7.4 needs a decision.
   * `target: "Opponent"` → default `target` is omitted (matched on
     opponent events). `target: "Self"` → carried as a top-level
     boolean `is_self_build: true`.
   * `tier`, `created_at`, `updated_at`, `author`, `sync_state:
     "pending"` are populated with defaults: `tier: "?"`, both
     timestamps `now()`, `author: profile.json.display_name or "local"`,
     `sync_state: "pending"`.
3. **Backup and atomic write.** Before mutating, the migrator writes
   `data/custom_builds.json.pre-v2-bak.<ts>` (mirrors the existing
   `pre-stage22-bak` / `pre-restore-...` convention used elsewhere in
   `data/`). The migrated file is written via `atomic_write_json`.
4. **Loader compat.** `core/custom_builds.py` learns to read both v1
   and v2 by checking the top-level `version` key. v1 files trigger
   an in-memory upgrade with a one-time WARN log and a UI banner
   prompting the user to confirm the auto-migration.
5. **Down-migration / rollback.** If the user reverts to the previous
   release, the loader at the previous version still reads v1 only.
   The migrator therefore preserves the original file under
   `.pre-v2-bak.<ts>`; rollback = restore that file. This satisfies
   the engineering-DoD "Migrations tested forward AND backward on a
   copy of prod data" line.

---

## Open questions

1. **`vs Any` semantics.** Should the v2 classifier expand `vs Any`
   to three concrete builds (one per opponent race), or should it
   support an `vs_race: "Any"` sentinel? Three concrete builds gives
   the community DB cleaner search; `Any` is closer to what users
   expect when they author a build.
2. **`unit_max` rule type — keep or drop?** The new scoring model has
   no notion of negative rules. Options: (a) attach `weight: -1` and
   penalise the score, (b) keep `unit_max` as an out-of-band gate
   that disqualifies the candidate before scoring, (c) drop it and
   rewrite the affected built-ins to use only positive rules.
3. **`proxy` rule type — keep or drop?** Same question, plus the
   community DB has to store the geometry threshold (`dist`, default
   50). Rules-with-geometry are awkward to share when mappers
   redesign maps. Suggestion: derive proxy state at parse time and
   emit a `BuildProxyStargate` event-token so the signature stays
   purely event-based.
4. **Substring vs exact for upgrades.** Today `upgrade` rules are
   substring-matched (`detectors/base.py:60`). Migrating to exact-event
   matching breaks any build that relied on `name: "Glaive"` to match
   `"AdeptPiercingAttack"`. Need a lookup table from
   nickname → canonical event token before migration.
5. **Re-classification UX.** Reclassifying every past game when a new
   custom build is added can rewrite tens of thousands of entries.
   Should this happen automatically (with a Socket.io progress bar),
   on demand only, or with a user prompt per N games changed?
6. **Author identity / device id.** Stage 7.3 uses HMAC and a per-
   device `client_id`. We do not yet have a device-id generator; one
   needs to land in Stage 7.4 (or earlier) and be stored in
   `profile.json` so author checks work across restarts.
7. **Conflict resolution on sync.** `sync_state: "conflict"` is a
   declared state in the roadmap shape, but the merge UX is not yet
   spec'd. Probably needs its own ADR before 7.4 ships.
8. **Two divergent files today.** Should the legacy
   `SC2Replay-Analyzer/custom_builds.json` be deleted as part of
   the migration, kept as a one-way fallback, or migrated as a
   second source then archived? The legacy detectors path
   (`detectors/opponent.py`, `detectors/user.py`) still imports
   `load_custom_builds` from `detectors.definitions` and would need
   to be updated or formally deprecated.

---

## Verification log

* Doc exists: this file at `docs/custom-builds-spec.md`.
* Every "current behavior" claim above is anchored to a `path:line`
  citation against the working tree at audit time.
* Real-data classifier trace: see "Verified-on-real-data trace"
  section. The `.SC2Replay` source file is not mounted in the audit
  sandbox (path on the user's Windows machine), so the trace was run
  against the analyzer's already-extracted event log stored in
  `meta_database.json`. A full end-to-end re-run on the original
  `.SC2Replay` is recommended as a follow-up to confirm the
  `unit_max` Drone-count rule under the full event train.
