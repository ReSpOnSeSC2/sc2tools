# Public build and definition copy controls

Date: 2026-10-26. Branch: `codex/wave5-copy-consumers`, based on main `8d7ec51d95958418295593ddac5951421b1c69ff`.

## Status

All eleven owned source paths are authored; runtime validation is pending the shared local test slot. No tests, generators, type checks, lint, build or browser proof have run for this pack. Read-only source review and `git diff --check` are clear. No Git commit, provider operation, account write, installer operation or host clipboard write has been performed.

This is one bounded consumer migration for `ui-primitives-and-dialogs` in `docs/handoff/plan/final-plan.json`. It does not complete that roadmap item.

## Scope and behavior

- Community `Share link` copies the supplied canonical public path using the current origin at click time. Definition link icons copy the exact `/definitions#<id>` address. Rendering either control performs no clipboard write.
- Both consumers reuse the existing `useCopy` permission deadline, success state and resource lifetime handling. A denied, unavailable or five-second pending clipboard exposes a visible, selected read-only input. Manual copying does not claim automatic success. Done or Escape returns focus to the initiating control; Escape from the field stays inside an enclosing dialog.
- Path changes, including A → B → A, and definition-card unmounts retire held results. A late promise cannot reveal an obsolete fallback, move focus or emit a success toast into a newer view.
- Definition controls use the existing minimum-44px IconButton. Their fallback spans the complete heading row, keeping the URL input usable on phones. Existing catalog filter/history/hash behavior stays in the catalog implementation.
- The two native-prompt baseline entries are removed. The existing definition-heading focus signature is retained; no baseline debt is added or waived.

The shared `useCopy` and `CopyButton` files are unchanged and byte-identical between this base and queued Try source `a2df1c163a0006ebb4a1130f15cb2e76235c42e5`. This pack does not depend on importing another hook implementation.

ReplayLibrary and PublicReplayShareButton remain separate work: their explicit consent, native-share cancellation and owner/request lifetime must be preserved when migrated. PublicReplayAnalysis already uses PlayerCopyButton and needs no duplicate migration. Shared primitives, destructive confirmation flows, MobileNav, notifications and build/editor dialogs are outside this pack. Opponent dossier order remains Brief → Tendencies → Timings → History → Ladder → Identity.

## Owned paths

The exact manifest was recorded before edits in `.cache/copy-consumers-8d7-owned-paths.txt`:

1. `CHANGELOG.md`
2. `apps/web/components/community/ShareLinkButton.tsx`
3. `apps/web/components/community/__tests__/ShareLinkButton.test.tsx`
4. `apps/web/components/definitions/DefinitionsCatalog.tsx`
5. `apps/web/components/definitions/DefinitionsCatalog.test.tsx`
6. `apps/web/lib/help/articles/builds/community-builds.ts`
7. `apps/web/lib/help/articles/builds/custom-builds.ts`
8. `apps/web/scripts/ui-lint/baseline.json`
9. `apps/web/tests/e2e/copy-consumers-fixture.mjs`
10. `apps/web/tests/e2e/copy-consumers.spec.ts`
11. `docs/handoff/copy-consumers-checkpoint.md`

Existing owner `.tmp` files, committed screenshots and prior cache evidence are preserved and have not been executed.

## Pending verification

1. Run the two affected consumer suites and existing shared useCopy/CopyButton contracts at at most two workers. New cases cover no-mount writes, canonical addresses, denied/missing clipboard, selected fallback, dialog Escape ownership, five-second pending recovery/retry, path ABA, unmount and filtering a definition away/back.
2. Run full web types, strict owned-file lint, Help generation and UI rule tests/ratchet. Confirm precisely two prompt signatures disappear with no new debt.
3. After source review, run one final production build and unchanged budgets. The synthetic fixture reads that build's CSS and committed fonts; it must not substitute a smaller generated stylesheet.
4. Run the six actual-component browser cases at one worker with pinned local Chromium, both themes and phone/tablet/desktop projects. Verify resolved colors/fonts, exact selected URLs, native keyboard focus/Escape/Done behavior, dialog containment, delayed-result retirement, minimum targets, full-row fallback geometry and unchanged shared AA checks. Include the real compact CommunityBuildActionsBar at 320px and 390px, retaining real vote/export control sizes with synthetic action boundaries. Capture the fallback input's measured width and neighboring bounds for review; standalone layout is insufficient proof for this caller.

All browser requests must remain intercepted on the fixture origin; clipboard modes are synthetic. Save new captures to a new cache-only output directory, preserving earlier images. Record actual commands, counts, failure evidence and final build identity after validation; do not infer proof from authored cases.
