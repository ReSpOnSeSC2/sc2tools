# Public build and definition copy controls

Date: 2026-10-26. Branch: `codex/wave5-copy-consumers`. Original base: main `8d7ec51d95958418295593ddac5951421b1c69ff`. Root preserved the initial source as `ed60455b`, the scoped fixture type correction as `99374d88`, and normally reconciled current main/More at `c1b07eae2e8bedc3419ee9a35cecf60b9fca3ac2`. The reviewed ancestry reconciliation preserved the complete source tree (`18f85a408504fe472b5af3072f85ed8512e0d45f`). Final copy-dialog repairs are locally validated on that head, pending root's commit/review.

## Status

Local validation is complete: affected tests, full web types, strict owned lint, Help generation, UI ratchet, final production build, unchanged budgets and all six native-browser cases pass. All runtime processes are closed and the shared heavy slot has been released. Root owns the final commit, remote CI and delivery; this checkpoint does not claim a production deployment. No account/provider write, installer operation or host clipboard write was performed.

This is one bounded consumer migration for `ui-primitives-and-dialogs` in `docs/handoff/plan/final-plan.json`. It does not complete that roadmap item.

## Scope and behavior

- Community `Share link` copies the supplied canonical public path using the current origin at click time. Definition link icons copy the exact `/definitions#<id>` address. Rendering either control performs no clipboard write.
- Both consumers reuse the existing `useCopy` permission deadline, success state and resource lifetime handling. A denied, unavailable or five-second pending clipboard exposes a visible, selected read-only input. Manual copying does not claim automatic success.
- Share link uses the existing Modal for manual recovery, with the copy input as its explicit initial focus. The compact Community actions row retains its normal geometry. There is no fallback info toast to cover the field or dismissal controls. Done, X or Escape closes this dialog before any enclosing modal; the parent keeps its focus containment and scroll lock.
- Explicit Share dismissal restores its current trigger after the shared Modal cleanup. A fresh memoized identity for each path transition fences A → B → A; restoration is consumed once and checks the connected, enabled current button plus existing modal focus ownership. Stale callbacks, unmounts and a replacement modal cannot take that focus. Shared Modal/focus-helper APIs are unchanged.
- Path changes, including A → B → A, and definition-card unmounts retire held results. A late promise cannot reveal an obsolete fallback, move focus or emit a success toast into a newer view.
- Definition controls use the existing minimum-44px IconButton. Their inline fallback spans the complete heading row, keeping the URL input usable on phones. Done or Escape returns to that icon. Existing catalog filter/history/hash behavior stays in the catalog implementation.
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

## Verified checks

- Initial focused pack: 65 tests in six suites passed with at most two workers: ShareLinkButton, DefinitionsCatalog, useCopy, CopyButton, Help articles and generated Help index. After the reviewed Modal repair, the affected Share suite passes all nine cases, including held-permission focus changes, retained stale dismissal after A → B → A, and replacement-modal ownership. The updated Help article suite also passes all 18 cases. Unchanged suites were not repeatedly rerun.
- Full web types pass, including after the final production build. Strict lint passes on all eight owned code/test/Help files with zero warnings. Help generation twice produces the same unchanged 89-article index (SHA-256 `82d169ee6708c600d6b6622846cc5d3b7a28525c5836705e5d357287c2b2a3c9`). UI rules pass all 19 checks; the final ratchet passes 1,671 source files / 654 existing occurrences, with no new or stale allowances.
- Retained-engine admission verifies exactly 40 normalized canonical inputs against the retained Try source and its previously verified input snapshot. Engine `1.6.12`, agent `0.24.7`, Pyodide `314.0.7`; local bundle `d27b37abb9997712`, ZIP 1,252,988 bytes, SHA-256 `ba357c54c2f3d69b923adc391230dc4382693eabb697b23bf287a665ad1f0858`. Only two missing engine files were copied; four identical runtime files were reused. The old pointer and six old active assets were preserved, and the ignored pointer changed atomically. No compilation, publisher, pruning or download ran.
- The final replacement direct Next production build passes with the official dummy/local CI flags and retained validated assets. All 81 unchanged route budgets pass, including `/community` 188.5/190 kB and `/try` 213.8/240 kB. Fresh build ID: `zwxqZmD4D9WvZC4oo3LPA`.
- Native browser matrix: six of six cases pass in 1.8 minutes, one pinned Chromium 1228 worker, both themes at 360/768/1280 project widths. Each case also checks the real compact CommunityBuildActionsBar at 320 and 390 pixels. Its real vote/score/export geometry is retained; mutation boundaries are synthetic and reject writes. The manual input now measures 278px at 320px and 348px at 390px, with unchanged compact row/bar dimensions. Full unchanged AA checks produce 24 reports with zero serious/critical findings; no contrast exclusion or new allowlist entry was introduced.
- The browser proof uses the final production CSS, committed fonts and resolved theme assertions. It verifies exact selected read-only URLs, inner and remaining-parent Tab/Escape ownership, Done/X/current-trigger return, scroll locks, no fallback toast, deadline/retry and late-result retirement, path ABA, and filtering a definition away/back. Every request stays intercepted on the synthetic fixture origin; clipboard delivery is mocked. No Next/API server was needed. Four final captures were personally reviewed as legible and contained; all screenshots stay cache-only.

