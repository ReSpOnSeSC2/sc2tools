# Replay sharing copy recovery

Date: 2026-10-26. Branch: `codex/wave5-replay-sharing-copy`, starting at `cf81a70a421d8881743c32b5b780e1f0c090fb4e` in `wave4-agent-dashboard`.

## Status

Local source, focused static checks, production build/budgets and native-browser verification are complete for root review. This checkpoint makes no remote CI or delivery claim. Prior Copy #763 proof belongs to its preserved source. Root owns Git and delivery; all local runtime jobs are closed and the shared slot is released.

The exact 15-path manifest was recorded before edits in `.cache/replay-sharing-copy-owned-paths.txt`. Owner `.tmp` scripts, existing caches and original screenshots are preserved and unexecuted. No actual native share, clipboard, account, provider, consent or integration write was performed while authoring.

## Controlled recovery and callers

`CopyRecoveryDialog` extracts the proved selected-input Modal presentation and guarded explicit-dismiss focus return. Callers provide controlled text, the copy input/trigger refs and the fresh object identity used by their existing `useCopy`. It never starts clipboard, native-share or API work. It stays mounted while controlled text closes; implicit retirement does not schedule an explicit trigger return. Done, X and Escape share one admitted dismissal, retain parent containment/locks, and yield to a replacement modal owner.

ShareLinkButton consumes this presentation without changing its copy/path behavior; all nine existing consumer regressions remain required. Definitions and CopyButton keep their existing inline recovery. Shared `useCopy`, Modal, focusScopes and API helper implementations are unchanged.

ReplayShareControl is extracted from ReplayLibrary with the existing consent disclosure, explicit `{ enabled: boolean }` PUT and canonical `/players/<handle>/replays` path. Its owner-scoped 20-second operation covers JWT, response body and guarded SWR cache publication, with local owner/visibility/snapshot/attempt admission before and after awaits. The cache updater itself checks admission. Exactly one acknowledged write-snapshot transition can carry an intent into its new resource; a one-shot post-commit handoff uses the freshly returned enabled handle through the newly active copy controller. There is no mount copy, automatic enable or rollback write.

Closing or retiring an already-issued, unconfirmed PUT suppresses late cache/UI/copy completion and marks only that same owner uncertain. It does not promise that abort undoes a server write. While uncertain, the control does not claim private/public state or allow stale consent/copy actions. Explicit **Check sharing status**, or reopening that unknown control, refreshes the existing settings GET. Late owner/visibility refreshes cannot clear uncertainty. Initial GET failure uses load-error copy rather than suggesting a prior write.

The initial owner-generation read uses one bound SWR `mutate()` instead of deduped mount revalidation. Initial actions remain gated even when a warm cache says `isValidating: false`. An observed successful GET is required; SWR returning old cached data after a failed GET does not count as confirmation. Initial reads are owner-scoped; unknown-status refreshes are additionally visibility-scoped. Automatic focus/reconnect/error-retry GETs are disabled for this settings control, leaving explicit recovery. No new endpoint or API/consent payload change is introduced.

The exported control keys its internal instance by the current Clerk owner. This also matches ReplayLibrary's existing keyed ownership topology when the control is mounted independently. Installed SWR consults `revalidateOnMount` only on initial mount; a subsequent uncached key change otherwise starts an automatic read alongside the forced read. The owner-keyed instance removes that duplicate without changing global SWR settings or sacrificing the forced same-owner remount refresh.

PublicReplayShareButton remains public and introduces no Clerk/consent dependency. Native share is invoked directly during the click, with path/player/attempt identity fences before any later UI or clipboard work. Native AbortError is always quiet. A held native share has no timeout-to-copy behavior; a real current non-abort failure can use its captured same-scope copy controller. New attempts retire the old success timer, preventing it from resetting a newer pending share.

## Owned paths

1. `CHANGELOG.md`
2. `apps/web/components/ui/CopyRecoveryDialog.tsx`
3. `apps/web/components/ui/__tests__/CopyRecoveryDialog.test.tsx`
4. `apps/web/components/community/ShareLinkButton.tsx`
5. `apps/web/components/analyzer/replays/ReplayLibrary.tsx`
6. `apps/web/components/analyzer/replays/ReplayShareControl.tsx`
7. `apps/web/components/analyzer/replays/__tests__/ReplayShareControl.test.tsx`
8. `apps/web/components/analyzer/__tests__/ReplayLibrary.test.tsx`
9. `apps/web/components/public-profile/PublicReplayShareButton.tsx`
10. `apps/web/components/public-profile/__tests__/PublicReplayShareButton.test.tsx`
11. `apps/web/tests/e2e/copy-consumers-fixture.mjs`
12. `apps/web/tests/e2e/copy-consumers.spec.ts`
13. `apps/web/scripts/ui-lint/baseline.json`
14. `apps/web/lib/help/articles/analyzer/replays.ts`
15. `docs/handoff/replay-sharing-copy-checkpoint.md`

