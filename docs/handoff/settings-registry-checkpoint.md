# Settings registry and grouping — A1 verification boundary

## Full-CI article-date assertion repair

Exact-head2a0783d0 CI passed the browser job but found one old Help route test
still asserting October25 for the Getting started article, which this pack
updated on October26. Root preserved its original bytes and bounded failure
evidence in `.cache/settings-ci-date-2a0783d0/`. The24th owned path is the
existing `apps/web/app/help/__tests__/pages.test.tsx`. Only the expected visible
date and matching datetime literal change to October26; breadcrumbs, routes,
rendering and structured-data assertions stay intact. Product source and the
validated production artifact are unchanged. The affected actual Help route
suite now passes11/11 checks with strict lint zero in the integrated glossary
checkout at4c2504ea. The test, Getting started article and HelpArticleBody bytes
match this A1 checkout; the shared hash receipt is preserved in the glossary
proof directory. The original CI and local old-date failures remain retained.
Actual main0033919d was reconciled at994a02ba without changing the complete
reviewed tree; fresh exact-head remote checks still follow.

Root independently verified the23 final owned hashes and five proof artifact
hashes, and visually reviewed the Light1280 sidebar, Dark360 Preferences and
Dark1280 Devices-discard dialog. Three byte-identical copies are preserved in
`docs/handoff/screenshots/` as `settings-registry-light-1280.png`,
`settings-registry-dark-360.png` and
`settings-registry-devices-dark-1280.png`; original captures and copy receipt
remain. All runtime source stays unchanged after this proof.

Date: 2026-10-26. Branch: `codex/wave5-settings-registry`, starting at
`c1d0abd5`; final integrated product source is `2f042be6253710a017afc2ee129c0ac8242ab2d7`.
This is stage A1 of the `find-anything` item in
`docs/handoff/plan/final-plan.json`, including its Settings IA augment.
The complete roadmap item remains unfinished.

## Current boundary

Final local validation is GREEN. One direct Next production build generated
144 static pages, passed all 81 unchanged budgets and passed post-build web
types. Its build ID is `ESe5OurSX4bfDvU6e6AsG`; Settings measured 182.8/260 kB.
The original three browser projects in Light and Dark passed all six cases
with one pinned Chromium 1228 worker, zero retries/skips and 24 full shared AA
scans, including contrast. No serious or critical AA issue was found.

All browser, build, unit and type processes have exited. The three ephemeral
loopback listeners reported `closed: true`, `listening: false`; a subsequent
read-only port inventory found no listener at 49351, 65471 or 55993. Runtime
was explicitly released to the parent before this receipt update. No Git,
remote, provider or real account operation was performed. Existing owner
files, ignored bundles, pointers, caches and earlier screenshots are retained.

The exact 23-path manifest remains
`.cache/settings-registry-devices-owned-paths.txt`. The only final-stage source
amendment adds the fresh `.next/BUILD_ID` to the existing fixture evidence and
its spec attachment; it changes no fixture flow, transport or product behavior.
Its two before-files and hashes are retained under
`.cache/settings-final-2f042be6/before-buildid-metadata/`. All 23 prebuild
hashes remained identical through the browser proof; only this checkpoint
was then updated. The parent owns Git delivery and any tracked screenshot copies.

## Final integrated static and asset proof

- 298 checks across 33 disjoint suites passed, covering the original Settings
  registry/page/links/real-form/Overlay consumers plus shared context, tab and
  focus contracts, Header, Platform disconnect and Glossary integration.
  This unit pack preceded the metadata-only fixture amendment. Whole web
  types passed before and after that amendment, and again after Next.
- Strict lint passed with zero warnings for the 20 owned code files other
  than SettingsShell. The two amended browser files also passed strict lint
  and fixture syntax checking. The separate Shell audit reports exactly its
  one inherited `jsx-a11y/interactive-supports-focus` warning at line 321,
  unchanged from the first-stage/pre-A1 audit. No tabindex, pragma, waiver or
  baseline allowance was added to suppress it.
- Read-only canonical Help generation was deterministic at 91 articles:
  normalized SHA-256 `b1af2309affec6feaf94224421684fda9de54b05dec06fd6ce8a5e864010a074`.
  The generated registry was not written. UI proof passed 19 rule tests,
  1,700 scanned files and 642 existing occurrences with no new/stale allowance.
