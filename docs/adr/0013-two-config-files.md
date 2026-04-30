# ADR 0013 — Two config files: overlay.config.json + data/config.json

Status: Accepted (no code change)
Date: 2026-04-30
Owner: backend infrastructure

## Context

During the engineering pass that landed the Settings UI rework I
flagged "two config files" as a potential bug (task #20 in the working
list). On closer audit they are NOT duplicates. They hold complementary
concerns and the runtime layers them deliberately.

This ADR documents the intent so future readers don't repeat the
miscategorisation, and so anyone adding new fields knows which file to
put them in.

## The two files

### `stream-overlay-backend/overlay.config.json`

**Owner:** legacy / advanced power-user file. Edited by hand. Loaded by
`index.js#loadConfig()` from `__dirname/overlay.config.json` and
deep-merged onto `DEFAULT_CONFIG` defined in `index.js`.

**Holds:**

- `events.*` -- per-widget-event behaviour (`durationMs`, `priority`,
  `minGames`, `minSamples`, `cheeseMaxSeconds`, etc.) for all 14
  overlay events: matchResult, opponentDetected, rematch,
  cheeseHistory, streak, rankChange, mmrDelta, favoriteOpening,
  bestAnswer, postGameStrategyReveal, metaCheck, rivalAlert,
  scoutingReport, session.
- `sounds.{enabled, volume}` -- master sound effects toggle.
- `twitch.enabled` -- master gate for `startTwitch()`. The bot also
  needs the three `.env` vars (TWITCH_USERNAME, TWITCH_OAUTH_TOKEN,
  TWITCH_CHANNEL) to actually run, but this flag short-circuits the
  attempt entirely. Flip to `false` to silence the bot without
  removing creds.
- `session.{idleResetMs, mmrEstimate.{winDelta, lossDelta}}` --
  session tracker tuning.
- `pulse.{enabled, apiRoot, queue, fetchDelayMs, freshSeconds, retryDelayMs}`
  -- SC2Pulse polling configuration.
- `pulse.characterIds[]` -- **explicit override slot** for
  SC2Pulse character IDs. Default empty array. When non-empty, takes
  priority over both `character_ids.txt` and the wizard-saved IDs in
  `data/config.json`. Used by power users who want to hardcode IDs
  for testing or multi-account scenarios.

### `reveal-sc2-opponent-main/data/config.json`

**Owner:** wizard + Settings UI. Created by the first-run wizard
(`Wizard` component in `index.html`); subsequently edited by the
Settings page (PATCH /api/config) and validated against
`data/config.schema.json`.

**Holds:**

- `version, paths.{sc2_install_dir, replay_folders}` -- onboarding
  outputs.
- `identities[]` -- multi-region BattleNet accounts (one entry per
  region with `name, character_id, account_id, region, battle_tag,
  pulse_id`). Surfaces in the Settings -> Profile tab.
- `macro_engine, build_classifier` -- analyzer toggles.
- `stream_overlay.{enabled, twitch_channel, obs_websocket,
  pulse_character_ids}` -- wizard-saved overlay subset.
- `telemetry.opt_in, ui.{theme, default_perspective}` -- preferences.

## The deliberate layering

For SC2Pulse character IDs the runtime resolves in priority order
(`ensurePulseInitialized` in `index.js`):

```
1. overlay.config.json -> pulse.characterIds       (explicit override)
2. character_ids.txt                                (PowerShell scanner)
3. data/config.json -> stream_overlay.pulse_character_ids  (wizard)
```

For the Twitch bot:

```
- overlay.config.json -> twitch.enabled  must be true
  AND
- env: TWITCH_USERNAME + TWITCH_OAUTH_TOKEN + TWITCH_CHANNEL must all be set
```

`data/config.json -> stream_overlay.twitch_channel` is wizard-written
but currently unread by the runtime. The Settings UI surface for it
was removed in `settings-pr1k` (the bot is .env-driven for the
project owner; no other user is expected to wire it up).

## Decision

Keep both files. Do NOT merge them. The split is meaningful:

- Behaviour knobs (event timings, polling intervals, master flags) live
  in `overlay.config.json` because they are file-edit-only by intent.
  Surfacing them in the Settings UI would clutter the surface for
  fields that 99% of users never touch.
- User-setup data lives in `data/config.json` because it is
  schema-validated, wizard-written, and edited via the Settings UI on
  every install.

## Where to put new fields

- **Is it a knob a power user might tune via file edit (timings,
  thresholds, intervals)?** -> `overlay.config.json` + add the
  default value to `DEFAULT_CONFIG` in `index.js`.
- **Is it user setup (a path, an identity, a preference) that the
  wizard or Settings page should write?** -> `data/config.json` +
  add to `data/config.schema.json` + extend the wizard /
  `SettingsActivePanel` accordingly.
- **Is it a credential (token, password)?** -> `.env`. Never JSON.

## Why I almost merged them

The earlier framing in this engineering pass implied both files held
the same concept under different keys. That was wrong. The two
SC2Pulse character ID slots LOOK like duplication but are actually a
priority chain: the legacy file is the override, the new file is the
default. Same for `twitch.enabled`: the file flag is the master gate,
the .env vars are the credentials. Two layers, both required.

A merge would have:
1. Surfaced 14 advanced behaviour knobs in the Settings UI as toggles
   the user has to confront.
2. Forced a schema bump.
3. Required a migration script for every existing install.
4. Removed the file-edit override path that power users rely on.

None of those are wins.

## Consequences

- No code change in this ADR. Files stay separate.
- Future devs adding new fields use the decision matrix above to pick
  the right file.
- The "Reconcile two config files" item (#20 in the working task list)
  is closed as **resolved by documentation**. No bug exists; the
  earlier framing was a category error on my part.

## Follow-ups (separate concerns)

- **`overlay.config.json` schema.** Currently has no JSON schema
  partner. If the file gets corrupted (same partial-write incidents
  the data/ files hit), the app silently falls back to
  `DEFAULT_CONFIG`. Worth giving it a schema and routing through
  `lib/datastore.js`. Filed as a follow-up to ADR 0012.
- **`twitch.enabled` semantics.** The flag's meaning ("attempt to
  start the bot") is correct, but the documentation in
  `index.js#startTwitch()` could be clearer about the .env interaction.
  One-line comment update; not blocking.