## Evidence and preserved failures

Initial static logs are in `.cache/copy-consumers-proof-ba210e5f/`. The original fixture-window TS2352 failure is retained alongside the passing scoped `typeof window` correction.

Final engine/build/browser evidence is in `.cache/copy-consumers-proof-c1b07eae/`:

- `engine-reuse-proof.json` and `engine-before/`: source/asset admission and preserved old pointer/assets.
- `next-build.log`: initial sandbox EPERM creating a generated `.next` directory. The identical reviewed-host retry passes in `next-build-host.log`.
- `browser-first/`: fixture bundling stopped before rendering because the unrelated lazy Help closure was not isolated. The adapter now retains the actual Help text/icon styles and native href boundary; tested cards supply no Help prop, asserted in the browser. No Node polyfill or production change was used.
- `browser-second/`: the fixture's missing history notification caused a search-restoration failure. Its accepted scoped event bridge now notifies after one successful native push/replace, matching Next's history integration. This attempt also preserves the real compact-layout finding: a 68.55px-wide input at 320px, with a toast obscuring the lower fallback. That visual evidence caused the reviewed Share-only Modal repair.
- `modal-share-units.log`: initial focus-restoration RED; `modal-share-focus-fix-units.log`: all nine affected cases green after the guarded leaf restoration.
- `modal-full-types.log`, `modal-owned-lint.log`, `modal-help-articles.log`, `modal-ui-ratchet.log`: final affected static proof.
- `next-build-modal.log`, `modal-budgets.log`, `modal-post-build-types.log`: final replacement production artifact proof.
- `browser-third/`: final six-case result, all 24 AA reports and cache-only captures. `final-browser-summary.json` records build assets and measured compact bounds.

Representative final captures under `browser-third/shots/` are `mobile-360-compact-copy-light-320.png`, `mobile-360-compact-copy-dark-390.png`, `mobile-360-definition-copy-light.png` and `desktop-1280-definition-copy-dark.png`. Earlier evidence and all original committed images remain preserved. No owner `.tmp` script was executed.

Root reviewed the final source and phone/desktop captures. Copies of the reviewed compact Light 320px and desktop Dark definition fields are preserved in `docs/handoff/screenshots/copy-link-manual-light-320.png` and `docs/handoff/screenshots/copy-definition-manual-dark.png`, with matching hashes. Exact-head remote CI and delivery remain pending. Other copy/consumer migrations listed above remain separate roadmap work.

## Combined main validation

Root integrated Execution/Try source at `f7311052`, retaining both copy and timing
Help and clarifying the existing three-observation game comparison. All 83 checks
across nine copy, Help, Guide, CTA and real Macro-edit suites pass, along with
whole web types, strict merged-Help lint and UI19/1,693 files/653 inherited
occurrences. Both copy runtime files are byte-identical to fully green `b07f1c0f`.
Actual Execution main `8daff145` is normally reconciled at `877b4525` with an
identical whole tree before/after the ancestry merge. The recorded local
production/browser artifact predates only these independent integrations;
fresh exact-head remote build/web/responsive checks are required.
