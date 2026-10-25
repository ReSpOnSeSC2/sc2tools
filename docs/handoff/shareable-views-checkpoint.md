# Shareable analyzer URLs and saved views

Roadmap item: `shareable-views`. This pack uses fixed parsing and validation, with no AI features or external integrations.

The analyzer now reads filter URLs before stored preferences. Generated `filters=1` snapshots replace the recipient's stored cohort; older partial URLs override only their explicit keys. Presets remain relative (including `season:67`), custom dates retain their instants, and reversed ranges normalize. URL-driven sessions never write the cohort to device storage. Existing drill keys remain excluded from stored preferences.

The lazy URL synchronizer uses a 250 ms `router.replace` with `scroll:false`, preserves section-local query parameters, and handles Back/Forward. A pending writer verifies the captured query before writing, preventing an incoming navigation from being overwritten. Exact map aliases remain a complete bounded literal cohort tied to the visible chip. Malformed exact cohorts withhold analysis and offer recovery instead of becoming substring searches.

Copy link is beside Active filters. It includes only safe filter keys and a canonical section. Clipboard denial offers a selected read-only field; an old clipboard promise cannot restore feedback or a fallback after the view changes.

The lazy Views dialog supports save/apply/rename/delete/default, up to twelve unique names of at most sixty characters. Renaming retains the saved cohort. API failures retain the draft. Account identity fences token resolution and late mutation responses. The private preferences endpoint validates writes and sanitizes reads. Applying a view uses the URL and stays session-only.

The first plain `/app` visit uses a single projected indexed user read through `/v1/me/analyzer-default-view`, replacing the previous misc-preference read. A valid default saved view wins over the legacy default tab. Explicit filter URLs, Today shortcuts, legacy deep links and the existing session cookie keep their priority. The lookup retains its 1.5-second deadline and Today fallback.

## Validation

- API: 55 real-Mongo preference/default-route tests; full API types and new-test lint passed. One read supplies default view plus legacy tab; no game-history reads or new aggregation.
- Web: 115 focused codec/provider/URL/dialog/clipboard/first-visit/chip/frame/persistence/Help checks, plus 11 shared Modal checks passed; full types and strict changed-source lint passed.
- Required integrated production build and every unchanged budget passed: landing 214.1/215, Today 226.7/240, game 312.7/440 and opponent 490.4/500 kB. The final Modal close-target correction is also covered by its tests and the browser geometry checks; exact-head CI rebuilds before merge.
- Browser: 100 checks at 320/390/768/1440 px passed using production CSS/fonts and explicit synthetic auth/API/router boundaries, including CRUD/default, actual AppHome first-visit behavior, clipboard fallback, Back/Forward, pending-navigation and invalid-exact recovery, storage isolation, focus/keyboard, 44 px dialog targets, contrast, no overflow/errors/external requests. Eight light/dark screenshots are in `screenshots/analyzer-views-*.png`; root and independent visual review passed.
- Independent review found and resolved custom-range and exact-chip mismatch normalization, pending navigation writes, malformed exact cohort fallback, and stale clipboard completion.

## Setup and rollback

No new environment variables, services, indexes, scheduled jobs or migrations. Saved views live in the existing user preference document. No production preferences were modified during validation. Roll back the feature commit to restore the previous UI and redirect behavior; unused saved preference data is inert.

Help: `analyzer-filters#save-and-share-a-view`.
