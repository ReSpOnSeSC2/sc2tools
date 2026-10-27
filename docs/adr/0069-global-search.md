# ADR 0069: Keep global search lazy, local and explicit about guide availability

Status: Accepted B1 design; combined local acceptance and exact old-consumer equivalence pass; exact-head CI and production delivery remain pending.
Date: 2026-10-27.

## Context and decision

Players need one visible way to find pages, Settings, Help and public guides. Implement the static/public part of find-anything as one normal-shell controller with a lazy runtime. Header/AppChrome Search buttons, Search first in mobile More, Ctrl/Cmd K and eligible / open the same palette. Status, token overlay and Dock branch before this controller. The closed shell retains only lightweight dispatch/state; catalogs, Help/build/widget data and anonymous metadata readers remain below the lazy import. Reuse already admitted chrome/role state; search adds no role probe.

Results are finite data, never arbitrary query-derived URLs or actions. Reuse navigation gates, Settings labels, generated Help metadata, glossary, public build definitions, widget descriptions and existing fixed actions. Rank locally with deterministic ties, at most 80 query code points, 12 tokens, eight results per group and 60 overall. Empty input may show at most eight validated static Recent destination IDs for the current viewer. Guard storage, clear on sign-out, and save no typed query, dossier name, token or arbitrary URL.

One shared dispatcher gives a connected visible local field priority for /. Keep Ctrl/Cmd K, ?, and admitted g+t/o/r/s outside editing/composition/repeat/other focus owners; g+r resolves to Reviews. Use the existing Modal/focus-scope/body-lock primitives. Keep the editable combobox, grouped listbox, disabled options, arrows/Enter and one-step Escape. More and lazy Report/Appearance/shortcut handoffs close the prior surface and retain a persistent launcher. Navigation cannot steal later destination/guard focus.

Settings registers a narrow current-owner callback into its existing requestDestination and dirty guard. Validate an available destination before advancing the action identity. Stay preserves draft, tab and full previous URL; Discard activates once. External routes from Settings use the same guard. Committed owner/route/frame identities retire old callbacks, including A-to-B-to-A, without mounting inactive forms.

## Public guide discovery

A visible Find a guide form on the hub and matchup page submits into the same palette scoped to Guides. Use authoritative opener/counter slugs and viewer-first matchup aliases, plus the existing public map-name/slug projection. Published candidates link; known unpublished candidates stay visible/unlinked as Not enough games yet; unknown availability stays disabled with explicit Retry. Do not turn a failed publication read into an empty or fully published set.

On first explicit open, read only existing anonymous /v1/guides/sitemap and /v1/guides endpoints through the existing public API base. Omit credentials/Authorization, deny redirects, verify final URLs and reject malformed/unsafe data. Typed input never changes either request. One shared subscriber-aware flight has a six-second total deadline and a streamed 1 MiB ceiling per body. Abort/error paths cancel/release actual readers; retired late responses cannot publish. Retain one successful six-hour in-memory snapshot; failures require explicit Retry rather than becoming success or launching a loop.

The sitemap's actual protocol is up to 5,000 documents plus nine matchup headings, hub and map index: accept all 5,011 canonical paths, reject 5,012 without truncation. The index exposes at most 200 published maps; reject 201. Only validated map name/slug leaves enter search. These bounds limit transport/catalog admission, not physical database scans or production cost.

The initial server-seed proposal is deliberately adjusted. Hub/matchup are React Server Components and all map metadata is not already browser data. First-open anonymous reads preserve the closed lazy boundary; do not add an eager publication lookup or serialize 200 maps solely for closed search. Server seeding is a later optimization, with no saving/speed claim.

## Evidence and release boundary

The checkpoint records 479 passing integrated tests/30 files, whole types, strict scoped lint and Help 97; a later actual-Next test-only follow-up also passed types/lint. The local real-component consumer passes eight documents and 46 AA/contrast captures with explicit framework/transport adapters. Raw incompletes, contrast arithmetic, imports/wire/storage and process closure are retained. This is bounded consumer proof, not deployed Next hydration, production authentication or product-wide AA certification.

Actual Next destination-heading assertions exposed an inherited local build environment error: NODE_ENV=test produced fallback:false for empty-static-param ISR guide routes. Its earlier all 83-budget pass remains historical; it is superseded for real Next guide-destination acceptance. Do not change guide source or patch generated manifests to conceal it. Fresh NODE_ENV=production build02 xwwEgf7EgdVusjSGKfVJi passes all 83 original route caps and unchanged asset guards, with blocking fallback null on all four guide patterns. All 1,893 consumer inputs, six package metadata files, five CSS files and two fonts match the old consumer capture byte for byte; that run retains its original build identity. All 12 actual Next public cases pass without retries/skips, including rendered counter/map destination headings. Final exact-head CI and delivery receipts remain pending. A successful URL change alone is insufficient.

Private opponent/custom-build/map quick search, replay/Community text search integration, broader map discovery, dossier recents, a dedicated results page and SEO SearchAction remain deferred. B2 requires actual query/index and owner/cache/publication decisions; no row cap proves a physical scan bound. No AI/LLM, new API route, service, index, migration, job, queue, socket, infrastructure, provider activation, optional-cache activation or agent release belongs to B1. Rollback is a code revert; no stored-data conversion is required.

See [the global-search checkpoint](../handoff/global-search-checkpoint.md) for current evidence, unsuccessful runs and final acceptance placeholders.
### Combined-source acceptance boundary

The urgent Auto-season correction is integrated without changing the39 B1 leaves. Fresh combined types/strict48lint/Help97 and779 tests/65 suites pass. Production build jZvEZw1cebKxMXLo_R51u passes the original83caps and asset/source guards;12 actual-Next cases pass. An additional two-document/eight-capture real Search→Sessions→report→Today consumer verifies Auto and ordinary preference persistence with zero violations and explicit incomplete dispositions. The former public-banner fixture classification failure is preserved; only its synthetic admission was corrected. These results do not relabel the older46-AA captures: their exact source/package/CSS/font equivalence, final B1 CI and delivery remain separate gates. See the checkpoint for current raw evidence and pending rows.

Final EQ04 keeps the original Kt consumer identity and verifies all eleven source/graph/style/runtime comparisons against combined jZv; no fresh46-AA run is invented. The same-Node root-layout delta versus urgent B0 is +3,799gzip bytes, separate from original83route caps. All local acceptance is complete; release CI and production acceptance remain pending.
