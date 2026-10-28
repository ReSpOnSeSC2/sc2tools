# Active program: October 27 delivery checkpoint

The program is active and incomplete. This checkpoint supersedes historical
pause/pending-release wording, including the older HANDOFF status. The original
197 requirements remain in `plan/final-plan.json`; no item was dropped.

## Delivered source and acceptance

- PR797: Bingo objectives fit intrinsic mobile rows and long words wrap. Bracket
  selection follows the current runner answer. Exact head
  `0e88349e181e95e288d2e5766f27f8821efcecb3` passed required CI; squash
  `c100529d394e0a12fa3c95676cf6eef763dc1d07` is live on Vercel deployment
  `8Aun1CWuJJCrzY5KJdR3jTxKLNke`. The dedicated signed-in 390px document has
  25 cells/five rows, no escaping labels or horizontal overflow, and retains
  16/25. Exactly one explicitly authorized answer was submitted; Next round
  showed four changed candidates with all four unselected. The initial desktop
  measurement's invalid phone qualification is preserved and corrected in the
  final receipt. No reroll or further answer was submitted.
- PR798: read-only personal chart-cache health in the existing admin response and
  refresh. Exact head `6f4ccd3a59c97d43af821cac4dff53676ab98766` passed web/API
  and browser CI; squash `fabe478cea64b1835e6659b36ce213d1c7a3328c` is deployed
  Ready on Vercel `EuBb4YeGUh2BwWxyVeP3TgF1xf4X` and Live on Render
  `dep-dbgls6q9lscs738rhd90`. Signed-in 390px acceptance shows Off, no activity
  figures, no activation control and contained text. Counter projection,
  unknown/malformed reporting and existing refresh behavior have separate API/UI
  tests. The original failed CI duplicate-width diagnostic is retained; the
  test-only receipt-field repair passes standalone whole-web types.
- PR799: mobile Today stat rows fit their content rather than inheriting the
  taller Session row. Exact head `0e53b7477ce95d894a4ff0802047e825a0835e86`
  passed required CI; squash `161449b4f28b74b4d74b80333a5c1e1993c69d4b` is merged.
  Vercel production `DM6HcDa3Tv4KG4zC1Aof8kaBHwno` is Ready at that exact source
  for sc2tools.com. Actual signed-in 390px card heights changed from five 459px
  cards to 459/214/214/132/132px, with auto rows and no horizontal overflow.
- Macro: the owner explicitly chose **Leave Macro as it is** after reporting
  current behavior works. The optional compact-header candidate is preserved in
  `C:/SC2TOOLS/.worktrees/macro-header-scroll`, unpushed and excluded from every
  release. Its local unit/browser proof does not imply full release validation.

Receipts: `validation/arcade-fixes/production-acceptance-final.json`,
`validation/dashboard-cache-health/production-acceptance.json` and
`validation/today-mobile-stat-height/production-acceptance.json`.

Local checks used at most two unit workers and one browser worker. Standalone
types include browser specs; Next build alone can filter their diagnostics.
Production builds and all 83 original route caps pass. The 40 canonical engine
inputs, seven retained assets and four-game sample were verified unchanged,
without generation, downloads or pruning. Original failures remain preserved.
No native agent release, infrastructure, provider setting or flag change occurred.
The API successor at `161449b4` is also visibly Live on Render deployment
`dep-dbglvq2vcj2c73dj466g`; its API bytes equal the verified PR798 source.
All six owned browser tabs are closed and the viewport reset. Owned verification
Node processes, Mongo test processes and listeners on 3210/8080 are zero. User
tabs/processes and other worktrees were preserved.

## Remaining work and qualified ledger

`roadmap-progress-2026-10-27.json` contains all 197 IDs, dependency lists and
original requirement hashes. The source reconciliation records 74 completed,
51 partial, 12 open and 60 unknown items. These are qualified source statuses,
not a claim of fresh manual/live acceptance for every feature. Unknown means
the complete original spec/augments/how-to still needs reconciliation, not that
the implementation is absent. Another 32 items were reconciled; all 265 source
  pins matched the qualified Windows audit snapshot `6f4ccd3a`; inventory,
  dependency and original-requirement hash integrity checks pass. Later release
  deltas and live proof are separate from that source audit.

`faster-dashboards` remains partial: maintained `users.gameStats`/lighter `/me`,
dependency-safe coverage beyond the six chart routes and revocation-coherent
device-auth reuse remain. Keep `USER_CACHE_ENABLED` off. Reuse existing ETags,
deferred Trends, activity throttling and liveness caching. The auth prerequisite
is in `device-auth-reuse-checkpoint.md`; do not use metadata caching as authority.

`analysis-corpus-local-cache` remains separate: delta/removal/version contracts,
IndexedDB persistence, account clearing and history controls are unfinished.
Personal Maps quick search remains deferred; find-anything is not complete.

The older-wave audit also found five concrete residuals: update-prompt
What changed link, Help-menu What's New, Dock overlay setup deep link, canonical
shared-analysis loading skeleton, and browser-demo file-size/Choose-another
recovery parity. See the ledger changes and source pins in
`validation/roadmap-reconciliation/`. Native signed-installer delivery remains
qualified by its recorded signing failure; no installer success is inferred.

Preserve owner corrections in the October 26 and feature checkpoints: opponent
section order, Auto-track season, passive scroll position, seven-minute air and
DT definitions, build-action placement, saved opponent columns/latest downloads,
mobile overflow and Chat-first Dock. Preserve the Dock worktree because other
checkouts use its engine assets. Costs stay on the existing Render/Atlas M10/R2/
Vercel/Clerk footprint. Preview retention remains one week; production 30 days.

The final detailed `docs/SETUP_GUIDE.md` is still required at program completion,
covering owner setup, variable names, backups, rollout/rollback and remaining
configuration, without secret values. Do not claim the entire program finished.
