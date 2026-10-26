# Try conversion pack — ADR 0062

Worktree: `wave3-owner-neighbors`, new `codex/wave5-try-conversion` from
Landing `14fd6f59`. Pushed Auth `d0c58f5e` and Scorecard `53aa5356`/its SEO
worktree remain preserved. The existing Landing worker switch is unchanged.

Current-main integration is preserved at `c5a0ae62`, including shared
Appearance/System controls, accessible MobileNav, SiteStats loader semantics
and analyzer filter overlays. The original dossier section order is unchanged.
The source repair replaces the public CTA with the leaf LinkButton, removes
its one retired ratchet occurrence, and adds only the exact fixed-canvas color
boundary. Adjacent files and all dialog/focus rules remain checked.

Report text now uses shared useCopy with a five-second permission deadline,
selected read-only fallback, nested Escape dismissal and trigger return.
New consumer regressions cover recovery/retry and report ABA/unmount retirement
without late focus or success analytics. Manual runners accept the pinned
Chromium executable and save fresh evidence in root `.cache`; original review
PNGs remain untouched. The conversion matrix now includes full scoped contrast
and a held-copy recovery case.

This integration repair is source-ready. Current engine/sample generation is
recorded below; affected tests, types, strict lint/ratchet, final production
budgets and browser proof are still due in their coordinated slots.
No current validation is inferred from the earlier branch results below.

## Current-engine generation boundary

At preserved repair `5a783205`, the canonical required engine build/smoke
completed before the canonical sample generator, matching package prebuild
ordering. Current engine 1.6.12 bundle is `d27b37abb9997712` (agent metadata
0.24.7), with 223 shipped files, 79 compiled modules and a 142,939-byte successful
smoke parse. Its zip is 1,252,988 bytes, SHA256
`ba357c54c2f3d69b923adc391230dc4382693eabb697b23bf287a665ad1f0858`.

The generator verified that fresh pointer, canonical manifest, zip digest and
normalized shipped-source bytes before parsing the four existing repository
fixtures and publishing only its scrubbed allowlist. Output remains four games
and 163,355 bytes. The four public game payloads are unchanged; only bundle and
source-hash metadata change in `public/try/sample-payloads.json` and the two
matching constants in `lib/instant/sampleAvailability.generated.ts`. New source
hash is `18a2e1b56111045cdb441d9d8868eee0b36d0b158b34ea0a79e3b9a22a69e2b2`;
sample JSON SHA256 is
`91a6735e50f45776c15642ebae53f1a3f9800c1db225a99e0e631be318820473`.
No raw replay identity, provenance or private screenshot was exported.

The canonical publisher prunes earlier same-version bundles. All resolved
pruning/snapshot targets were checked inside this named Try workspace, then
nine engine/Pyodide/old-sample files were snapshotted with hashes before the
unchanged publisher ran. Its old `25b300818c31d41b` bundle was restored alongside
the new bundle, without replacing any new path or the new current pointer.
Restored bundle and Pyodide hashes match the snapshot; pinned wheels came from
the existing cache without installation. All 43 original committed Try/Landing
PNG hashes remain unchanged.

The future conversion runner and its fixture bundler now share an optional
`TRY_CONVERSION_HOST_DIR` and default to the new root cache directory
`try-conversion-current-host`. The runner explicitly passes the resolved path
to its child bundler, so the generated writer and HTTP reader cannot diverge.
`TRY_CONVERSION_EVIDENCE_DIR` independently overrides captures/results, defaulting
to `try-conversion-current-evidence`. Neither prior `try-conversion-host` nor
`try-conversion-evidence` is overwritten. Syntax/lint and the later actual run
will verify this narrow directory plumbing; no browser was run in stage 1.

