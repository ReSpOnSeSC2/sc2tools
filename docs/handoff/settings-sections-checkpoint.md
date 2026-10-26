# Settings sections — A3 source checkpoint

2026-10-26. Source-only local stage of canonical `find-anything` PR A. This is not a claim that Settings search, global search or the whole roadmap is complete. Root owns Git, validation scheduling and delivery.

## Current scope and preservation

Worktree `C:\SC2TOOLS\.worktrees\wave3-game-workspace`, branch `codex/wave5-settings-sections`, starting at `7b795cc6f3f576e273dcdeefa2f8e177bc0cc543`.

The originally approved 25 paths (12 product, 9 test/fixture, 4 docs) were written to `.cache/settings-sections-owned-paths.txt` before edits. Original bytes and hashes, including explicit missing-file records, are retained in `.cache/settings-sections-source-only-7b795cc6/`. Root then approved exactly one additional existing test: `OverlayWidgetManager.test.tsx`, whose old nav props no longer described the real section navigator. Its original was preserved separately before editing and the manifest now contains 26 paths. No other path is owned.

## Authored behavior

- `lib/settingsIndex.ts` is a data-only catalog for Overlay and Chat sections. It imports only a tab type. There is no search input, field index, Cmd/Ctrl+K listener, provider lookup or permission query.
- Shell renders the existing OverlayManagerNav as a thin wrapper over one SettingsSectionNav; Chat uses the same leaf. Old body-local navs are removed. Desktop uses a rail; phones use one labelled native select with a 44px minimum height. Modified desktop links keep native destinations.
- All real Overlay sections are readable once on the same page. Setup and Widgets retain their respective URL, pack and widget controls without duplicate instances. The crash-course treatment is one link beneath the Overlay heading.
- The existing single health provider and visibility host now enclose only Setup/Widgets. Its interval, deadline, document-visibility, offline and disposal behavior are unchanged. Theme and Scenes are outside that host.
- The single shared token manager gains only `id="tokens"` and scroll-offset markup. Its creation, credential, selected-token, ambiguity and request lifetimes are unchanged. Token controls remain above Content. Active streaming reveal and observation use the stable content column, which contains those controls and excludes chrome; inactive Content remains unmounted.
- The nav mounts inside admitted streaming children. Token lease replacement naturally retires its observers. IntersectionObserver updates only selected value/aria-current. Bounded mutation discovery uses the existing eight-second section window and never loads a target. No passive scroll, focus, URL or router operation occurs.
- Explicit links/selects use Shell's full destination admission and existing bounded reveal/cancel/reduced-motion helper. Same-tab changes retain mounted drafts. Existing cross-tab Stay/discard, owner and action identity guards remain. Retained earlier-owner nav callbacks are fenced.
- Known old `?section=` inputs become canonical hashes. Look reaches Theme; Ghost and Ghost-build reach Ghost-coach. Widget/pack intent and unrelated extras are retained. Moved Chat/Dock routing and old pane-hint readers remain compatible.

## Authored proof; execution held

Focused source regressions cover catalog tabs/IDs, scoped/passive observers, bounded late DOM and retirement, explicit/native choices, canonical aliases/idempotence, shared tokens above Content, reduced motion, same-tab draft persistence, owner A→B→A, and unchanged one-manager/read behavior. The additional WidgetManager test changes only its obsolete nav consumer; all widget, starter-pack, owner, save and private-URL assertions remain.

A source-only re-read caught and corrected overlap between the new generic Chat field alias branch and the already-resolved legacy Chat/Dock branch: generic aliases now exclude those two legacy cases, retaining their more specific hashes. The first authored registry bytes/hash are preserved under `before-alias-correction/`; original moved-link assertions and two direct Chat variants are retained. No executed RED/GREEN is implied.

A second source-only edge was corrected in Shell: after passive scrolling leaves the admitted hash unchanged, explicitly choosing that same section must reveal it again. Explicit identical destinations now increment the existing reveal counter; URL-origin duplicate admission remains inert. The first authored Shell bytes/hash are preserved under `before-explicit-reselect/`. Existing anchor and authored browser flows retain their passive assertions and add the repeat explicit choice.

The two new browser files use the actual Shell, Overlay, Chat and streaming owner with typed synthetic transport and strict unknown/write/nonlocal ledgers, rather than fabricated section targets. Their source is authored for Light/Dark at 320/390/768/1280, native select/link behavior, passive highlighting, draft guards, delayed admission/cancellation, unique targets, presence visibility, current production CSS/fonts and full shared accessibility scanning. Runtime may expose fixture gaps; no browser outcome is claimed here.

The authored one-project browser matrix contains 12 cases and 20 full-AA/capture points: eight stable theme/width cases and four delayed-owner/cancellation cases. The Light/1280 case also retains a held-read owner A→B→A flow and checks presence stays idle outside Setup/Widgets for more than its existing 15-second cadence. All HTTP writes, unknown routes, nonlocal traffic and unapproved socket emits are denied and ledgered. Synthetic scene/popup documents and bounded local public images are separate read categories.

Only exact Next/Clerk framework identity/rendering and socket transport boundaries are adapted. InstallAppButton, Help consumers, data helpers, real forms and request ownership stay real; no installation is clicked or prompted. The first InstallAppButton-stub fixture and its hash are preserved under `browser-before-real-install/`. The later pre-failure-ledger fixture/spec bytes are preserved under `before-failure-ledgers/`. Cleanup now drains held responses, snapshots HTTP ledgers before retirement, attaches guarded socket/native/scroll evidence even after an assertion failure, and unconditionally closes the loopback listener. These are authored contracts, not executed outcomes.

The final exact manifest and hashes are `.cache/settings-sections-owned-paths.txt` and `.cache/settings-sections-source-only-7b795cc6/final-source-freeze.json`. `original-all26-hashes.json` records 19 existing originals and seven new paths. The token-owner source is byte-equal to its original after exactly the single approved target-markup substitution; no authority change is hidden by this navigation pack.

No tests, types, lint, Help generator, build, browser, Git, network, provider, account, clipboard, native-agent or StarCraft operation has run for this stage. Existing A1/A2 evidence, engine/sample assets, caches, refs and budgets are preserved. Final validation and any necessary generated Help index change await root's explicit grant and scope review.
