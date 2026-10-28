# Handoff: SC2 Tools upgrade program (Wave 1 in progress)

Latest active state: read [the eager maintenance checkpoint](game-stats-maintenance-checkpoint.md),
[the writer prerequisite checkpoint](game-stats-writer-stage-checkpoint.md),
[the dashboard continuation checkpoint](dashboard-cache-coverage-checkpoint.md),
[the qualified 197-item ledger](roadmap-progress-2026-10-28.json) and
[the October 27 delivery checkpoint](active-2026-10-27-delivery-checkpoint.md) first.
They supersede the historical pause, pending-release and Wave 1 status below.

Written 2026-10-23 so another assistant can continue the work. Everything
needed is in this folder (`docs/handoff/`) and in the repository.

## 1. What the owner asked for

- Production-quality, professional, clean, easy-to-use upgrades across
  **every** part of the product (web app, public site, API, desktop agent,
  stream tools, admin), plus a how-to for every feature.
- Improve and polish what already exists, not only add new features.
- **Hard rule: no AI features and no AI/LLM API calls of any kind.** Stats
  come from fixed rules.
- Keep server cost flat: one Render instance (API), MongoDB Atlas **M10**,
  Cloudflare R2, Vercel (web), Clerk (auth). No new infrastructure.
- At the end, write a detailed step-by-step owner setup guide (Atlas M10,
  backups, every env var and secret each wave needs). Notes so far are in
  `plan/owner-setup.md`; the final guide should become `docs/SETUP_GUIDE.md`.
- Ship in tested PRs. The owner is fine with the assistant merging PRs
  (squash-merge) once CI is green.

## 2. Repository facts

Monorepo `ReSpOnSeSC2/sc2tools`:

| App | Stack | Checks |
|---|---|---|
| `apps/web` | Next.js 15 App Router, React, TS, Tailwind, Clerk, SWR (`useApi`/`apiCall`), vitest + RTL | `npx tsc --noEmit -p .` · `npx eslint <files> --max-warnings=0` · `npx vitest run [files]` · `npm run help:index` (must leave no diff) · `npm run build && npm run perf:budget` |
| `apps/api` | Express + MongoDB, jest + mongodb-memory-server | `npm run --silent typecheck` · eslint · `npx jest [files]` |
| `apps/agent` | Python 3.12, PySide6 desktop app | `QT_QPA_PLATFORM=offscreen python -m pytest -q` |
| `apps/replay-engine` | Python, sc2reader | `python -m pytest -q` |

Conventions:
- Conventional commits. Files must stay ≤ 800 lines (lint `max-lines`).
- Design system: `docs/design-system.md`, `apps/web/components/ui/**`,
  tokens in `apps/web/app/globals.css`. Light and dark themes, keyboard and
  screen-reader accessible, works at 390 px.
- **Help articles are data**: one file per article at
  `apps/web/lib/help/articles/<category>/<slug>.ts` (default export
  `HelpArticle`, see `lib/help/types.ts`, categories in
  `lib/help/categories.ts`). Run `npm run help:index` after adding one.
  They show at public `/help`, `/help/<slug>` and in Settings → Help.
- Link to help with `<LazyHelpLink slug>` (from `components/help/LazyHelpLink`).
  **Do not import `HelpLink` statically** outside `components/help/**`,
  `app/help/**` and the report form; it puts every article's text into
  the page's first-load JS. `lib/help/__tests__/helpLinkImports.test.ts` enforces this.
- Shared states from Wave 1: `components/ui/QueryState.tsx`,
  `RequestError.tsx`, `SectionBoundary.tsx`; report form through
  `components/feedback/LazyReportIssueModal.tsx` and `ReportErrorAction.tsx`
  (one `prefill {type, subject, message}` API); `lib/authLinks.ts`
  (`signInHref`/`signUpHref`, same-site only); `lib/useDocumentTitle.ts`;
  `lib/filterContext.ts` (`describeActiveFilters`, `applyFilterPatch`).
