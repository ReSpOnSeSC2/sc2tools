# Glossary and stats consumers — first expansion slice

Date: 2026-10-26. Worktree: `wave3-my-reviews`, branch
`codex/wave5-glossary-terms`, starting from merged main `78818d4b`.

## Boundary

This is the source-only implementation of the exact 20-path slice in
`C:/SC2TOOLS/.cache/glossary-first-expansion-slice-2026-10-26.md`, backed by
`C:/SC2TOOLS/.cache/glossary-expansion-audit-2026-10-26.md` and a second
read-only formula review against current code. **No tests, types, lint,
generator, build, budget check or browser cases have run for this pack.**
Runtime remains held by other serialized work. No Git mutation, network,
provider, account, clipboard, installer or SC2 operation was performed.
Old branches, owner files, caches and screenshots remain preserved.

Before source edits:

- `.cache/glossary-terms-owned-paths.txt` recorded the exact 20 paths;
  SHA-256 `c292448107805d500fd9abbd196c2f769ffbe4908803e5380d81704d8ab48ca4`.
- `.cache/glossary-terms-original-sha256.json` recorded existence, byte size
  and hash of each path.
- `.cache/glossary-terms-original-glossary.ts` preserved the original source.
- `.cache/glossary-terms-original-seven.json` recorded the seven actual term
  records by decoding their plain source literals without executing a module;
  SHA-256 `8cd8e9d2ec37b96e880ab3922b5c158823e2e184db99ed817039c95a41bc28ba`.

The source-literal preservation comparison found exactly 40 records and all
seven originals equal. `.cache/glossary-terms-preserved-seven.json` has the
same SHA-256 as the original snapshot; the method/result is recorded in
`.cache/glossary-terms-preservation-receipt.json`. This is a file-content
comparison, not a claimed module, unit or browser execution. The final
20-path source-only hash receipt is
`.cache/glossary-terms-source-only-sha256.json`.

## Authored behavior

The import-free catalog keeps the seven original records and IDs, and appends
33 terms for a total of 40. `formula?: string` is ordinary data, rendered as
labelled wrapping text and included in both glossary and Help-widget search.
The original lookup/path helpers and contextual links remain compatible.

Key formula and scope decisions:

- SQ uses arithmetic means of samples at time ≥60 seconds, with each bank
  floored to 50. Fewer than five eligible samples or nonpositive mean income
  yields fallback 75. SQ is unbounded; tier names describe pace, not rank.
- Macro score clamps SQ−5 first, then subtracts penalties and rounds/clamps.
  A fallback engine value is distinct from an unavailable frontend field.
- Supply time uses sampled near-cap evidence below 200 with capped four-second
  credits. Float counts samples strictly above 800 minerals at time ≥240.
  Neither describes proven continuous downtime or sustained episodes.
- Mechanics percentage uses actual/expected, while penalties use expected
  minus grace. Missing actual can display a dash while arithmetic uses zero
  when expected is positive. Inject/Chrono/MULE periods and grace remain
  distinct; creep is informational. No mechanic calculation changed.
- APM requires trusted v2+ data; a zero average is unavailable. SPM uses
  duration-weighted rates. Recovery advice remains in the canonical APM entry.
- Opponent WR divides wins by wins+losses; Build stats WR uses all matching
  rows. Games, measured counts and each comparison's eligibility can differ.
- Current/stored Last MMR is not replay-provenance evidence for strength
  adjustment. Latest known order coverage remains qualified, with game dates.
- Medians and quantiles retain consumer-specific algorithms/weighting.
  Milestone 3-observation, natural-comparison 5-observation and league 50-sample
  thresholds are separate. Wilson raw/rated denominators remain separate.
- Vs expected uses its same replay-rated subset for actual and expected wins;
  performance rating stays unavailable at 0%/100%. Trade ratio never invents
  infinity for zero own loss or a fight from an explicitly empty ledger.
- Planned/Corrected/counting check-ins distinguish applied labels from detector
  evidence; public build aggregates retain detector-only scope.
- Overlay sessions use gaps over four hours, expire if the latest game is over
  four hours old, respect manual reset and differ from local-calendar Today.
  Title tokens are placeholders; Best answer ranks wins first, not win rate.

Four Macro tiles now use adjacent shared InfoTips. Value formatting, units,
finite SQ thresholds, tone/glow and loading hints remain. Invalid infinite SQ
already formatted as a dash; the tier lookup now shares that finite guard so
the dash cannot claim a Pro tier. No numeric score or tier cutoff changed.

