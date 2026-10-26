# Reusable UI contracts checkpoint

2026-10-25. Branch `codex/wave5-ui-primitives`, preserved in
`.worktrees/wave3-game-workspace`, initially based on `cf25bc88`. ADR 0064.
This is the first focused pack of `ui-primitives-and-dialogs`, not completion
of the entire roadmap item. No deployment or production build is claimed.

## Implemented

- Sheet, nonmodal Popover, IconButton, CopyButton/useCopy, local useConfirm,
  SkeletonChart/Kpi and public primitive exports. No dependencies or versions
  changed. Modal's existing responsive defaults remain unchanged.
- Shared focus ownership separates dismissal from modal Tab containment,
  including outside portals, native named radios and closed details summaries.
  Controlled close restoration handles React's commit selection behavior;
  outside pointer restoration preserves a real clicked control and recovers
  from body/dialog-root fallback. Parent teardown transfers return targets.
- React overlay layers remain below the existing global Toast layer. The
  notification placement helper is extracted without migrating Bell's lazy
  content/readiness behavior or importing its auth/data stack into Popover.
- Promise confirmation rejects concurrent asks and fences pending and captured
  callbacks by issuing scope identity. Existing Review dialogs and typed
  `UNPAIR` are unchanged. Copy has visible selected fallback and stale-result
  fencing rather than native prompts.

## Verification

- 74 focused checks across 16 files pass, including existing Modal center/side/
  nested behavior, focus hook and all 15 NotificationBell checks. Full web
  typecheck and strict lint of all 26 owned source/test files pass after the
  final native pointer focus fix.
- Twelve actual-source Chromium checks pass at 360/768/1280 using one worker.
  They cover native details/radios, full portal Tab bridges, Escape ordering,
  parent teardown, pointer focus, outer scrolling, nested Modal click/occlusion,
  Toast stacking, sheet/footer bounds and denied-copy fallback. The host
  clipboard is replaced with an explicit rejecting fixture before page load.
  Every browser request is intercepted; no server is started and unexpected
  requests are asserted empty.
- Final browser proof uses actual Tailwind/global tokens, committed
  Hanken/Bricolage/Fraunces WOFF2 font definitions and font readiness, plus dark
  right/light bottom sheets. All 12 checks pass with one worker in 11 seconds.
  Full types and strict fixture lint also pass after that fixture-only change.
- Logs and capture paths are local ignored artifacts under
  `apps/web/.cache/ui-primitives-*` and `apps/web/test-results/ui-primitives`.
  Browser startup uses the already-installed matching host Chromium 1228 via
  `PLAYWRIGHT_BROWSERS_PATH`; no browser download is needed.

Representative final-font captures are
`docs/handoff/screenshots/ui-primitives-mobile-dark-right-sheet.png`,
`ui-primitives-mobile-light-bottom-sheet.png` and
`ui-primitives-desktop-custom-portal.png` in the same folder. All three are
Root inspected all three final-font captures and found them legible and
contained. The source worktree has been fast-forwarded to actual mainc7bf67e7
without dropping authored files. A production build and final bundle checks
are still required.

## Remaining gates and follow-up scope

- Review and commit this pack, then integrate current main and the pending
  accessibility foundation without dropping either focus/layout behavior.
  Production Next build and unchanged bundle budgets remain a later root gate.
- Admin-only design gallery must use a real server admin gate. AdminShell alone
  is cosmetic. Avoid overwriting the accessibility pack's design-system docs.
- Implement the UI lint ratchet with exact normalized violation signatures and
  explicit chart/overlay allowlists, then wire it into web CI. Existing
  TypeScript AST support is sufficient; no new dependency is needed.
- Migrate BuildDossierModal/EditCustomBuildLauncher, MoreSheet/MobileNav,
  filters and NotificationBell in focused reviewed changes. Keep Bell's
  ready-and-merged initial focus. Replace remaining native confirm/prompt and
  manual link CTAs while preserving typed destructive approval flows.
- Gallery, ratchet, broad consumer/chrome migrations and roadmap completion
  remain pending. Existing LinkButton, focus foundations and skeleton rows were
  already present and are not claimed as new work here.
