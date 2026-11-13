# 0087. Delayed stream viewer page

- Status: accepted
- Date: 2026-11-12
- Related: [0065](0065-public-player-privacy.md), [0075](0075-share-card-privacy.md)

## Context

Streamers can share delayed results with viewers through their public player handle. Existing private stream reports, OBS credentials, and game and engagement records contain fields that are unsuitable for this page.

## Decision

Sharing is a separate, default-off setting on an explicitly enabled public player page. The browser owner selects one active Browser Source and a delay of 5–60 minutes. The selection binds to the existing public consent epoch. Public profile opt-out retires it even if an older server writes the change. Token revocation or rotation makes the page unavailable until the owner explicitly selects an active source.

Starting a Dock session binds its current session to a hash of that source's credential. Earlier sessions without the binding yield an empty feed. The API shows completed 1v1 results with an exact replay start and end wholly within the selected source's current session. It waits the configured delay and projects only win or loss, an enumerated opponent race, and a known ladder map. Counts describe the rows shown. The page excludes series, ratings, predictions, and builds because their current sources do not establish the same delayed publication cohort.

The public URL uses the existing handle. The response contains no IDs, names, credentials, timestamps, or game links. Server HTML and the API use no-store and the page is excluded from indexing and analytics. Logs and telemetry use route templates. Each rate-limited read checks current consent and the exact active source, reads a bounded set of currently visible games directly from the database, then checks publication again before sending results. Reading game visibility fresh keeps hidden and deleted games out of subsequent responses. Server HTML only includes the loading state for admitted pages. The browser verifies publication before showing results on mount or return, polls every minute while visible, and clears results on revocation or request failure.

## Consequences

Links work signed out. Owners can turn sharing off immediately. Ending or replacing a Dock session clears its results at the next check. A source cannot silently follow a credential rotation. Unverified, older, or incomplete game records do not qualify.