`SortableTh` adds only optional sibling `info: ReactNode`. The sort button
keeps its string label, handler, direction, padding, width and alignment.
Headers with help name the column explicitly and give the sort target a 44px
minimum, while the separate shared InfoTip has its existing 44px target.
Pulse ID, Last MMR, Net MMR, MMR won, MMR lost and Win rate use stable term IDs.
There is no glossary value import in these analyzer leaves or SortableTh.
Mobile opponent links receive no nested help button; their existing layout
and selection/persistence behavior remain intact.

Reading your stats is a normal analyzer Help article with explicit Today,
Opponents, Macro and Builds anchors. Its text names each cohort before the
number, explains null versus zero, and avoids causal or future-win claims.
The canonical generated Help registry was **manually synchronized in its
normal sorted form under the source-only authorization**. The existing Help
generator and deterministic registry test remain pending, not claimed run.

## Authored coverage — unrun

- Catalog count/IDs, related targets, contextual links and normal Help anchors.
- Real public/compact glossary rendering, formula filtering, formula wrapping
  and count changes to `GLOSSARY.length`; all existing queued-navigation,
  modified-click and compact-anchor retirement tests remain.
- Help formula search plus Reading your stats lookup/search/sitemap/anchors.
- Real Macro KPI controls resolve all four definitions and retain missing APM
  recovery links, quiet loading, measured zeros, high SQ and unavailable
  null/undefined/NaN/infinite values. Every APM timeline assertion remains.
- Real SortableTh help leaves aria-sort and saved preferences unchanged; only
  the sort button changes them. Real Opponents tests cover all six definitions,
  unchanged selected columns/rows/measured values and deliberate sorting.

The existing InfoTip fixture retains its ephemeral loopback server, strict
GET classifier, native popup path, request ledgers, controlled definition
import, timeout/Retry/ABA and newer-modal focus cases. It now mounts the real
MacroKpiRow and OpponentHistory with typed synthetic values and persistent
sort state. Optional replay-download/channel transport is an explicit failing
boundary, not a live account or a replacement for the tested controls.

Two additional browser cases cover Light/Dark at 320, 390, 768 and 1280px:
44px controls, SQ glow/body-portal escape, bounds/hit testing, all four KPI and
six desktop-header definitions, mobile no-nested-control checks, native
Enter/Space sorting, unchanged saved preference while opening help, reload
persistence, measured/missing/loading states, full AA including contrast,
formula search and the normal stats article. Original native popup, public
and compact cases remain and use the expanded catalog count. Timeout/Retry's
8-second product deadline is unchanged; normal full-catalog test envelopes
allow the larger real DOM. Original screenshots are not rewritten.

The fixture includes Help content and thus is **not proof of production
initial chunk placement**. Zero definition-boundary requests before explicit
InfoTip open is asserted separately from the eventual production bundle and
budget checks. All fixture data is synthetic; API/provider/account/clipboard
writes are unavailable and attempted transports are counted and fail closed.

## Pending serialized proof

1. Review source, formula copy, original-seven comparison receipt and exact
   manifest before any runtime. All current gates are unrun.
2. Run the normal Help index generator and deterministic generated-index,
   Help link/search/sitemap, catalog/browser, Macro timeline/KPI, SortableTh
   and Opponents suites with at most two unit workers. Preserve any RED logs.
3. Whole web types, strict owned lint, existing UI-rule tests and UI ratchet.
   No new allowance, baseline acceptance, calculation, API or budget change
   is authorized. Request any genuinely needed path expansion first.
4. After source review/runtime grant, admit retained engine/sample assets
   read-only, then one direct current Next build, unchanged budgets and
   post-build types. Check actual initial analyzer chunks and tight page
   budgets, rather than relying on the fixture's lazy import switch.
5. Run the existing and extended InfoTip browser matrix using one pinned full
   Chromium worker, fresh production CSS/fonts, full AA and new cache-only
   capture/ledger directories. Review phone/tablet/desktop captures and the
   listener cleanup receipt (`closed: true`, `listening: false`). Report real
   failures without weakening accessibility, focus, sort or request assertions.

## Remaining roadmap scope

This first expansion slice does not finish the complete glossary/contextual
help item. Mechanics/timeline labels, build W–L/Planned/Corrected consumers,
overlay title/secret-token consumers, benchmark/strength-adjusted labels,
phone detail columns, the MMR-impact filter and analyzer header title-warning
rules remain later packs. There is no new data request, search API, calculation
engine, AI dependency or global glossary route in this pack.
