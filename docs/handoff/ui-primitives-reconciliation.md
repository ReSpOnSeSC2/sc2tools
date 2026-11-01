# UI primitives: the migration inventory, reconciled (October 31 UTC)

Roadmap item `ui-primitives-and-dialogs` (ledger ordinal 69) asks to
"Reconcile remaining native confirm/prompt and manual-CTA consumers against the
full migration inventory", while keeping typed destructive approvals and the
notification bell's ready-and-merged focus. The inventory is the canonical
plan's migration list for this item (`docs/handoff/plan/final-plan.json`, item
`ui-primitives-and-dialogs`, step 3), its three augments, and the follow-up
list in `docs/handoff/ui-primitives-checkpoint.md:57-73`. The item stays
partial: the literal list is done; parts of the augments and the remaining
manual link CTAs are not.

## The literal list

| Plan or checkpoint | Now |
| --- | --- |
| BuildDossierModal and EditCustomBuildLauncher on `Modal` xl | Done (`apps/web/components/builds/BuildDossierModal.tsx:56`, `apps/web/components/builds/EditCustomBuildLauncher.tsx:322`). |
| MoreSheet and MobileNav on `Sheet` | Done (both import `@/components/ui/Sheet`). |
| FilterBar, GameLengthFilter and NotificationBell on `Popover` | Done (`apps/web/components/analyzer/FilterBar.tsx`, `apps/web/components/analyzer/GameLengthFilter.tsx`, `apps/web/components/notifications/NotificationBell.tsx`). The bell's focus behavior is unchanged here. |
| Replace every `window.confirm`/`prompt` | Done: no native `confirm`, `prompt` or `alert` call remains in `apps/web` outside tests. Destructive flows use `ConfirmDialog`, `useConfirm` or `DestructiveConfirmDialog`. The UI lint flags new native `confirm` and `prompt` calls; it does not check `alert`. |
| Swap `CtaLink` and `PRIMARY_LINK_CLS` for `LinkButton` | Done in this slice: the two remaining local `CtaLink` components (`apps/web/components/analyzer/EmptyStates.tsx`, `apps/web/components/onboarding/OnboardingChecklist.tsx`) now use `LinkButton`; `PRIMARY_LINK_CLS` no longer exists. |
| Delete the dead OpponentsList and BuildsPanel | Done (neither file exists). |
| Admin-only gallery behind a real server gate | Done: `/admin/design` mounts the gallery only after `/v1/me` confirms an admin (`apps/web/app/admin/design/AuthorizedGallery.tsx:15-21`). |
| UI lint ratchet in web CI | Done: `npm run ui:lint` runs in `.github/workflows/web-ci.yml:54`. |

## The plan's augments

Paths are under `apps/web` unless they start with `docs/`.

| Augment | Now |
| --- | --- |
| BuildDossierModal at `2xl`, 44 px Full page link and close button, actions ordered Edit, Publish, Full page, Delete, focus return, phone layout | Not done: the modal is `xl` (`components/builds/BuildDossierModal.tsx:56`) and the Full page link is 32 px (`h-8`, `:114`). The order, focus return and phone layout were not checked. |
| EditCustomBuildLauncher loading and error inside the modal, with Retry | Present: the error renders in the modal, with Retry in its footer (`components/builds/EditCustomBuildLauncher.tsx:322-323`). |
| `buttonClasses` exported from `Button.tsx` and `components/ui/index.ts`, with a class-parity test | Present (`components/ui/index.ts:11`, `components/ui/__tests__/LinkButton.test.tsx:11`). Header's sign-in links use it (`components/chrome/Header.tsx:124-127`). |
| UI lint rules for new hand-written `hard-press … rounded-full` and `rounded-(md\|lg) … bg-accent` link CTAs | Present: `handrolled-link-button` and `handrolled-accent-link` (`scripts/ui-lint/rules.mjs:206-208`). |
| ThemeToggle `sm` size | Present (`components/ui/ThemeToggle.tsx:8`). |
| `docs/design-system.md` button guidance | Partly: the `radius-md` claim is gone and "Buttons and navigation" says when to use `Button` or `LinkButton` (`docs/design-system.md:294-299`); it does not describe the pill shape. |
| A shared `components/chrome/Wordmark.tsx` | Not done (no such file). |
| Every hand-written CTA replaced | Not done. Header and `app/error.tsx` use the shared classes; the links below remain. |

## Remaining manual link CTAs

These are the checkpoint's "manual link CTAs"
(`docs/handoff/ui-primitives-checkpoint.md:69-70`) and the rest of the
augments' list:

