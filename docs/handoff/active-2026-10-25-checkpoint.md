# Active upgrade checkpoint — 2026-10-25

Reconcile the older HANDOFF.md and final-plan.json with this checkpoint. Continue
implementation, tests, PR repairs and green-check squash merges. The overall
roadmap remains incomplete; docs/SETUP_GUIDE.md is still required at the end.

## Latest owner corrections and shipped work

- Keep the live dossier order: Brief, Tendencies, Timings, History, Ladder,
  Identity. Replay History stays above Notes. Withdrawn PR739 must not return.
- PR740 already shipped seven-minute PvZ Void Ray/Phoenix opening criteria.
  Do not reanalyze production games without authorization.
- PR747 already shipped the passive recorded-composition scroll correction.
- PR753 merged at cf25bc8883858908f4a0b1591a83c39b8805fd5f: native report X and
  minimize use the same nonactivating input proxies as the scouting icon. All
  exact-head checks and Windows/compact/transparency proofs pass. No installer,
  release, version or tag was produced; installed agents need a later update.
- PR754 merged at **9b7ef88a55b780f153ed4271ba46d3eaa0de1b63**: expanded opponent
  columns, explicit latest replay download, private bounded summaries and saved
  preferences. Final head64e3a771 passed full API/web/responsive/Vercel checks;
  fresh merge tree equaled tested tree917afb5a. Test-only stale consumer mocks
  were corrected (111 unit checks, nine coaching browser cases and two manual
  fixture bundle checks). PR750 is closed as superseded. Vercel production UI
  confirms 9b7ef88 Ready at deployment2GDVmsfS7sYi6dHw7uLnf2hEAn4t.

## Status page: shipped and hostname repaired

The owner confirms no status provider was ever configured. Public
status.sc2tools.com currently returns Vercel DEPLOYMENT_NOT_FOUND. The hostname
resolves to Vercel but is absent from the sc2tools project's Domains list.

- PR **755**, branch codex/fix-public-status-page, worktree
  `C:\SC2TOOLS\.worktrees\wave3-my-reviews`.
- Final head **d7072318602912e138c3919690f5da91659b873c**, final tree
  **98c428fdb7f22527f5c1a7e15bd698c53a1d9867**. Includes actual main9b7ef88;
  ancestry-only reconciliation left the validated tree unchanged.
- `/status` renders outside Clerk/app background providers. Initial Unknown
  results; browser-only website/API public pings, manual Refresh, completion
  timestamps, omitted credentials, four-second whole-request deadline. No new
  service, cron, DB/queue claims, owner data or writes.
- Exact status hostname redirects308 to https://sc2tools.com/status, stripping
  path/query. Preserve private auth guards. Attach alias to the existing Vercel
  project's Production environment **after** primary /status is deployed.
- 233 focused checks, full types, strict lint, Help index, production build and
  unchanged budgets pass. Engine25b300818c31d41b,1.6.12/Python3.14.2 rebuilt and
  smoke-parsed. 172 browser assertions pass at320/390/768/1440, both themes;
  root reviewed four owned screenshots. See public-status-checkpoint.md.
- Full web/responsive/Vercel checks passed after correcting an old Help FAQ
  order expectation (seven focused FAQ checks and lint passed). PR755 squash
  merged as **c7bf67e7e9cbf8ea8eac4706844b96d4a3ba7696**, exactly the tested tree.
  The initial preview hit Vercel's rolling deployment limit; the necessary
  test-fix head later deployed successfully to PreviewHvCHwokvT7JAUjWEysP7d971MAKa.
  Main's automatic deployment was absent, so root created ONE normal Production
  deployment for verified mainc7 through the authenticated Vercel UI. It was
  accepted and Building as sc2tools-5ay50jl2x-jonathan-laymans-projects.vercel.app.
  Once primary/status became200, root attached exactstatus.sc2tools.com to the
  existing project's Production environment. Valid Configuration confirmed;
  aliasroot and syntheticpath/query return308 to cleanhttps://sc2tools.com/status.
  ActualChrome showed both Website/API Reachable and manualRefresh updated
  timestamps19:16:30→19:16:36EDT. Live screenshot inspected. No plan change,
  second provider/account, deployment deletion, DNS/credential change or repeated
  retry occurred. Status repair is COMPLETE.
- Chrome Vercel browser session is authenticated: tab1160793790, session
  Status repair, team jonathan-laymans-projects/project sc2tools. It is currently
  at Domains settings after successful alias attachment. Reacquire only if
  stale, refresh computer-use docs after compaction. No credentials were read.
- Public deliverable Chrome tab1160793908 is at primary/status and marked to
  remain open. PR755/sourcecheckpoint contain live evidence. No paid service.

