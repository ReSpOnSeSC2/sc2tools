# 0034: Live overlay profiles on existing tokens

Status: accepted, 2026-10-25.

An existing overlay token stores one bounded version-1 profile: a validated theme and display-time overrides for known event widgets. `apps/web/lib/overlayProfileRules.json` is the authored runtime source for theme choices, the seven allowed display times and the existing 31 widget defaults. Web theming re-exports the display-time list; the API validator consumes that same file. The lifecycle's existing durations remain unchanged until an owner explicitly saves an override. Persistent and self-driven widgets retain their existing behavior and do not store ineffective duration overrides. Null means the default and is omitted from canonical storage.

The private owner PUT writes only the profile and its revision on an active owned token. An expected revision prevents a theme edit from replacing another browser's newer theme or display-time edits. Missing legacy profile/revision fields mean the safe default profile and revision zero; reads require no migration, new index or new collection. A successful save invalidates cached and admitted token resolutions before publishing the existing `overlay:config` event. Connect-time configuration includes the current canonical profile.

URL theme presence wins, including an empty or malformed parameter, which retains the existing safe default decoder. A URL without a theme follows saved live configuration. Existing theme URLs keep working; newly copied URLs follow the saved profile. No hold-time URL parameter is introduced, and Test fires retain the existing duration cap.

Settings keeps one owner-and-token-scoped draft across its Look and Widgets sections. `useDirtyForm` and the shared SaveBar require an explicit save. A one-time migration banner may copy the previous device theme into the draft, but reading storage or opening Settings never persists that theme to a token. Owner/token changes cancel pending work and cannot apply a late authentication response to another profile.

The profile uses the existing database document, token resolution cache and socket connection. No new infrastructure, polling loop, integration activation, production migration or account operation is required.