- The UI lint baseline still allows 18 hand-written link buttons or accent
  links in 16 files (`scripts/ui-lint/baseline.json`): `app/app/layout.tsx`,
  `app/donate/page.tsx`, `DoctorBanner`, `OpponentDossierStates`,
  `ReplayArchiveStatusCard`, `SettingsMisc`, `BuildDetailView`,
  `BuildsLibrary`, `CoachingBookingAlert`, `MobileNav` (three),
  `SaveToLibraryButton`, `AgentUpgradeNotice`, `AgentLiveUpsell`,
  `ImportSummary`, `TryResume` and `DonateBanner`.
- Accent or bordered links the lint does not catch: `ModeRunner.tsx:256`,
  `DailyEmptyState.tsx:35`, `CompanionShowcase.tsx:61` and ReplayDemo's "Skip
  the demo" link (`components/landing/ReplayDemo.tsx:219`).
- Not checked: `app/not-found.tsx`, InstallPrompt, GuidesStrip and AppChrome's
  signed-out links.
- MobileNav's sign-in and sign-up links are `AuthContextLink`s, so they would
  take `buttonClasses`, as Header's do, rather than `LinkButton`.

## What this slice changes

- `EmptyStates`' "Download agent" and "Open Devices" links use `LinkButton` at
  the medium size (44 px), keeping their primary and secondary variants and
  now taking the shared pill shape. Its choice cards keep a 44 px minimum and
  grow when a label wraps.
- `OnboardingChecklist`'s "Open Devices" and "Download" links use `LinkButton`
  at the small size with a 44 px minimum height, up from 36 px, so they meet
  the touch-target rule; the download click handler is unchanged. The small
  pill is slightly wider than the old link, so the checklist row's text column
  is a little narrower on phones.
- Existing tests cover the links' names and destinations. No visual check in a
  real browser.

## The second slice (November 1 UTC)

This slice closes the augments and the manual link CTAs listed above. Paths are
under `apps/web`.

| Augment or link | Now |
| --- | --- |
| Dossier modal width | Kept at `xl`. The augment names its target as "'2xl' (today's max-w-4xl)", and the Modal's `xl` is `sm:max-w-4xl`; its `2xl` is `max-w-6xl`, wider than the augment means. The title stays "<build name> dossier", which carries the build name. |
| Dossier actions | Ordered Edit, Publish, Full page, Delete, with the destructive action last before the overflow menu. Full page is a `LinkButton`. Each of the four is a 44 px target (`min-h-11`), up from 36 px buttons and a 32 px link. The close button was already 44 px. Focus return to the opening trigger and the phone bottom sheet are the Modal's defaults, and the existing test covers focus return. |
| Shared wordmark | `components/chrome/Wordmark.tsx` (sizes `md` and `sm`, with the accent tick) is used by Header, MobileNav, Footer and the app rail. The Footer's semibold mark without a tick is gone. |
| UI lint baseline (18 link CTAs in 16 files) | 17 now use `LinkButton`, or `buttonClassName` on the elements that are not `next/link`: the `<a>` in `app/app/layout.tsx`, the external `<a>` on the donate page, and MobileNav's two `AuthContextLink`s. `--prune-baseline` retired their 17 allowances (652 occurrences to 635). One allowance stays on purpose: `CoachingBookingAlert` is an h-8 alert chip sized to the app context bar's other h-8 controls (the augment's ThemeToggle `sm`), not a call to action. |
| Links the lint does not catch | ModeRunner's and DailyEmptyState's accent `<a>` CTAs, CompanionShowcase's download link, ReplayDemo's "Skip the demo" and GuidesStrip's "Browse build guides" now use `LinkButton`. ServiceWorkerRegister's Later and Reload buttons take `buttonClassName` (ghost and primary). |
| Install sheet | InstallPrompt's install CTA is the full-width primary `Button` (it keeps `disabled` and `aria-busy` while the browser's dialog opens), its "Or install via Chrome menu" fallback is a small ghost `Button`, and InstallInstructions' "Got it" is a full-width primary `Button`. Only the dismiss icon button keeps its own style. |
| Already shared | `app/not-found.tsx` and `app/error.tsx` already use the shared classes, and AppChrome's signed-out links already use `buttonClassName`. |
| `docs/design-system.md` | "Buttons and navigation" now describes the pill shape, the rule against hand-written copies, `buttonClassName` for non-`next/link` elements, and a small table of when to use Button, LinkButton, buttonClassName or a text link. |

Typed destructive approvals and the notification bell's ready-and-merged focus
are untouched. Migrated links move to the shared pill shape and sizes, so some
grow slightly; no real-browser visual check was made.
