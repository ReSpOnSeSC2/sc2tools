# 0044: Live scouting uses one existing enrichment and separate owner/Dock views

The Today brief and `/app/live` subscribe to the existing authenticated SSE feed. The existing bounded recent-games read additionally projects `gameId`; the same tendency sample supplies plain top-three opening frequencies. Exact current opponent identity comes from the resolved toon, never a name-only account match. No query, provider request, collection or infrastructure is added.

Owner views may show the existing note and owned replay/dossier links. The token Dock receives a new object built from an explicit stream-safe allowlist. It contains no note, account identifier, replay rows or editing action, even if arbitrary private fields exist in the source envelope.

SSE state is keyed by owner/session, old readers are cancelled, and late token lookups cannot make an old-owner request. Same-match partial ticks preserve enrichment only while direct opponent name and match key agree. Cached receipt time controls a 30-second freshness limit. Authentication/header waits are bounded and reconnect uses the existing capped backoff. Second-screen wake locks fail softly and release on close.

The existing private opponent-note endpoint remains authoritative. The popover aborts on unmount/owner change and its 15-second deadline covers authentication, response and body; an earlier successful save cannot overwrite a newer typed draft.
