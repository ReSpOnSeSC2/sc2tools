# Settings PR A — sections checkpoint

Updated 2026-10-26. Local implementation and validation are complete; PR integration, full CI and delivery remain root-owned. No deployment is claimed.

## Scope and current behavior

- Canonical Overlay and Chat sections use the same navigation catalog and leaf navigation component.
- Overlay exposes Setup, Widgets, Scenes, Build profile, Ghost coach, Theme and shared URL-token controls; Chat retains its real settings forms.
- Desktop uses a section rail; compact layouts use a native select with 44px controls. Passive observation changes highlighting only, with no URL, focus, scrolling or private-panel activation.
- Explicit choices and repeated selections pass the complete SettingsShell guard before navigation/reveal. Stay preserves the draft, admitted URL and query extras.
- Ghost/Chat/Dock aliases and existing section inputs remain supported; pack/widget extras keep their precedence. The learning link remains directly under the heading.
- Token controls sit inside the persistent streaming tabpanel, above the private body. One authority persists across Overlay/Chat; only the credential-owned private body is keyed.
- Pending/unknown credentials keep a valid selected tabpanel while withholding private forms. Owner/credential changes retire stale work; inactive private tabs remain unmounted.
- The existing health visibility host is limited to Setup/Widgets. Theme/Scenes do not acquire an extra health provider or polling loop.

Field search is the companion A4 scope described in [the search checkpoint](settings-search-checkpoint.md). Global quick search/PR B and the rest of the UI roadmap remain separate.

## Evidence boundaries

| Evidence | Actual result and provenance |
| --- | --- |
| Original A3 browser | 12 cases, 20 shared AA scans, 20 captures at b14/201uu; retained in place, not rerun or relabelled. |
| Current A4 browser | Fresh 20/20, no skip/retry/flaky; 100 shared AA scans, 52 captures at test ee396805 and shipping 5629/ErW. |
| Current production build | ErWfIpWo99ntZ9ZQRPGOd; 145 pages, all 81 unchanged budgets, post-build types and assets/source checks passed. |
| Retained functional checks | A3 first-static 373/42; combined functional pack 596/74 at 05a58c8a. Later targeted checks and actual browser proof cover the bounded amendments. |

The A3 and A4 rows are separate executions: there was no combined 32-case run on the current artifact.

- [Original A3 receipt](../../.cache/settings-search-current-browser-proof-b14fdb19/sections/run-receipt.json), SHA256 `6f475d50…`.
- [Current retention bridge](../../.cache/settings-search-checkin-proof-5629fbac/build/a3-retention-proof.json), SHA256 `2ed92262…`.
- [Fresh A4 final receipt](../../.cache/settings-search-current-search-proof-ee396805/final-a4-receipt.json), SHA256 `c3b9d8d9…`.
- [Current build receipt](../../.cache/settings-search-checkin-proof-5629fbac/build/final-build-receipt.json), SHA256 `e964e67e…`.

The bridge proves unchanged actual A3 dependencies/rendering and identical paths, sizes and full hashes of all four CSS assets. Foundation, Randomizer and Check-in are not imported/rendered by A3's direct fixture. Current CSS metadata SHA256 is `5e07c2e5…`; original `6bcc46da…` differs only by a terminal CRLF in metadata. Both inventories and all assets remain unchanged.

## Safety, AA and lint

- Fresh A4 recorded 416 typed synthetic GETs plus 20 exact anonymous map reads; zero unknown, write, rejected-write, external or native attempts.
- All 46 synthetic sockets matched a disconnect within their own case. All 20 case/final listeners drained and closed; owned Node/Chromium/esbuild children were zero.
- Postguards passed: test ee396805/tree3cf00778, 206 frozen inputs/68 feature paths/863 admitted cache paths, shipping 5629, ErW, four CSS assets, 40 engine inputs, nine retained assets, sample/pointer/manifest and pinned Chrome.
- AA results mean 100 shared serious/critical scans with empty issue arrays. Incomplete IDs `aria-prohibited-attr` and `color-contrast` remain recorded; no all-impact-zero claim is made.
- Retained UI proof is 19 rules, 1706 scanned files and 639 existing allowances. The existing inherited-warning audits are separate from clean owned lint; they are not suppressions.
- Theme's named keyboard-scroll region has one documented line-level tabindex exception. Picker/Check-in raw lint each retains its existing label-association warning; the class-only audits prove no new warning, directive or event/disabled change.

## Final bounded repairs

Named decorative race previews, visible agent links, keyboard-scrollable Theme preview and valid Account definition lists resolved observed AA findings. Disabled Randomizer/Check-in explanatory text retains normal contrast while the child switches stay disabled. The final Help test uses the unique visible tablist, with all Help/AA/cleanup assertions retained.

The official engine/sample/assets were reused without generation, compilation, download, pruning or public-asset copying. No dependency, backend search endpoint, migration, provider/model or budget increase was added.

## Reviewed screenshots

Root approved four synthetic actual-consumer captures using current production CSS/fonts. Original cache images remain untouched; copies and full SHA256s are recorded in [the copy ledger](../../.cache/settings-search-final-docs-ee396805/screenshot-copies.json). See the four links in the search checkpoint. These images are local fixture evidence, not account or deployment observations.

## Preserved history and next work

- [Pre-rewrite full sections history](../../.cache/settings-search-final-docs-ee396805/before-files/docs/handoff/settings-sections-checkpoint.md) is also preserved by commit ee396805.
- [Early AA/map repair](../../.cache/settings-search-aa-map-repair-e82/) and [A4 failure packets](../../.cache/settings-search-current-search-proof-5629fbac/search/first-red-preserved/) remain unchanged; the full history links every earlier RED.
- The single Light320 diagnostic and earlier three partial passes are historical only and are not included in the fresh 20-case count.
- Product/browser/Next validation is stopped and runtime released. Only final docs plus four approved PNG copies changed after the clean runtime postguard; app/fixture/spec bytes remain frozen.
- Root owns fresh-main reconciliation, PR creation and full CI. No screenshots were edited, no existing images overwritten, and no actual account/provider/StarCraft/native-agent operation occurred.