- Before and after the build, all 40 normalized engine inputs matched
  source hash `18a2e1b56111045cdb441d9d8868eee0b36d0b158b34ea0a79e3b9a22a69e2b2`.
  The retained engine 1.6.12/agent 0.24.7 d27 manifest, ZIP and runtime assets
  matched their admitted digests and sizes. All nine retained engine/Pyodide
  files and the older fc21 bundle were preserved; no copy, engine compilation,
  publisher, generation, pruning or download was needed.
- All four strict sample payloads passed. The actual CRLF sample bytes were
  preserved: raw SHA-256 `05e874e4792b9e054021efbe0008a935a4cd1c4e4395b1f3e061508b476f0c40`,
  canonical LF SHA-256 `91a6735e50f45776c15642ebae53f1a3f9800c1db225a99e0e631be318820473`.

Final evidence is preserved in `.cache/settings-final-2f042be6/`:
`initial-source.json`, `prebuild-source.json`, `asset-admission-prebuild.json`,
`asset-admission-postbuild.json`, `help-determinism.json`, `next-build.log`,
`budgets.log`, `types-postbuild.log`, `browser.log`, `browser-results.json`,
`build-artifact.json`, `final-browser-summary.json` and `final-source-proof.json`.
Static logs are `.cache/settings-final-integrated-units.log`,
`settings-final-integrated-types.log`, `settings-final-strict-20.log`,
`settings-final-shell-lint.json`, `settings-final-metadata-{syntax,strict,types}.log`
and `settings-final-ui-{rules,ratchet}.log`.

## Historical first static stage

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
  `display: contents`. The final browser matrix covers its accessibility
  ownership, computed style, placement and native keyboard behavior.
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

## Consumer coverage and final browser proof

Pure registry cases cover group placement/order, canonical IDs, three
aliases, hash names, unknown/prototype names and visibility filtering.
Existing consumer suites were extended for page aliases, eager Account and
lazy Preferences, legacy hashes, fallback, grouping descriptions, valid tab
ownership, cross-group arrows and mobile Home/End behavior.

Real Preferences and Notification forms are used in draft tests: stay keeps
the draft, discard switches without a save request, and resetting one form
must not erase the other's dirty guard. Existing Overlay multi-form tests
remain unchanged and passed in the integrated unit pack.
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
push remain unchanged. All six final cases executed this loopback transport
successfully, including the native new-tab first request.

The final ledger contains exactly 48 typed synthetic panel GETs and six
native Devices document GETs, six approved client router pushes and zero
save/API writes, unknown requests, rejected requests or nonlocal attempts.
The fallback HTTP servers handled exactly the six unqueried Devices GETs.
No real account, provider, preference, clipboard, native-agent or StarCraft
action occurred. The build ID and the actual production CSS file names are
attached to every flow; all six refer to the newly built artifact.

The matrix retains its original 360/768/1280 projects and both themes. The
Devices sidebar section deliberately resizes each project to 1280 after its
initial width assertions. It therefore proves desktop Devices admission and
the native modifier path, not phone Account quick-link admission or phone
Devices-dialog geometry. Browser panels are typed synthetic; the real
Preferences/Notification dirty-form and multi-form behavior is proved by the
unit consumers above. No extra 320/390 matrix is claimed.

All 18 new PNGs remain unchanged under `shots/`. Representative visual review
covered `mobile-360-light-preferences.png`,
`desktop-1280-dark-preferences.png` and `mobile-360-dark-guard.png`: the phone
tab row retains its existing horizontal scroller/edge hints, desktop groups
and descriptions are legible, and the phone discard controls remain visible.
The proof does not assert that every scroll-row label is fully visible at
once. Original captures and historical RED logs were not overwritten. There
was no new final-stage RED or product repair.

## Remaining roadmap stages

Chat extraction/token ownership, section navigation and Settings search,
public guide search, the command palette, shortcuts, recent-route storage
and private quick-search APIs remain separate stages. This pack does not
claim their delivery or change their server cost, privacy or auth contracts.
