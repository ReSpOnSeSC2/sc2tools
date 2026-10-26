# Glossary and InfoTip foundation checkpoint

2026-10-26. Branch `codex/wave5-glossary-infotip`, based on main `1ad5dafa`,
in `.worktrees/wave3-my-reviews`. Preserved Execution source, refs and caches
remain. Notification and MobileNav packs are frozen in separate worktrees.

## Source-only stage

The initial exact eighteen-path manifest was written before edits as
`.cache/glossary-infotip-owned-paths.txt`. Root approved one additional path,
`apps/web/components/help/HelpArticleBody.tsx`, before editing it: the existing
page/compact variant must reach the new widget so compact Help does not emit
duplicate public IDs. The manifest contains nineteen paths.

No unit tests, types, lint, Help generation, production build, browser, Git
mutation or deployment has been run for this pack. The generated Help index
is owned but deliberately unchanged; run the canonical generator only after
root grants runtime. Registry/search checks require that generation first.

## Implemented foundation

- InfoTip uses existing IconButton and body-portalled nonmodal Popover. Its
  named 44px trigger exposes expanded/controls/description relationships.
  Only explicit open dynamically imports definitions; the eight-second bound
  exposes Retry when a chunk cannot settle. Closing, unmounting, changing the
  term, A→B→A and retry retire old results. No native title-only explanation,
  provider call or full Help registry import is introduced in analyzer leaves.
  Explicit retry returns lost focus to its current result action only when
  another control or newer dialog has not taken focus ownership.
- Term keeps a dotted, readable visible term beside its named InfoTip control.
  Unknown IDs show a retryable unavailable definition, not an invented link.
  Meaningful tests validate literal consumer IDs against the canonical registry.
- The existing seven definitions, `glossaryTerm`, `glossaryHelpPath`, categories,
  related terms and contextual article anchors remain unchanged. Definitions
  are not copied into consumer strings.
- The normal Help article/HelpWidget route provides `/help/glossary`, A–Z,
  search over term and definition text, result count, contextual/related links
  and term IDs. Widget text joins the existing Help search index. Known widget
  anchors extend the existing `helpArticleAnchors` function without changing
  its API. Public pages emit stable term IDs; compact Settings/Help sheets
  retain `data-help-anchor` and unique input IDs. The existing chat widget's
  rendering stays unchanged.
- GroupingPreference renders the new information control beside its existing
  switch. Its preference behavior, writes, disabled states, error/Retry, label
  and callback are unchanged. No term button is nested inside another control.

## Authored verification, still unrun

- InfoTip tests cover explicit load, named nonmodal ARIA, contextual term,
  unknown/retry, outside native pointer focus and nested Modal Escape/lock.
- GlossaryBrowser tests cover canonical A–Z sorting, definition search,
  empty/clear states and the actual HelpArticleBody's public/compact anchors.
  Registry tests preserve existing contextual links, check literal Term/InfoTip
  IDs and known glossary anchors. Help search tests find definition text.
- Browser fixture runs actual InfoTip/Term/Popover/Modal, GroupingPreference,
  glossary article/renderer/browser and HelpSearch with production CSS/fonts.
  Only the dynamic import boundary, navigation and unrelated chat widget are
  synthetic. The native import serves an ESM build of the actual unchanged
  canonical glossary module; a fixture-only lookup failure exercises Retry.
  Holds can prove that timeout/close/ABA cannot publish late content. Every
  unknown GET/write and nonlocal attempt is counted and rejected. Grouping
  changes local fixture state only, with no real account/provider write.
- Three flows per theme exercise keyboard/touch target/ARIA, body portal,
  pointer focus, independent grouping action, parent/newer-modal Escape,
  bounded held imports and explicit Retry, A–Z/deep links and Help discovery.
  Full AA and viewport checks stay enabled. Receipts identify the production
  build/CSS and exact definition-load/write/external counts.

## Remaining gates and deliberate staging

- Root source review and runtime grant. Generate the Help index canonically,
  then meaningful focused/related Help/Popover/focus tests, whole web types,
  strict owned-source lint and UI ratchet. Preserve failures; no new allowance
  or shared primitive API change is authorized here.
