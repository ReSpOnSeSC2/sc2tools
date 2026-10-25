# Dock foundation checkpoint

Branch: `codex/wave4-dock-polish` in `.worktrees/wave3-game-workspace`.
Product source: `40e5ea990ac7574a355501795db2af0ad34680bc`, based on current main `b2abc9c034ab3dd7564d0befe50897d288f61649`.

Fresh coaching main `5a402f23487b844fab15e9a8302eaebcb4be05d8` integrated cleanly as `5748e1e9d97ac0184c467bd45838f32209942dc9` after the product proof. Both changelog sections and Help changes remain; no Dock source or CSS changed. Full web types and the affected Dock/Settings/Help consumers pass after that integration.

This is the exact `streamer-polish-4` foundation before Game desk: the existing nine panels now collapse into live/readiness summaries, pin to a shared order and retain drafts through collapse, Pin and Reset. A bounded browser-only layout preference stores known IDs and the b-roll disclosure state. Storage denial keeps controls usable.

Dock controls use the shared UI primitives, visible focus, labelled icons and at least 40px coarse-pointer targets. Platform connections are text-labelled. Failed/missing/stalled clipboard access exposes selected read-only text, including multiline chronological clip timestamps. The b-roll manager, build picker and graph load on demand. Local error boundaries contain failed imports/rendering; explicit Retry reruns each factory with a fresh lazy identity, and a stalled load reaches its local fallback after 20 seconds.

No API, provider, database, migration or production activation work is included. The private dossier brief is not exposed here. The plan's Scout migration awaits its missing `live-scouting-brief` predecessor; root owns that separate stream-safe contract. Health's separately owned presence strip is preserved on later integration. ADR 0039 records these boundaries.

## Validation

- 137 Dock/layout/engagement/Settings build-profile consumers pass. Covers draft retention, bounded/denied storage, real list mode, IO scroll-spy, keyboard-ready disclosures, summary readiness, copy fallback, graph lazy loading, rejected imports, render errors and load deadline/retry.
- Full web types and strict scoped lint pass. Help index regenerated (81 articles); the Help change is the requested single collapse/pin sentence.
- Required engine prebuild and smoke pass: `604e9d4618a6414b` (unchanged engine source).
- Final production build session `82580` passes, reusing that verified engine. All existing bundle budgets pass: Dock **221.9/225**, landing **214.7/215**, Today **228.5/240**, game **317.1/440**, opponent **476/500**, overlay **233.9/240**, standalone **314.9/325**, Settings **179.7/260** kB gzip. No budget changed.
- Real production Next route passes **3/3** at 300/768/1440: deliberately abort an optional Build vote chunk, recover with Retry, retain the timer draft and selected mode, then pass axe WCAG A/AA checks. The new `tests/e2e/dock.spec.ts` also runs in the existing responsive suite. Pinned axe-core 4.11.4 is dev-only and already existed transitively in the lock.
- Final synthetic browser matrix passes **270 checks** across 300/320/390/768/1440 in light/dark, with actual coarse/fine pointer media. Includes point-hit and geometry checks for disclosures, moderation buttons, number/select fields, keyboard Enter and jump focus, all nine folded summaries, persistence/reset, copy failures, retained b-roll draft and empty build state. Every case passes axe and has no page errors, unexpected API paths, body overflow or studio writes.

## Browser evidence

`apps/web/tests/manual/dock-polish-fixture.cjs` bundles real Dock consumers with explicit synthetic Next/auth/socket/chat-provider boundaries. `dock-polish.cjs` serves only loopback fixtures, blocks other traffic and speech, and uses final production CSS/fonts plus the source CSS module (esbuild's local module class mapping).

Final CSS: `085eec6ea1a84fdf.css`, `8fe81922698028ac.css`, `b38454d7a7078b92.css`, `c8183fd076b4bf97.css`.

22 reviewed captures in `docs/handoff/screenshots/`:

- `dock-polish-open-{light,dark}-{300,320,390,768,1440}.png`
- `dock-polish-folded-{light,dark}-{300,320,390,768,1440}.png`
- `dock-polish-copy-dark-300.png`, `dock-polish-copy-light-1440.png`

Representative visual review includes the 300px light and 1440px dark open layouts, all folded summaries at 300px light/1440px dark, 768px light, and the selected multiline fallback at 300px dark. Root and independent source reviews cleared the final lazy-boundary design. PR merge remains gated on final expected-head GitHub/Vercel checks and a fresh-main check.
