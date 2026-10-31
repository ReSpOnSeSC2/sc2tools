# Glossary consumers: the remaining migration (October 31 UTC)

Roadmap item `glossary-and-infotip` (ledger ordinal 71) still asks to
"Reconcile remaining MechanicsPanel, build W-L and overlay-token consumers plus
table-header title warning/ratchet named by the original spec". The plan's
step 4 (`docs/handoff/plan/final-plan.json`, item `glossary-and-infotip`) says:
migrate Opponents headers, the Macro KPI row, MechanicsPanel, build W-L rows
and overlay token text, and add a warning for `title=` in `components/analyzer`
table headers. The first two slices (PRs 768 and 776,
`docs/handoff/glossary-infotip-checkpoint.md`,
`docs/handoff/glossary-stats-expansion-checkpoint.md`) did the Opponents
headers and the Macro KPI row. This slice does the rest. Paths are under
`apps/web`.

## What changes

| Consumer | Now |
| --- | --- |
| MechanicsPanel (game page and shared replay page) | Each label carries its `InfoTip` inside its `dt`: Macro score (`macro-score`), SQ (`spending-quotient`), APM (`apm`, replacing the hover title), Supply blocked (`supply-blocked`), the race mechanic bar (`mechanic-efficiency`, named after the race's label, such as "About Inject Efficiency"), Creep tumors (`creep-tumors`) and Float spikes (`float-spikes`). No value, missing-data state or score band changes. |
| MechanicsPanel's float row | The label is "Float spikes", as on the Macro KPI row and in the glossary, instead of "Mineral float". The copy states the measured rule, "more than 800 minerals banked from 4:00", instead of "800+ ... after 4:00", and zero reads "No float spikes recorded." instead of claiming the bank stayed spent, which zero samples do not prove. |
| MechanicsPanel's supply row | The tip is left out when an older payload's windows lack `blocked_sec`, so the total adds whole window spans, which the definition (credited seconds) does not describe. The number is unchanged. |
| Builds tab table | The WR header (`build-stats-win-rate`) uses SortableTh's `info` slot; the W/L split header (`build-record`) keeps its exact column name. "incl. N check-ins" uses `Term` (`counted-checkins`) instead of a hover title, and clicks on its tip or inside the open definition do not open the build editor. The WR and W/L split columns are wider (7rem and 9.5rem; table minimum 44rem, or 50rem with Plan held) so each header fits its 44px button. |
| Overlay settings widget cards | Best answer (`best-answer`) and Session record (`overlay-session`) carry a tip beside their heading, outside the `h4`. |
| Session record's summary | It said "today's games", but the session splits on inactivity and midnight does not reset it (`apps/api/src/services/games.js`, the `overlay-session` definition). It now reads "your current session's games". The same summary feeds `/stream-studio/learn` and command search. |
| Opponents table, opponent build caption | It said "Planned" for `oppStrategyPlanned`, which is an applied opponent correction (`apps/api/src/services/buildIntentReaders.js`). It now says "Corrected", as the game page's badge does. |
| The header-title warning | The UI lint ratchet's new `analyzer-header-title` rule rejects a native `title` on a `th`, on `SortableTh` (direct, aliased or namespace imports) or on any element written inside a `th`, under `components/analyzer` (`scripts/ui-lint/rules.mjs`, `scripts/ui-lint/README.md`, `docs/design-system.md`). It replaces the plan's ESLint warning: `next lint` runs without `--max-warnings`, so a warning would never fail CI, and the ratchet blocks each new occurrence without ignore comments. The 14 existing occurrences are recorded in `scripts/ui-lint/baseline.json`. |

## Not migrated, and why

- **`title-token`.** The web app has no stream-title editor: the desktop app
  edits titles, and the tokens are documented only in the
  `desktop-stream-titles` help article, which is the term's own Learn more
  target. The Twitch Prediction title variables and the chat-command
  variables mean different things. There is no consumer to wire.
- **Builds library cards and the custom-build dossier.** Their win rate and
  record are lifetime counts for the build, with decided games as the
  denominator. `build-record` ("in the selected filters") and
  `build-stats-win-rate` (all matching records) do not describe them, and no
  catalog term does.
- **Planned and Corrected badges** keep their per-game title, which names the
  detected label that a definition cannot supply. Several sit inside toggle
  buttons, where a tip would nest a button. They are not part of the plan's
  migrate-first list.
- **The Builds tab on phones.** The card list has no header row, so the WR and
  W/L tips are on the desktop table only; the check-ins tip works on both.
- **The 14 baseline header titles**, now blocked from growing:
  OpponentHistory's W and L, NetMmrRaceOpponentsModal's Taken and Lost,
  OpponentRaceMmr's Season games, TimelineControls' metric headers, full-name
  titles on truncated names in BuildMatchupHeatmap (two), BuildMatrix (two),
  OppMmrBucketGamesModal and CasualtySnapshot, StrengthAdjusted's help link and
  MapPeriodHeatmap's low-sample chip.
- **APM's "Not measured" reason** keeps its title. It is a missing-data reason,
  not a definition, and it is wrong on the shared replay page, where the public
  API never sends APM; that needs its own fix.

## Verification

- Related tests pass with one worker: the game, settings, public-profile and
  stream-studio folders, the Builds and Opponents analyzer tests, InfoTip,
  SortableTh and the glossary id check (135 files, 1106 cases). New cases cover
  each tip, lazy definitions, the span-built supply total, the float copy, the
  Builds header names and row clicks, the overlay card tips and the Corrected
  caption.
- The UI lint rule tests pass (24), and `ui:lint` passes with only the 14 new
  allowances. Lint reports nothing on the changed files; whole-web types pass.
- No real-browser check.