- Normal source/hash admission for retained engine/sample assets, then one
  current production build, post-build types and unchanged route budgets.
  Today currently has 234.3/240 kB and Community 188.5/190 kB; this pack avoids
  their consumer migrations and does not raise either budget. Verify actual
  bundle output rather than infer its size from source.
- Actual browser checks with one worker and installed pinned Chromium,
  reviewed representative captures, current-main reconciliation, exact-head
  CI, commit/PR/merge and live source/domain verification. New screenshot paths
  need root approval; none are owned yet.
- This is the foundation plus one existing-vocabulary consumer, not completion
  of `glossary-and-infotip`. About forty terms, source-verified metric/formula
  expansion, Opponents header info slots, MacroKpiRow/SpendingQuotientStat,
  MechanicsPanel, build W–L/Planned/Corrected, overlay-token explanations,
  `reading-your-stats` and the analyzer-header title warning are later packs.

## Source-review navigation repair, still unrun

Root identified that a queued Related-link frame could outlive a new search
or focus action while its target remained rendered. Within the same nineteen
paths, the withheld-frame regression was authored before the localized repair.
The regression returns focus to Search, types a query that still includes the
old Pulse ID target, then releases the old callback and requires no scroll,
focus or hash change. It covers public and compact variants. Positive cases
retain the explicit Related jump when it still owns the action; further cases
retire frames after focus movement, variant change, newer keyboard action and
unmount. Canceled callbacks are deliberately released by the test harness, so
the identity guard must work independently of cancellation.

Queued navigation now owns one current request, variant generation, container,
URL and focus snapshot. A new search, local link action, pointer/key/focus
action, history navigation, variant change or unmount retires it. Temporary
listeners exist only while its frame is queued and are removed before the
current explicit jump focuses its target. Compact mode still avoids public
hash writes. No global helper, primitive API, canonical definition or search
formula changes are included.

No runtime/test pass is claimed. Preserve the original source-only receipt;
the localized replacement freeze is recorded separately in
`.cache/glossary-infotip-navigation-retirement-sha256.json`.

## Compact link destination repair, still source only

The independent source review found that compact A–Z and Related links used
fragment-only hrefs while compact Help intentionally emits no matching public
IDs. A Ctrl/Meta-click from an analyzer Help sheet would therefore open the
analyzer URL with an unresolved fragment. Within the same nineteen paths,
compact links now carry the canonical `/help/glossary#…` destination. Public
glossary links keep their local fragments. Plain compact A–Z scrolling and
Related filter-clear/focus behavior still use their existing handlers without
changing the current page hash or the queued-action retirement guards.

The owned GlossaryBrowser tests now verify every A–Z/Related href through the
real public and compact HelpArticleBody, including two compact copies without
duplicate IDs. New Ctrl/Meta-click cases require the consumer to leave native
navigation unprevented, preserve the search and avoid local scrolling, queued
frames or hash writes. The test observes that consumer decision before a
document listener suppresses only jsdom's unsupported navigation. Existing
positive plain navigation and all retirement assertions remain in place.

No tests, generator, types, lint, build, browser or Git action ran for this
repair. The canonical seven-term module and generated Help index are unchanged.
The original source-only and navigation-retirement receipts remain preserved;
the new full nineteen-path freeze is
`.cache/glossary-infotip-compact-anchor-sha256.json`.

The subsequent source-only typing review removed five unsupported `exact`
options from RTL ByRole calls in GlossaryBrowser's owned test. String `name`
matchers retain exact accessible-name matching. The owned InfoTip RTL test
contains no such option and is unchanged; Playwright's supported `exact`
options remain. No runtime was run. The compact repair receipt is preserved,
and the current nineteen-path freeze is
`.cache/glossary-infotip-rtl-role-options-sha256.json`.

## Rollback

Revert this web-only foundation to restore prior grouping and Help behavior.
No production data migration, recomputation, integration activation or agent
version/release is included.
