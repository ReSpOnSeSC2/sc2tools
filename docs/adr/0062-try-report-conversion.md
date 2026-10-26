# ADR 0062: Local report sharing and verified sample reports

Status: accepted

The /try conversion pack builds on the existing intent-loaded browser engine.
It adds no parser endpoint, upload, publication, provider, account mutation or
infrastructure. Rollout flags retain their existing off/admins/all semantics.

Report sharing projects an allowlist of aggregate totals, three opponent-race
records, a catalog-only opener supported by at least three games, and a known
macro score. No player/account/game objects enter the canvas or text renderer.
Selections govern both outputs. Canvas code and its catalog load only after an
explicit Share report action. Native sharing, download and clipboard delivery
remain separate explicit actions; cancelled or failed actions emit no event.
Text copy uses the shared resource-scoped clipboard hook. Permission waits
settle after five seconds into a visible selected-text fallback; dismissal
returns to Copy text, and retired report/selection work cannot deliver a late
success, fallback or focus change. Only successful automatic copy emits the
text delivery event. The fixed canvas renderer is an exact visualization-color
exception in the UI ratchet; dialog and keyboard-focus rules still apply.

Published guide links are shaped on the server from the existing cached guide
sitemap and canonical catalog helpers. Unknown publication fails closed. The
client uses actual replay matchup membership, so generic labels spanning
matchups do not imply a guessed destination. Only an exact published build key
in an explicit focus URL may reveal a matching own-opener row. Normal loading
does not scroll the document.

The optional sample is generated from real fixture parses using the exact
current browser bundle. It strips source identities, provenance identifiers and
paths through an allowlist. It contains no fabricated counts or measurements.
Version plus source/bundle identity guard same-version detector changes. Missing
Python or generation failure removes stale output and hides the button. Loading
the sample is explicit, never boots the engine, never persists games and never
uploads. Existing consent-gated analytics receive fixed delivery enums only.
The normal web prebuild generates the optional sample after preparing the
current browser engine. Artifact parity checks the actual current engine
pointer when generated engine assets are present; unit-only CI still checks
the committed source hash without requiring ignored build output. An always-run
transport regression covers wheel/dependency-only bundle drift and explicit
retry, alongside the runtime pointer guard that retires the previous sample.

No data migration or engine/native version change is needed. Rollback removes
the UI and optional static artifact; existing local reports remain readable.
