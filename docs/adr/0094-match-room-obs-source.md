# ADR 0094 — Read-only Match Room source for OBS

**Status** Accepted · 2026-11-13

The host's Match Room can copy a Browser Source URL at `/overlay/match-room`. It accepts a watch locator in the fragment, with no seat or host credentials. It shares the existing watch capability and expiry. A link holder can still open the ordinary watch page with that locator, so the host should keep the source link within the broadcast setup.

The static page inherits the transparent OBS layout. It skips Clerk and client telemetry, stays out of search and the sitemap, and opts out of service-worker navigation handling. It reads the room through the existing revision-aware GET poller. Visible sources check every five seconds and hidden sources every 30 seconds, subject to server retry delays. While disconnected, it hides the last frame and reconnects. A deleted or expired room stops polling.

The broadcast model includes only neutral seats, score, phase, and veto state. It shows exact entries from the repository's ladder map catalog and uses numbered labels for other maps. Names typed by players, raw custom map names, replay metadata and result-report status never enter the broadcast view. Hosts can remove the credit with `?credit=0` before the fragment.
