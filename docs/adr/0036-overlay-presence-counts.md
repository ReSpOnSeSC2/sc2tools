# ADR 0036: Overlay health reports owned in-memory source counts

Status: accepted. Date: 2026-10-25.

The existing Socket.IO handshake already sends surface/widget labels. Authentication now stores a strict descriptor and server connection time. Unknown or legacy labels remain an explicit unknown source rather than becoming a trusted widget. Widget IDs reuse the API registry plus URL-armed Ghost; approved scene IDs are shared JSON with the web route allowlist and checked against the static scene catalog.

The owner endpoint checks the active token's ownership, then reads the existing single-instance Socket.IO rooms. The Dock's bearer endpoint resolves its current token and receives only surface counts. Both share bounded hashed-token admission of one request per five seconds, after authorization. Reads have a one-second adapter deadline. No socket ID, owner identity, credential, provider lookup, database aggregation, collection or new service is introduced.

Agent connected means a current authenticated device socket exists. The recent game publication clock reuses the broker's existing cache and becomes unknown on expiry/restart. Connection counts cannot prove OBS visibility/audio. Duplicate-audio warnings describe multiple possible audio sources and keep disabled widgets neutral.

One owner-scoped Settings resource supplies the checklist and all badges. Settings and Dock poll every15seconds only while the relevant surface/document is visible, with bounded authentication/body deadlines and no previous-token/owner display. Failed or stale reads never turn into zero or green readiness. The small Dock strip is designed to move into the later Game desk header.
