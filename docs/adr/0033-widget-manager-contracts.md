# 0033: Reviewed widget packs and shared Browser Source sizes

Status: accepted, 2026-10-25.

Overlay Settings groups its existing controls behind shareable local section links. The forms stay mounted while hidden, so moving between local sections preserves unsaved chat, bot and appearance state. The existing Settings dirty-source guard still protects leaving the whole Overlay tab.

Widget cards reuse the existing guide catalog and illustrative images. `apps/web/lib/widgetRecommendedSizes.json` is the authored source for each guide's `recommendedSize`; desktop packaging includes that same file. The desktop builder uses it for standalone defaults when no confirmed geometry is supplied. Generated native layouts keep their already-confirmed geometry rather than acquiring a different aspect ratio. Recommendations include room around the default card; streamers still test long content and larger themes.

Drag links follow the official [OBS URL-drop contract](https://obsproject.com/eu/tools/browser-drag-and-drop): `layer-name`, `layer-width` and `layer-height`, with `text/uri-list` drag data. Copy remains the primary action and retains the complete URL, including theme and Ghost fragments. Displayed URL text and titles hide bearer tokens until Reveal or an explicitly requested clipboard fallback. This is a screen privacy control; the browser and OBS still need the real credential.

Starter links open a review dialog. The bulk PUT validates a bounded unique allowlist, scopes the write to an active owned token and optionally compares the displayed baseline atomically. An empty unchanged baseline remains valid. Conflicts preserve another tab's selection and emit nothing. Accepted changes invalidate admitted stale cache reads before publishing the existing `overlay:config` event. The UI preserves other enabled widgets and fences delayed authentication/completion by owner, token and pack.

Ghost remains controlled by its existing explicit URL/build assignment. The Practice pack explains that separate setup and enables only its server-controlled widgets. Packs do not configure OBS sources, connect accounts, enable integrations or fire live tests. No migration, new infrastructure or polling loop is introduced.
