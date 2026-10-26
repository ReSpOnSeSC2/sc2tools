# Settings registry and grouping — source-only A1

Date: 2026-10-26. Branch: `codex/wave5-settings-registry`, starting at
`c1d0abd5`. This is stage A1 of the `find-anything` item in
`docs/handoff/plan/final-plan.json`, including its Settings IA augment.
The complete roadmap item remains unfinished.

## Current boundary

Source is authored; **no tests, types, lint, generators, production build,
budget checks or browser cases have run for this pack**. The runtime slot is
held by another pack. No Git mutation, provider operation or real account
request was performed. Existing owner files, caches and screenshots remain
untouched and unexecuted.

Before edits, the exact owned manifest and original per-file byte/SHA-256
inventory were recorded in:

- `.cache/settings-registry-owned-paths.txt`
- `.cache/settings-registry-original-sha256.json`

The manifest contains 22 paths. The parent approved the four narrow additions
before their original hashes were recorded and before they were edited:
the Help link validator, Notification preferences' dirty publisher, the
Account loading error label and its corresponding existing test assertion.

## Authored behavior

- A pure `lib/settingsRegistry.ts` owns canonical IDs, groups, labels,
  descriptions, aliases and visibility helpers. It imports no UI, panel or
  transport module. `SettingsShell` retains its previous helper/type exports
  for existing callers; page wiring imports the pure leaf.
- Account replaces Foundation; Preferences replaces Misc. Query aliases
  `foundation → account`, `misc → preferences` and `streaming → overlay`
  remain valid. Hash-only aliases resolve to canonical tab query values.
  Unknown values still fall back; section hashes and extra parameters keep
  their existing handling.
- The desktop sidebar groups Account/Profile/Backups & data, then
  Build check-in/Randomizer/Import, then Overlay/Voice, followed by Preferences
  and Help. Descriptions accompany each tab. Devices is a real `/devices`
  link in Account, and the existing Account quick link remains available on
  phones. There is no inactive Chat or Search control.
- Desktop tab triggers remain direct siblings of one tab list. CSS grid
  positions them among sibling group headings and the Devices link; those
  non-tab elements are outside the tab list's ownership. The tab list uses
  `display: contents`. This needs actual-browser accessibility-tree,
  computed-style, placement and native keyboard proof before approval.
- Mobile retains the scrolling tab row, roving tabindex, panel IDs,
  Left/Right/Home/End activation and existing edge hints. Desktop arrows
  continue across group boundaries. All panels retain their existing eager
  or dynamic imports and permission gates.
- Both the main Preferences form and the nested Notification preferences
  form publish under `preferences`, with separate dirty sources. Existing
  save endpoints, payloads, token behavior, request lifecycle, beforeunload
  handling and discard confirmation remain unchanged.
- The Help link validator normalizes aliases before checking canonical
  visibility. `isSettingsTabId` remains a canonical-only type guard. Old Help
  links are kept, and the renamed Preferences how-to retains its published
  heading anchor.

## Authored coverage — unrun

Pure registry cases cover group placement/order, canonical IDs, three
aliases, hash names, unknown/prototype names and visibility filtering.
Existing consumer suites were extended for page aliases, eager Account and
lazy Preferences, legacy hashes, fallback, grouping descriptions, valid tab
ownership, cross-group arrows and mobile Home/End behavior.

Real Preferences and Notification forms are used in draft tests: stay keeps
the draft, discard switches without a save request, and resetting one form
must not erase the other's dirty guard. Existing Overlay multi-form tests
remain unchanged and are part of pending integration validation.

`tests/e2e/settings-registry-fixture.mjs` mounts the actual SettingsShell,
registry, SettingsContext and shared confirmation Modal. Typed synthetic
panels use an intercepted GET-only local transport. It replaces no shared
focus or dialog code. Install prompting is stubbed because it is unrelated
to grouping. Every external or non-GET request is denied and recorded; no
real account, provider or clipboard operation is available.

`tests/e2e/settings-registry.spec.ts` authors six cases: Light and Dark in
the existing phone, tablet and desktop projects. It checks actual resolved
palette tokens and bundled local fonts, the visible tab list,
description/group placement, real tab ownership, `display: contents`,
native Tab plus arrow/Home/End navigation, legacy URL admission, dirty-dialog
focus containment/Escape, preserved drafts, canonical click URLs, section
flash, clean revisit, exact eight synthetic panel reads, full shared AA
including contrast and body bounds. Screenshots default to a new timestamped
`.cache/settings-registry-browser-*` directory; `SETTINGS_SHOTS_DIR` can point
to a new cache-only evidence directory. There are no original screenshot
writes or axe exclusions.

## Pending serialized verification

1. Review the frozen source and manifest first. Run focused registry,
   SettingsShell layout/URL/Import/anchor, SettingsMisc, Settings page,
   settings-link, Help-article and existing unavailable-state suites; include
   unchanged SettingsContext and Overlay multi-form guards. Maximum two
   unit workers, minimum one.
2. Whole web types via
   `node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json`.
   Strict lint only owned TS/TSX/MJS sources. Run the existing deterministic
   Help index generator and Help contracts, then UI-rule tests and the UI
   ratchet. No new debt acceptance or baseline waiver is authorized.
3. After source review and an explicit runtime grant, use current admitted
   engine/sample assets for one direct Next production build, unchanged
   performance budgets and post-build types. No engine regeneration,
   installer, SC2 launch or account operation is needed for this pack.
4. Run `settings-registry.spec.ts` with one browser worker and the existing
   `PW_CHROMIUM_EXECUTABLE` pinned Chrome support. The authored fixture uses
   that fresh build's CSS and local fonts. Preserve any RED artifacts, report
   real product failures, and review phone/desktop captures before claiming
   completion.

## Remaining roadmap stages

Chat extraction/token ownership, section navigation and Settings search,
public guide search, the command palette, shortcuts, recent-route storage
and private quick-search APIs remain separate stages. This pack does not
claim their delivery or change their server cost, privacy or auth contracts.