The exclusive runtime slot was released at this clean generation boundary for
queued Public/Auth combination checks. No Try consumer tests, types/lint,
production Next build or browser matrix have run on this refreshed source yet.
Later build/browser proof must use the current source, not the historical
bundle evidence below. Preserved artifacts are root
`.cache/try-stage1-{engine,sample-generation}.log`,
`try-stage1-{sample-output-summary,engine-output-summary}.json`,
`try-stage1-preserved-assets-sha256.json` and the ignored snapshot directory.

The local report adds an intent-only share preview and 1200×630 PNG. The same
selected aggregate model feeds the image and text. Player/account/game objects
never enter either renderer. Unknown macro scores and catalog openers with
fewer than three games are omitted. Share, download and copy are separate
explicit actions; tests mock every delivery API. A changed report/selection
invalidates held PNG work before delivery. Busy selection controls use native
fieldset semantics.

Server-only canonical guide helpers shape one existing cached published sitemap
into a bounded link map; unavailable publication fails closed. Opener links use
actual replay matchup membership. Only an exact scalar, published own-build key
from the explicit focus URL may reveal a matching row. Normal loading does not
scroll. Row focus owns a completion epoch so fresh/repeated analyses cannot
lose it to the report heading. Populated guide timing tables keep the Try CTA
while suppressing duplicate sign-in copy. Public links respect off/admins/all.

The optional sample generator parses four real existing 1v1 fixtures using the
verified current browser bundle. Version, bundle content address/zip digest and
normalized shipped-source hash are checked. Public projection removes source
identities, provenance IDs, paths and MMR journeys; generic identities never
invent a Most faced record. The earlier branch output was 163,355 bytes for
engine 1.6.12, bundle 25b300818c31d41b; this is historical evidence, not a bundle
pin. Current sample artifacts await regeneration against the integrated
engine. Missing Python/failure removes stale JSON and hides the
button. Sample code/data/pointer fetch only after a click, never persist games
and have a real deadline/Retry. The same launcher appears on mobile landing.

Earlier frozen verification passed 607 affected tests across 58 suites, then 136
combined public metadata/cache/guide/Try consumers across 15 suites and 43 final
focus/history consumers. Full types and strict changed-source lint pass. Help
generation is deterministic at 89 articles, including `/help/instant-analysis`.
Landing's exact test-only `24aa9836` correction is integrated. Actual main
`5dee4be9` is merged at `330a8bb6`, preserving its Try metadata/OG and public
cache behavior; API bytes match current main. Final focus/history source is
preserved at `342fdb8c`.

The earlier engine 25b built and smoked successfully (223 files/79 pyc and a
142,939-byte parse). The optional sample regenerates deterministically, and
the shared engine slot was released immediately. The final integrated Next
build passes all unchanged budgets: Try 235.9/240, landing 191.6/215, guides
169.3/175, Today 238.8/240, opponent 447.2/500 and widget 323.9/325 kB gzip.

The actual component browser matrix passes 242 checks/25 captures at
320/390/768/1440, both themes and reduced motion. All native share/download/
clipboard APIs are mocked; nonlocal requests and writes are blocked, with zero
attempted writes. It verifies selected image/text, the same mounted focus URL
remove/return flow, repeated completions, keyboard trapping/Escape/trigger
restoration, empty-history samples, consent/rollout, populated guide timings,
and scoped axe (global contrast belongs to the separate theme pack). PNG
encoding has a 20-second deadline. Seven individually inspected representatives
are committed under `docs/handoff/screenshots/try-conversion-*`; full local
evidence is `.cache/try-conversion-evidence/result.json`.

Independent non-sample source review and root privacy/source review are clear.
Root visual review, the Landing dependency, exact-head CI/Vercel and coordinated
merge remain the publication/merge gates. No remote feature push was made
before this final proof was preserved.

No API endpoint, production job/migration, upload/publication/provider action,
infrastructure/budget increase, native/engine version or release change. Shared
engine prebuilds must use the coordinated current engine and source, without
pinning an earlier same-version bundle. Root ports
3210/8080 are reserved; this pack uses disposable loopback fixture ports.
