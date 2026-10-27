# Opponent mobile overflow — local verification passed; CI pending

2026-10-27. Three scoped layout changes wrap long opponent/pro/alias names, make
the Ladder text track shrinkable and reflow narrow Identity stats. Section order
stays Brief, Tendencies, Timings, History, Ladder, Identity. Race/composition/
evidence tables retain their existing local scroll boundaries; chart height and
percentage-width rendering remain intact. No global overflow hiding or new name
truncation was added.

Root works in the separate `codex/opponent-mobile-overflow` c0-based worktree.
This checkpoint records completed local verification, not a live-account or
deployment claim. Its author made cache-only writes and ran no runtime or Git;
all execution results were supplied by root.

## Reproduced baseline

Corrected baseline02 uses harness V3 SHA-256
`318b87fc7667e936c863c93b111f271bb7ab3f9bc3daac521fbe94981347d0e9`:
20 cases at 320/390/640/768/1280, actual light/dark palettes and normal 12-bar
versus extreme 64-bar names. Root verified computed palette/loaded font guards,
12 passes/8 failures, zero writes/external requests/flattened page-error strings,
52 closed observed identities and no owned listeners.

- Long names at 320/390: whole-document overflow. The 390 case had document/body
  width 501, with h1 left 28/right 501.09/width 473.09.
- Narrow normal names at 320: local Identity clipping/overlap, not page width;
  document stayed 320 while stats were 158 client/183 scroll pixels.
- Long aliases at 640: clipping inside Ladder. Root also measured aliases at
  298 client/744 scroll pixels in the long 390 case. The race table there was
  bounded at left 46/right 344 and 298 client/298 scroll pixels.

The original theme-labeled baseline is retained, but both palettes resolved to
light. Its geometry is diagnostic; dark-theme proof comes from corrected V3.
The exact reported opponent URL was not supplied. Normal 12-bar 390 already
passes the baseline, so this matrix does not reproduce a particular account at
that width. Root may check an optional URL later without blocking these fixes.

## Fixed-source results reported by root

- 53 tests across six existing component files passed in 10.45 s.
- Whole-web types passed; strict lint of three production files and manual CJS
  passed with zero errors/warnings.
- Own Next build: `MDTlbA9t0gVuPy7MlVP0G`.
- All 81 unchanged route budgets passed: 18 listed, 63 default. `/app` is
  238.2/240 kB; the dossier is 464.2/500 kB. Asset/link compatibility proof remains
  unchanged. Validation group: 24 positively closed observed identities,
  no owned listeners.
- Fixed browser01 passed **20/20** on the same exact V3 harness/data and fresh
  own-built CSS/BUILD_ID, with zero page errors, writes or external requests.
  All documents exactly match their 320/390/640/768/1280 viewport widths.
  Long-name 390 changes document 501→390 and alias scroll width 744→298
  (client 298). At 320, long-name document 501→320, aliases are 228/228 and stats
  158/158. Browser group: 52 positively closed observed identities, no listeners.
- Root visually reviewed fixed long 390 light header, long 390 dark Ladder,
  normal 390 light Ladder, long 1280 light Ladder and long 640 dark Ladder,
  including comparison with the corrected baseline graph captures.

The fixture mounts real AppChrome/AnalyzerProvider/ProfileView/SWR, with synthetic
Next/Clerk/socket boundaries and a finite loopback API. Existing channel/VOD batch
POSTs are read-only fixture lookups; mutations are blocked/logged. Screenshots and
raw document/section/local widths are retained before layout assertions. This is
not real provider/Mongo/account or full accessibility certification.

## Final status and reviewed screenshots

Local test/type/lint/build/budget/browser and visual gates passed. Exact-head CI
is pending; update that result after the PR checks. No threshold was raised.
Changed source line counts reported by root are Profile 547, Ladder 268,
Identity candidates 788 and manual harness 136; scoped strict lint is clean.

Preserve the actual baseline failures and use the same geometry/chart/theme/font
assertions. Do not loosen them or hide the body edge to obtain a pass.

Root copied six selected reviewed exports under `docs/handoff/screenshots`,
recorded in `reviewed-screenshots-01.json`: before/after 390 light header,
before/after 390 dark Ladder, and fixed 390/1280 light Ladder. The before exports
use the corrected actual-palette baseline, not the earlier mislabeled run.
No source migration or data rollback is needed; reverting the component classes
restores prior behavior.