## Active source work — preserve all files

1. **Shared UI and A11y752** are combined in `wave4-agent-dashboard`, branch
   `codex/wave5-contrast-accessibility`. Original A11y head `99806e8d`, Nav head
   `9849c107` and committed UI/gallery head `f1808a33` meet at merge `84193ecd`.
   Final integration repairs are frozen for root's commit/push and remote gates.
   Full Light/Dark/System, registered portal focus, typed UNPAIR and existing
   controlled destructive dialogs are preserved. Gallery authorization remains
   server-gated and bounded; its actions use synthetic local state. The ratchet
   has no new/stale debt. Root reviewed four new synthetic captures.
   Final affected packs cover 762 checks in 62 unit files plus 16 AST checks;
   full web/API types, 95 owned-file strict lint, 18 gallery/focus browser cases,
   190 production cases and 126 public axe scans pass. The 23 production skips
   are intentional viewport/Clerk fixtures, not failed cases. All unchanged
   budgets pass; `/try` is 213.7/240 kB after seven static leaf imports.
   See `accessible-ui-integration-checkpoint.md`. Preserve all caches, original
   17 A11y captures and two unrelated web .tmp files. Never run the obsolete
   opponent section-order script. Broad consumer migrations remain unfinished.
   The prior UI worktree/branch and merged cache branch `978a843f` are retained.
2. **Nav731** is squash merged as
   `cfcf5abdebc33c74de24435cfa3729548b5ac9e1` after every remote check and Vercel
   passed. Root verified the fresh main merge tree equals tested head `9849c107`
   (tree `01b5b50f`). Local proof includes full types, strict lint, 51 focused
   checks, final production build/budgets and 744 navigation/columns/autoscroll
   assertions. The source retains the original dossier order and explicit saved
   preferences. **Eleven pre-existing owner PNG edits remain byte-identical and
   unstaged** in `wave3-build-exports`; preserve its branch, worktree and caches.
3. **Requested Macro editor and PvT DT correction756** are live as main
   `b97fb80c1dec3aec7e53ece7bfe26852b6d40d9d`. Final published head `f5659d36`
   passed all remote gates, including Windows UI and Vercel; root verified the
   squash merge tree equals its tested source. Both Macro Breakdown surfaces
   expose the real intent-only build editor through loading/error states.
   Owner/game pending-write, JWT/body/deadline and ABA retirement are preserved.
   Early real ground DT proof precedes later Charge/Blink; early Shrine excludes
   Charge-first while proven real-Prism Drop stays more specific. Late-tech
   transitions and custom/global precedence remain. Existing synthetic Python,
   native, catalog, real-Pyodide, Macro and browser proofs remain in their pack
   checkpoints. A stale guide-artifact gate was repaired through the normal
   exporter, which now refreshes both generated API guide files; all 24 affected
   parity checks and strict generator lint passed before the final CI run.
   Production built automatically. Root verified the live personal DT label,
   generic Macro editor controls and public Linux engine `0256093d6981b497`
   (11 CI engine checks). Windows local builds use `fc21ebe5bf52a53c`; both are
   version 1.6.12 with platform-built wheels. No production reanalysis, installer,
   release or tag occurred. Private Admin observations/images must never be
   copied into source or public documentation; regression fixtures are synthetic.
4. **Public player work** is source-only in `wave3-my-reviews`, branch
   `codex/wave5-public-player`, based on Nav `9849c107`. Its agents own that pack;
   its next serialized validation slot follows the completed A11y work above.
   No test, deployment or roadmap-completion claim is made for it here.

Latest Randomizer question was answered from source: native page is a silent
shared-pool editor/saved-result display. Animation/sounds/speech live in widget.
Check-in Randomize still requests a server-selected saved pick without OBS;
no duplicate native animation/RNG/audio runs. No removal was requested or made.

Other pending packs remain: auth return736, dossier742/execution748,
landing745/try751, plus later Wave5/6. Do not mark the roadmap complete because
pieces of a pack exist. Reuse existing primitives, bounded analysis-corpus API
and other foundations rather than duplicating them. The final owner setup guide
must reconcile owner-setup.md with implemented environment variables, AtlasM10
backups/restore, Render/Vercel/R2/Clerk, deployment order and optional features.

## Constraints

No AI/model calls; no production migrations/deletions or provider feature
activation/title publication; no signing/releases/version bumps/tags. Keep
infrastructure flat and bundle budgets unchanged. Preserve primary owner work,
every branch, worktree and cache. Use only first-party app check diagnostics for
CI, exact full head SHA and returned IDs. Small local worker counts; serialize
builds, test packs and browser processes after the earlier PC crash.
