# UI primitives: the migration inventory, reconciled (October 31 UTC)

Roadmap item `ui-primitives-and-dialogs` (ledger ordinal 69) asks to
"Reconcile remaining native confirm/prompt and manual-CTA consumers against the
full migration inventory", while keeping typed destructive approvals and the
notification bell's ready-and-merged focus. The inventory is
the canonical plan's migration list for this item
(`docs/handoff/plan/final-plan.json`, item `ui-primitives-and-dialogs`, step 3)
and the follow-up list in `docs/handoff/ui-primitives-checkpoint.md:57-73`.

## The inventory

| Plan or checkpoint | Now |
| --- | --- |
| BuildDossierModal and EditCustomBuildLauncher on `Modal` xl | Done (`apps/web/components/builds/BuildDossierModal.tsx:56`, `apps/web/components/builds/EditCustomBuildLauncher.tsx:322`). |
| MoreSheet and MobileNav on `Sheet` | Done (both import `@/components/ui/Sheet`). |
| FilterBar, GameLengthFilter and NotificationBell on `Popover` | Done (`apps/web/components/analyzer/FilterBar.tsx`, `apps/web/components/analyzer/GameLengthFilter.tsx`, `apps/web/components/notifications/NotificationBell.tsx`). The bell's focus behavior is unchanged here. |
| Replace every `window.confirm`/`prompt` | Done: no native `confirm`, `prompt` or `alert` call remains in `apps/web` outside tests; destructive flows use `useConfirm` and `DestructiveConfirmDialog`. The UI lint flags new ones. |
| Swap `CtaLink` and `PRIMARY_LINK_CLS` for `LinkButton` | Done in this slice: the two remaining local `CtaLink` components (`apps/web/components/analyzer/EmptyStates.tsx`, `apps/web/components/onboarding/OnboardingChecklist.tsx`) now use `LinkButton`; `PRIMARY_LINK_CLS` no longer exists. |
| Delete the dead OpponentsList and BuildsPanel | Done (neither file exists). |
| Admin-only gallery behind a real server gate | Done: `/admin/design` mounts the gallery only after the API confirms the account (`apps/web/app/admin/design/page.tsx:7-11`). |
| UI lint ratchet in web CI | Done: `npm run ui:lint` runs in `.github/workflows/web-ci.yml:54`. |

## What this slice changes

- `EmptyStates`' "Download agent" and "Open Devices" links and its ready-state
  cards use `LinkButton` at the medium size (44 px), keeping their primary and
  secondary variants. They now take the shared pill shape.
- `OnboardingChecklist`'s "Open Devices" and "Download" links use `LinkButton`
  at the small size, matching their previous 36 px height in the checklist's
  compact rows; the download click handler is unchanged.

## Not claimed

- Other links styled by hand with the accent color remain in
  `AdminShell`, the donate page, `BuildEditorSaveBar`, `DownloadCard`,
  `OnboardingDone` and `ServiceWorkerRegister`. They are outside the plan's
  named inventory. Some are not calls to action (MobileNav's active tabs, skip
  links), so each needs its own look before moving to `LinkButton`.
- No visual check in a real browser. Tests and the UI lint cover the changed
  components.