Only the two retired ReplayLibrary/PublicReplayShareButton prompt allowances are removed; no baseline entry is added or moved to the extracted file. This is a bounded continuation of `ui-primitives-and-dialogs`, not completion of that roadmap item.

## Verification scope

- Preserve ShareLinkButton's nine cases and existing replay-library/filter/public-archive behavior. New recovery tests cover exact selected text, controlled retirement, explicit dismissal and remaining-parent containment/locks.
- Public-share regressions cover immediate native activation, quiet cancellation, held native outcomes after path/player/ABA/unmount, old timer versus a new pending share, clipboard deadline/retry, stale results and nested recovery focus.
- Private tests use real clientApi/owner scopes and real SWR with a shared provider/cache. Synthetic fetch models JWT/body/cache barriers, fresh-handle first-enable admission, strict late publication suppression, uncertainty, failed status GET/retry, stale owner/visibility refresh, 20-second unknown-commit behavior, held clipboard and real same-owner remount inside the installed two-second SWR dedupe window. A cache middleware only delays updater invocation; it preserves GET argument arity.
- The existing actual-component browser fixture now includes all three dialog consumers. Native share and clipboard are mocked. Real clientApi/SWR use an intercepted fixture-origin settings route, with exactly counted synthetic consent GETs and PUTs. Each case asserts three GETs (initial A, B, A) and two explicit PUTs (`enabled: true`, then `false`), rejects other/nonlocal writes, and proves no mount/owner-return copy. These are synthetic API writes; the proof must not describe them as zero API mutations.
- Planned browser scope remains six theme/project cases, one pinned Chromium worker, production CSS/fonts, actual compact 320/390 geometry and full unchanged AA checks. New captures/logs must use a new cache-only directory; preserve every earlier failure and original image.

## Completed focused proof

- All 15 original freeze hashes were checked before the first runtime. Logs are in `.cache/replay-sharing-copy-proof-cf81a70a/`; the original source-only inventory remains `.cache/replay-sharing-copy-source-freeze.json`.
- Focused consumer/lifecycle pack: **133 tests across nine suites passed**, with at most two workers. This includes the preserved ShareLinkButton nine, public share 31, controlled recovery three, real-SWR private control 22, replay-library/account/public-archive behavior, shared copy and owner request scope. The final private source was rerun with Help contracts: **57 tests across five suites passed** (22 private tests plus 35 Help tests).
- Whole-web TypeScript passed. Strict lint passed with zero warnings for the other 11 owned code/test/fixture/Help files. ReplayLibrary has three existing label-association warnings; linting the untouched HEAD source through stdin reproduced exactly those three warnings. No new allowance was added.
- Help generation produced the same 90-article index twice (SHA256 `36c349983b1476de9558c7fb581ee2be7732e3278615b41596438fb0ce807398`). Its generated source is unchanged. All **19 UI rule tests passed**; the ratchet passed over **1,695 source files / 651 existing occurrences**, with no new or stale allowance.
- Preserved first failures exposed an ambiguous test Close selector, a jsdom-only assumption about native interior Tab, four unsupported RTL type options, and the genuine duplicate account-transition GET. Tests now target the explicit X and managed focus boundaries; browser proof still requires native traversal. The account-transition regression retains exact GET owners `[A, A, B]`, and the shared-provider remount regression still requires a new GET inside SWR's two-second dedupe window. No test was skipped or weakened.

## Integrated production and browser proof

Root preserved the initial source at `8b8abaab` and normally merged actual main/UI #764 at `1862bcc5a0a680dc9d10c460337aac8b46978757`. The final local proof uses that integrated source plus the four-file visual repair described below. Evidence is in `.cache/replay-sharing-copy-proof-1862bcc5/`.

