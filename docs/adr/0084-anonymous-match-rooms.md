# 0084 · Anonymous Match Rooms

Players and organizers need a shared map veto without signing in. Match Rooms use a static entry page, a room shell and direct short polling of the API.

The room link keeps a random watch credential in the browser fragment. The API uses that credential as the room locator and redacts it from request logs. The host key derives separate seat keys with domain-separated SHA-256 so the host can recover invitations after a reload. Mongo stores only hashes of the locator and write keys. Writes carry the key in a JSON body. The server derives the role from the key and treats names as self-declared. Public result exports use neutral seats and scores.

The room shell and API responses use no-store. The shell is noindex and omitted from the sitemap, Google Analytics and browser error reporting. The HTTP client omits cookies and the referrer.

Room state lives in one ephemeral Mongo document with a 14-day TTL. An expiry filter enforces the cutoff before the TTL sweep. A unique slot index caps active rooms across overlapping processes. Dedicated per-IP limits and a 2 KB JSON ceiling bound request intake independently of the main API bucket. The create form reuses a random attempt key when retrying the same options. A unique digest and server-generated salt let duplicate requests recover the original invite without storing the key or allocating a second slot.

Every state change uses a revision compare-and-swap. A write sends the revision the player saw on the selected control. The reducer advances expired turns using the persisted deadline and seed. A read can commit timer moves, so a stale action receives 409 and the client reloads instead of retrying the write. Matching revisions receive 204. Polling slows when a tab is hidden or a timer is inactive. Reads go directly to Mongo so a deleted room cannot survive in a process cache. Host deletion atomically removes the state, credentials, salt, and capacity slot. A digest-only record expires after ten minutes to absorb delayed create retries. A subsequent creation uses fresh capabilities.
