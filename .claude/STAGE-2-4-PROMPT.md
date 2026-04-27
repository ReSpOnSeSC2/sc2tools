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