- Integrated consumer/Modal/focus/Help verification: **176 tests across 16 suites passed**, maximum two workers. Whole-web types, strict owned lint and deterministic 90-article Help generation passed. All **19 UI rule tests passed**; the ratchet passed over **1,695 files / 649 existing occurrences**, with no new/stale allowance. ReplayLibrary's same three inherited label warnings remain separately recorded.
- Read-only asset admission matched all **40 normalized engine inputs**, source hash `18a2e1b56111045cdb441d9d8868eee0b36d0b158b34ea0a79e3b9a22a69e2b2`, engine 1.6.12 / agent 0.24.7, canonical bundle `d27b37abb9997712`, and all five asset digests. Engine ZIP remains 1,252,988 bytes / SHA256 `ba357c54c2f3d69b923adc391230dc4382693eabb697b23bf287a665ad1f0858`.
- The unchanged four-game sample passes the real strict reader and availability metadata. Windows checkout bytes are 163,356 / SHA256 `05e874e4792b9e054021efbe0008a935a4cd1c4e4395b1f3e061508b476f0c40`; canonical LF bytes are 163,355 / SHA256 `91a6735e50f45776c15642ebae53f1a3f9800c1db225a99e0e631be318820473`. The initial raw-length diagnostic is preserved. No engine/sample generation, copy, compilation, download or pruning ran; post-build hashes confirm the retained assets/sample are unchanged.
- The initial direct build encountered only sandbox `EPERM` while creating generated Next types; its log is preserved. Host-access build completed. Screenshot review then found a real phone obstruction despite the first six passing browser cases: the acknowledged live-sharing toast covered the recovery footer. That first artifact/capture is retained as **visual RED**, not final proof.
- An immediate `elementFromPoint` assertion reproduced the blocked Done button in 13.4 seconds, without waiting for toast expiry. The narrow leaf repair suppresses the redundant live toast only during enable-and-copy handoff; normal enable/turn-off and copied feedback retain their paths. Its two affected suites (**35 tests**), whole-web types and strict four-file lint passed. No shared layering/helper/API/consent change was made.
- The required replacement production build passed with final build ID **`bfbsuAnXJij8Qqd7ZZilj`**. All **81 unchanged budgets** passed, including `/community` 188.6/190 kB, `/app` 234.3/240 kB and `/try` 216.7/240 kB. Post-build types, final spec lint and the 1,695-file/649-occurrence ratchet passed.
- Final pinned Chromium proof: **six cases passed** in 2.9 minutes, one worker, both themes across phone/tablet/desktop projects, real production CSS/fonts. All six immediate recovery-footer hit-tests pass; explicit turn-off confirmation, selected exact URLs, nested Escape/Tab/lock/trigger return, native cancellation, held outcomes, owner/path ABA and compact 320/390 geometry remain asserted. **36 AA reports have zero serious/critical issues**; ordinary Axe incomplete annotations remain attached, with no rule exclusions or new allowances. There are **36 new synthetic cache-only captures**.
- Each case admits exactly **three synthetic GETs** (owners A, B, A) and **two explicitly requested synthetic PUTs** (`enabled: true`, then `false`): 18 reads and 12 writes across the matrix. Other/nonlocal requests fail closed. Actual consent API writes, account/provider mutations, native shares and host clipboard writes remain zero. The real-SWR unit suite separately verifies exact unknown-status GET/failure/retry and write/visibility/owner retirement behavior.

Final machine-readable evidence: `final-browser-summary.json`, `asset-admission.json` and `final-source-proof.json` in the current proof directory. Original caches, screenshots and owner `.tmp` scripts remain preserved and unexecuted.

Review captures in `browser-final/screenshots/`:

- `mobile-360-private-replay-copy-light.png` and `mobile-360-private-replay-copy-dark.png`: recovered link with unobscured Done.
- `desktop-1280-public-replay-copy-dark.png`: native-share failure recovery.
- `mobile-360-compact-copy-light-320.png`: existing compact Community actions retain their geometry.

Root still owns source preservation, remote checks and delivery. This bounded UI consumer pack does not complete the whole UI-primitives roadmap item.

Root independently viewed the corrected private Light and Dark phone recovery,
public Dark desktop recovery and compact Community phone recovery. Three new
review copies are byte-identical to final evidence: `replay-copy-private-light-360.png`,
`replay-copy-public-dark-1280.png` and `replay-copy-compact-light-320.png` under
`docs/handoff/screenshots/`. Done is visible and immediately receives pointer
hits; no old or owner image was overwritten. Subsequent edits are checkpoint
documentation and these review copies, with runtime source hashes retained.