- CHANGELOG.md: add user-facing entries under `## [Unreleased]`
  (### Added / ### Fixed, plain language).
- The PR template has sections What / Why / How tested / Screenshots /
  Migration & rollback / Definition-of-done checklist. Fill them in.
- Never commit `apps/api/data/ladder-map-pool.json` (some API tests rewrite it;
  restore it with `git checkout`).
- Agent releases: version bump + tag `agent-vX.Y.Z` (the owner pushes tags).

## 3. Where things stand

### Shipped (merged to main)
- #643–#645: build check-in (declare your build at loading or after the
  game, opponent's build, "Add new build"), agent 0.19.0.
- #646 (Wave 1, part 1): help center (`/help`, Settings → Help, `HelpLink`
  side sheet, search) and a CSS cascade fix.

### Open: PR #647, branch `claude/build-selection-tracking-en3jx0`
This is **Wave 1 phase 2a**: nine items cherry-picked and integrated on top
of main, plus integration fixes, a CHANGELOG entry and one bundle fix.

The nine items:
1. data-states-recovery
2. help-and-feedback-menu (including API `/v1/messages` report type and context)
3. app-shell-quick-fixes (manifest, safe areas, title template, `next/dynamic` splitting, perf budget)
4. global-filter-clarity
5. settings-quickwins
6. builds-correctness-fixes
7. visitor-dead-ends
8. live-scouting-openings-fix
9. backup-status-honest-copy (Atlas backup health on the admin page and a restore runbook)

Local full suites passed at `e90d48ae`: web 5,846 tests, API 4,861, replay
engine 908.

**CI status.** Everything is green except "Responsive e2e smoke (public pages)",
which failed at its **Bundle budget** step (`npm run perf:budget`, see
`apps/web/perf-budget.json`):

| Route | main (kB) | PR (kB) | Budget (kB) |
|---|---|---|---|
| `/` | 192 | 225.5 | 215 |
| `/app` | 217 | 256.7 | 240 |
| `/builds` | 243 | 391.5 | 270 |
| `/admin/global-trends` | 482 | 522 | 520 |

- **Fix pushed.** Commit "fix(web): load help links on demand…" moves
  every first-load `HelpLink` to `LazyHelpLink`. This should fix `/builds`
  and part of `/app`. It is not yet confirmed by CI.
- **Probably still over: `/` and `/admin/global-trends`.** The root
  chrome added `HelpMenu`, `ConnectionStatus` (with a global SWRConfig),
  the report-form wiring and `LogoMark` to `components/chrome/AppChrome.tsx`,
  which every route loads.
