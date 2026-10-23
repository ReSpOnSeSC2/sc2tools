# Opponent list and private note validation

Implements Wave 2 opponents-polish-2 and opponents-polish-4, including their audit items and Help sections. The current service stores notes in `opponentNotes`, so one indexed, owner-scoped query overlays each page rather than reading obsolete embedded notes. Both list paths emit at most 140 Unicode characters with collapsed whitespace. Empty notes emit no metadata; filtered results do not expose full notes.

The list uses real dossier links, one debounced prefetch timer, safe row clicks, natural/numeric comparators, local Reset and shareable parameters. Browser Back restores the render window, expanded rows and scroll position. Private drafts debounce into session storage, flush before unload/unmount, isolate owners, restore/discard and retain newer edits during pending saves. The same confirmation guards local and chrome links back to the list. No AI features or AI API calls were added.

Validation before final integration:

- Full application web suite: 6,273 passed, one intentionally skipped, 652 passing files.
- Thirteen actual temporary-Mongo API tests cover batched reads, filtered/unfiltered behavior, Unicode limits and owner isolation.
- Full web TypeScript and strict changed/new-source lint pass. Focused tests cover URL precedence/debounce/Back, nulls and tie-breaks, 400-row restoration, safe clicks, note retries/shortcuts, before-unload, cross-account privacy and edits during pending saves.
- Exact-CI production build and every unchanged route budget pass. Opponents 179.3/180 kB; dashboard 234.5/240 kB. The final phone overflow correction passed the same production build/budgets and all eighteen browser checks; 58 focused tests pass afterward.
- Eighteen Chromium checks pass at 390/1440px using the actual interactive components, production CSS/fonts and explicitly labelled sample account/API/auth/navigation boundaries. These are fixture sessions, not a live signed-in account. No browser errors. Tests verify replay history is immediately above notes near the top, safe confirmation focus, keyboard saving, draft removal and return to expanded groups.
- Browser verification caught a real phone overflow: the absolute screen-reader-only last-column label lacked a positioned table-header ancestor. Anchoring it to its header restores a 390px document width while retaining the table's own scroll area.

Four screenshots are under `docs/handoff/screenshots/opponents-*`. No production account or note was modified. Final integration and remote CI remain required.
