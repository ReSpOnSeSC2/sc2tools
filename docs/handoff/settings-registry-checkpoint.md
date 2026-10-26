# Settings registry and grouping — A1 verification boundary

Date: 2026-10-26. Branch: `codex/wave5-settings-registry`, starting at
`c1d0abd5`. This is stage A1 of the `find-anything` item in
`docs/handoff/plan/final-plan.json`, including its Settings IA augment.
The complete roadmap item remains unfinished.

## Current boundary

The parent completed the first unit/static stage described below. The later
loopback fixture/spec repair is **source-only and unrun**; its types/lint and
actual browser behavior still need validation. No production build, budget
check or browser case is claimed for this pack. Runtime is held by the Header
pack. This source-only follow-up performed no runtime, Git mutation, provider
operation or real account request. Existing owner files, caches and original
screenshots remain untouched and unexecuted.

Parent-reported first static proof, preserved under
`.cache/settings-first-static-82a82898/`:

- Final focused pack: 210 tests across 22 suites passed; whole web types passed.
- Strict lint: 20 owned files passed with zero warnings. SettingsShell has one
  inherited mobile delegated-keydown `jsx-a11y/interactive-supports-focus`
  warning, proved unchanged from pre-A1 `c1d0abd5`; the separate audit is
  `inherited-shell-lint.json`. No new waiver or baseline debt was added.
- Help: 90 tests and read-only deterministic generation passed. UI: 19 rule
  tests, 1,696 scanned files and 646 existing allowances passed.
- Two narrow parent fixes are included: remove the new literal hash-only
  Settings URL example from Help prose to satisfy the existing link guard,
  and expose the real boundedApiRequest utility in the Overlay multi-form
  suite's transport mock. Original assertions remain; the affected 28 tests
  and then the full 210-test pack passed. RED logs and source copies remain.

Before edits, the exact owned manifest and original per-file byte/SHA-256
inventory were recorded in:

- `.cache/settings-registry-owned-paths.txt` (original 22)
- `.cache/settings-registry-original-sha256.json` (original 22)
- `.cache/settings-registry-devices-owned-paths.txt` (current 23)
- `.cache/settings-registry-devices-original-sha256.json` (current 23)

The original manifest contains 22 paths. The parent approved the four narrow additions
before their original hashes were recorded and before they were edited:
the Help link validator, Notification preferences' dirty publisher, the
Account loading error label and its corresponding existing test assertion.
Source at `8ed58639` and its original frozen receipt
`.cache/settings-registry-source-only-sha256.json` are preserved. Independent
review then found that the existing global Devices link could leave a dirty
panel through client navigation without the discard confirmation. The parent
approved a source-only repair and one required 23rd test path:
`SettingsShell.overlayGuard.test.tsx`, solely for its router boundary mock.
The original guard assertions remain in place.
Source at `82a82898` and its 23-path receipt `ca336092…` remain preserved.
Before the next fixture-only repair, exact fixture/spec/checkpoint bytes,
SHA-256 inventory and the previous receipt were copied into
`.cache/settings-registry-loopback-before-82a82898/` without overwriting any
earlier evidence.

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
- Devices keeps its real `/devices` href. Its ordinary same-tab Next Link
  `onNavigate` admission now uses the existing discard dialog for any dirty
  active panel. Pending destinations distinguish this fixed route from the
  existing tab/from-URL intent. Stay leaves the current URL and draft intact;
  explicit Discard calls the current Next router. Modified/new-tab activation
  stays native and never prompts or discards the current panel. Tab-switch
  confirmation labels and URL/hash handling retain their existing behavior.
- The Help link validator normalizes aliases before checking canonical
  visibility. `isSettingsTabId` remains a canonical-only type guard. Old Help
  links are kept, and the renamed Preferences how-to retains its published
  heading anchor.

## Coverage and pending browser proof

Pure registry cases cover group placement/order, canonical IDs, three
aliases, hash names, unknown/prototype names and visibility filtering.
Existing consumer suites were extended for page aliases, eager Account and
lazy Preferences, legacy hashes, fallback, grouping descriptions, valid tab
ownership, cross-group arrows and mobile Home/End behavior.

Real Preferences and Notification forms are used in draft tests: stay keeps
the draft, discard switches without a save request, and resetting one form
must not erase the other's dirty guard. Existing Overlay multi-form tests
remain unchanged and are part of pending integration validation.
Additional real-form cases cover Devices Stay/Discard and modified clicks
for start-page and notification-only drafts, preservation of the old `misc`
query/hash, clean navigation, exactly one approved router push and zero save
requests. The unit Next Link adapter models same-tab `onNavigate` admission;
modified events remain unhandled until a test-only document listener observes
their default state and cancels JSDOM's unavailable navigation.

`tests/e2e/settings-registry-fixture.mjs` mounts the actual SettingsShell,
registry, SettingsContext and shared confirmation Modal. Typed synthetic
panels use an intercepted GET-only local transport. It replaces no shared
focus or dialog code. Install prompting is stubbed because it is unrelated
to grouping. Every external, unknown or non-GET request is denied and
recorded; no real account, provider or clipboard operation is available.

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

The same six browser cases additionally reveal the desktop sidebar after
their original width assertions, open Devices with a native Control-click in
an intercepted new tab, retain the parent draft without a dialog, then cover
ordinary-click Stay and native Enter/explicit Discard. Context-wide routing
intercepts the new tab's first document when Chrome admits that interception.
Expected extra transport is one
synthetic native Devices GET and one recorded client router push; parent
panel reads stay exactly eight, with zero actual account/provider writes.

The fake DNS hostname has been replaced in source by an ephemeral
`http://127.0.0.1:<port>` listener, following the verified InfoTip fixture
pattern. Full Chrome can start a native no-opener new tab before context
routing attaches; the same exact GET allowlist now serves that initial
request from loopback. The allowlist covers only the initial Settings URL,
fixture JS/CSS, three known fonts, canonical synthetic panel GETs and the
unqueried Devices document. It rejects extra query/hash variants and all
writes, unknown paths or nonlocal origins; the listener additionally checks
its exact Host and loopback peer. Denials have separate counters.

Assets are prepared before opening the listener. A listening server is
unref'ed; `afterAll` closes all connections and attaches a cleanup receipt
asserting `closed: true` and `listening: false`, including any fallback HTTP
requests. Real native Control-click, parent draft/URL/no-confirm assertions,
ordinary Stay, native Enter/Discard, exact reads and the one approved router
push remain unchanged. This harness repair has not been executed yet.

## Pending serialized verification

1. Review the loopback fixture/spec follow-up first. The first focused
   registry, consumer, Help, multi-form and unavailable-state pack is green
   as recorded above; no unchanged pack repeat is needed solely for this
   harness-only repair.
2. Rerun whole web types and strict lint for the changed browser files after
   the next runtime grant. Types command:
   `node node_modules/typescript/bin/tsc --noEmit --project tsconfig.json`.
   Existing Help/UI proof is unchanged by the transport repair. No new debt
   acceptance or baseline waiver is authorized.
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