- **Next step.** Read the CI "Bundle budget" output. Then either
  lazy-load the heavy parts (for example the HelpMenu dropdown contents,
  or ConnectionStatus's banner) or raise the budget with a written reason
  in the PR. To compare chunks, build main and the branch and diff
  `.next/app-build-manifest.json` per route.

**Review findings, unfixed: `review-findings-phase2a.md`.**
- 12 are CONFIRMED (reproduced by a verifier). Fix these before merging.
- 32 are UNVERIFIED (the verifier was cut off). Check each one, then fix it or drop it.

Highlights of the confirmed findings:
- The report form's lazy chunk failing takes the whole app to `global-error`.
  Add an error boundary in `LazyReportIssueModal` with an email fallback.
- `SaveToLibraryButton` slugs collide for long titles: the stamp is cut off
  by `.slice(0, 80)`.
- `BuildDossier` checks loading before error, so Retry flickers and loses focus.
- `/builds` renders nothing until Clerk loads.
- The dossier's public-profile check scans every user's opponents rows
  (api `community.js` ~1496).
- Plus help-copy inaccuracies.

After the fixes:
1. Fill in the PR body.
2. Get CI green and squash-merge #647.
3. Merge main back into the branch (`git merge origin/main`, no rebase).
4. Continue with phase 2b.

### Wave 1 phase 2b: 25 section-polish items
- Specs: `plan/phase2b-items.json`. Each entry has id, title, why, spec,
  augments, audit_findings, howto, depends_on and touches. Implement
  `spec`, `augments` and `audit_findings`, and ship the `howto` as a help
  article.
- **Three are built, as patches in `patches/`**, based on `e90d48ae`:
  - help-content-backfill: 26 new help articles plus a "How to read this"
    header on every analyzer section.
  - analyzer-home-polish-1
  - reviews-coaching-docs-1

  Their reports (summary, tests, changelog line, follow-ups) are in
  `plan/phase2b-done-reports.json`. Apply them with
  `git am docs/handoff/patches/2b-<id>.patch` on a branch from the merged
  main. Expect small conflicts in `lib/help/types.ts`, `categories.ts`,
  `index.ts`, `HelpLink.tsx` and `LazyHelpLink.tsx`. Keep both sides, then
  regenerate `index.generated.ts` with `npm run help:index`.
- **Remaining 22:**
  - game-page-polish-1, game-page-polish-2
  - opponents-polish-1, opponents-polish-3
  - builds-polish-1
  - community-polish-1, community-polish-2
  - guides-polish-1, guides-polish-2
  - profiles-replays-polish-1
  - reviews-coaching-polish-1
  - streamer-polish-1
  - settings-onboarding-polish-1
  - landing-try-polish-1, landing-try-polish-2, landing-try-polish-3
  - chrome-nav-polish-1
  - admin-polish-1, admin-polish-2, admin-polish-3
  - agent-gui-polish-1, agent-gui-polish-2
- **Ship plan:** build them, integrate, review and test, then open one PR
  ("Wave 1, part 3"). Smaller PRs per area are also fine.

### Waves 2–6: the rest of the roadmap
- `plan/final-plan.json` holds `vision`, `waves`, `items` (197: wave 1 = 36,
  2 = 51, 3 = 32, 4 = 25, 5 = 24, 6 = 29), `dropped` and `deferred`.
  - Each item has id, kind, wave, title, area, why, spec, augments, howto,
    effort, impact, touches, depends_on and folded_audit.
  - Build items in `depends_on` order.
- The owner explicitly wants these:
  - **Battle report**, wave 3: a rules-based 1–4 paragraph story of each
    replay with map snapshots, no AI. Sharing it is in wave 6.
  - Wave 5: guided-tours, twitch channel-point reward actions,
    layout-editor, randomizer-without-OBS and challenge stats.
  - Wave 6: landing-live-proof, camera-follow-and-attention,
    hotkey-habits, and a React port of the coaching Locker.
- A readable version of the plan was published as a claude.ai artifact:
  https://claude.ai/artifact/7UFyy69Wg1AHFUXRCGxjYv

## 4. Owner setup notes so far
See `plan/owner-setup.md`. From phase 2a, all optional:
- `PLATFORM_INTEGRATIONS_RETURN_URL` on Render. If unset, it now defaults to
  `https://sc2tools.com/settings?tab=overlay#platform-connections`.
- `NEXT_PUBLIC_BUILD_SHA`. It is filled from Vercel's
  `VERCEL_GIT_COMMIT_SHA` when Vercel exposes system env vars.
- Backup health uses the existing `ATLAS_*` service account (Project Read
  Only). Check Admin → Infrastructure → "Database backups" after deploy.
- Restore runbook: `docs/runbooks/restore-database.md`. One unverified
  finding says its `wipeGames` re-run step is unsafe for date-range wipes;
  check it.

## 5. Gotchas learned the hard way
- **node_modules symlinks.** If you symlink `node_modules` into a git
  worktree, never `git add -A`: the symlink gets committed. Merging that
  commit into a checkout deletes the real (ignored) `node_modules` there.
- **Bundle budget.** Run `npm run build && npm run perf:budget` before
  pushing anything that adds imports to shared chrome or to a page.
- **Tests and lazy components.** A component behind `React.lazy`/`next/dynamic`
  needs `findBy…` or `waitFor` in tests. In vitest, `next/dynamic` resolves
  to the pages-router loader, which swallows load errors.
- **Flaky test.** API test `customBuildsMemorySafety` ("an enqueue arriving
  as the worker exits") is timing-sensitive under load.
- **Not done.** The worktree item branches and the unfinished phase 2b
  attempts lived only in the old container. The three finished ones are
  the patches here.
