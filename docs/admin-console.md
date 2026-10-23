# Admin console

## Tabs at a glance

Overview contains Dashboard and Notifications. Community contains Users, Player
identities, Player channels and Moderation. Insights contains Global players,
Global trends and Web analytics. Content contains Guides. Operations contains
Tools, Audit log and Infrastructure. Each page's Help link opens the relevant section here.

## Granting admin

An existing admin opens Users, finds the account, opens its detail page and uses
Grant admin. Server operators can also put the account's Clerk user ID in
`SC2TOOLS_ADMIN_USER_IDS`. Use an individual account so actions stay attributable. Revoke admin is available on the same user page; it cannot revoke your own role, the last administrator, or an account protected by the configured ID/email allowlists. Revocation uses a Mongo transaction; it requires a replica set such as Atlas. Remove an operator allowlist entry through the normal configuration process before revoking that account.

## Daily triage

Check Notifications for support messages, Moderation for reported content, and
Infrastructure for failed dependencies or overdue backups. Refresh before acting.
Read the content in context and leave a short resolution note for other admins.

## Moderation

Reports are grouped by target. Dismiss keeps the content and restores auto-hidden
review content. Remove unpublishes a community build, suppresses an opponent's
public profile, or permanently removes a review/comment. Removing review content
costs its author 20 review karma. Review content automatically hides after three
distinct reports; this does not mean three reports from one account.

Open the target in context before deciding. Expand Individual reports for each
reporter's reason, note and time. Add note accepts up to 500 characters. Dismiss
uses that note immediately; Remove opens a confirmation showing the target,
consequence and editable note. A failure stays on that card with Error ID and
Retry, which repeats the same action and note. Already resolved means another
admin acted first and the queue refreshes.

One decision resolves all open reports on that target, including reports beyond
the oldest 100 currently shown. Decisions and notes are stored on each
`community_reports` row as `resolution`, `resolvedBy`, `resolvedAt` and
`resolutionNote`. A build removal also records the note as its unpublish reason.
Filter by target type or sort by oldest, newest or report count. Clear the oldest
batch to reveal the next batch when the queue is capped.

## Identity and channel review

Review the evidence before approving identity or channel claims. Follow
[Player identities](player-identities.md) and [Player channels](player-channels.md).

## Users and repairing data

### Repairing a user's data

Use the 300 ms debounced email/ID lookup in Tools, or open the user's detail page.
An exact internal user ID resolves to a chip; an arbitrary pasted string cannot
activate a repair. Verify email, game count, opponent count and recent activity.

Rebuild derives opponent counters from saved games and heals identity lookups.
It keeps games, the account and custom builds. Wipe is an all-history delete of
replay-derived data; it keeps the account and custom builds. Type the resolved
email, or internal user ID when no email exists, to confirm. The dialog states
the resolved game count. If that count changes, the API refuses the wipe: dismiss,
refresh the user or change/reselect the lookup, and confirm the new count.

A wipe has no Undo and deleted replay/detail objects cannot be recovered from an
account snapshot. Do not promise that it can be undone. Both entry points use
the same result line, including games, opponents and macro jobs; Dismiss resets
the card and Open user checks the outcome. Unknown IDs produce No user with that
ID. Games-only legacy IDs still must pass the normal owner mutation fence; these
records are not automatically turned into accounts.

Support snapshot shows active devices and version/online state, the same doctor
warnings shown to the owner, replay archive counts, the last five imports and
recent audit rows. It excludes tokens, replay paths and message bodies. Refresh
it before retrying an uncertain action. See the [operations runbook](runbooks/admin-operations.md)
for job health, Run now, audit retention and cohort definitions.

## Notifications and support inbox

Read the report, supplied context and Error ID. Mark activity read after triage;
filter to the relevant activity type or use View all activity to clear filters.

## Audit log

Review administrator actions by action or target. Wipes include actual deleted game counts. Audit rows expire after 400 days and account deletion anonymizes their identifiers. Recording is best effort; follow the [operations runbook](runbooks/admin-operations.md#audit-log) for interpretation.

## Infrastructure

Provider capacity and operational health load independently; Retry only the
failed section, or Refresh now to check both. Watch is a prompt to investigate a
trend. Upgrade is a planning threshold, not an automatic purchase instruction.
Costs are estimates and may differ from final invoices. Inspect the provider's
own usage and billing page before changing a plan.

If Browser replay backup says Needs setup, check the private R2 bucket's upload
CORS rule and key permissions using [Browser replay backup](instant-analysis.md).
Database backups shows the actual Atlas schedule and freshness; authentication
failures can require rotating an expired service-account secret. For recovery,
follow [Restore database](runbooks/restore-database.md), preserving logged wipe
date ranges after a restore.

## Web analytics (GA4) setup

Set `GA4_PROPERTY_ID` on the API to the numeric GA4 property ID. Provide a Google
Cloud service account using `GA_SERVICE_ACCOUNT_KEY_B64` (base64-encoded JSON key),
or set `GOOGLE_APPLICATION_CREDENTIALS` to an available JSON key-file path. Enable
the Google Analytics Data API in its Google Cloud project. In GA4 Property access
management, add the service account email with Viewer access, then redeploy the
API. Keep the key on the API; never put it in a public web environment variable.

Choose a preset or a Custom inclusive date range of at most 365 days. The previous
comparison window has the same length and ends the day before the chosen range.
GA4 metrics may take 24–48 hours to settle. Realtime is separate and can be retried
without discarding the summary. Export CSV downloads the displayed top pages or
channels for the selected range. Share percentages use the displayed breakdown's
total; top pages use total page views when supplied.

## Global Trends

Use a narrow range and relevant filters before opening expensive platform-wide
views. Read the sample size alongside a rate; a small cohort can move sharply.

## Guides

Follow the publishing and maintenance instructions in [Guides](guides.md).

## Sharing views

Copy the current URL to share the Users, account-opponent, Global players,
Notifications or game-browser view. Search, filters, sorting and pagination
survive refresh. Defaults are omitted; unrelated parameters such as `debug`
are preserved. Searches settle after 300 ms without losing typing focus; use
the clear button or Escape to clear and refocus Search.

Filter and sort changes replace the current view and reset its page. Next and
Previous add history entries, so browser Back restores your earlier page and
selected game. A shared cursor cannot reconstruct its preceding pages; its
**First page** button returns to the beginning instead of guessing a Previous
cursor. Retained rows dim and say **Updating…** during a fresh request.

Sortable table headers show their direction. On phones the same columns become
cards with a Sort by control and type-specific order labels. A row's main link
opens its detail; other buttons and links remain independently usable.

Game links include `game`; global-player game links also include `owner`, the
internal ID of the user who owns that replay. An off-page selection loads from
the existing owner-scoped detail endpoint and explains that it is not on the
current page. A missing game offers **Clear selection** without discarding the
other filters. Do not remove `owner` from a global game link or substitute a
different account's ID.

Admin URLs still require an admin account. Sharing a URL does not grant access;
send it only through an appropriate private support channel.

## Build Studio

Open **Content → Build Studio** to traverse every released preset, every private
custom definition across owners, and every community snapshot, including removed
listings. Next definitions uses a stable keyset cursor; it is not an arbitrary
first-page cap. Private/community rows show their owner and source slug. Filter
by the owner's internal user ID when needed.

Select a definition to inspect all its valid stored steps and rules. A v3
rule-only definition legitimately has no authored steps. Released procedural
presets show their real source/description; empty legacy signatures are never
presented as executable criteria. The two Archon Drop presets expose the same
shared criteria used at their released tree slots, including a real Warp Prism
**completion by 6:00**. Structure presence, construction starts, production starts
and unit completion have separate clocks. Hallucinations and units without their
observed prerequisite technology do not satisfy real-unit counts.

For a preset, choose **Replace detection criteria**, **Disable this preset label**,
or **Keep released decision tree**. Replacement alternatives are ORed; every
condition within an alternative must pass. Lower priority wins, with the label as
a deterministic tie-breaker. Detection surfaces are fixed by the released
catalog: personal Protoss matchup presets cannot rename generic opponent Protoss
strategies, and vice versa; Terran/Zerg retain their existing shared taxonomy.
Private custom-rule matches take precedence. If a released match is replaced or
disabled and no replacement matches, it becomes **Unclassified** instead of
bypassing the edit through its old hardcoded predicate.

Authored preset reference steps and descriptions are editable independently of
detection. Steps do not become hidden rules. Supply is bounded to the SC2 cap of
200. **Run unsaved preview** evaluates bounded raw/synthetic events without a
policy write. **Review changes** shows before/after data; **Confirm save** applies
a new version using the expected active hash. A competing edit returns a conflict
and preserves the draft. Reload latest is an explicit discard action. **Review
restore to released** removes the selected preset's policy override. Global preset
policy history allows inspection of a complete historical manifest before
restoring it as a new immutable revision; it never rewrites history.

Custom/community definitions expose their safe complete JSON shape for editing
names, steps, signatures and v3 rules. Private notes, replay links, ownership,
publication/removal state and counters are not editable. A community correction
changes its published snapshot independently of the private source and keeps a
removed listing removed. Private saves can explicitly queue owner-scoped
reclassification. All saves check the current definition version and hold the
owner's shared data-write lease, so account erasure/restore excludes the edit.
Previous definitions are reviewed and restored as a new version. Invalid legacy
definitions exceeding validated bounds are marked incomplete and cannot be
silently overwritten by their bounded projection; they require a reviewed repair.

The shared runtime contract is **schema 1 / evaluator 1** (`preset-policy-v1`),
not a promise that an old installed executable supports it. Compatible desktop
engines refresh the anonymous global manifest after healthy heartbeats. Browser
engines refresh before analysis, at most once per minute. A validated last-good
manifest survives outages; fresh installs fall back to their bundled released
trees. Hash/schema/label incompatibility never installs an unverified policy.
Older clients and incomplete raw evidence keep their uploaded classification;
update and reanalyse those files to adopt current policy. Existing history does
not silently change after a global save. Confirmed build selections/corrections
remain the displayed label while the current detector result is stored separately.

Repository validation: `python apps/replay-engine/scripts/export_preset_catalog.py
--check` verifies the generated catalog, detector surfaces, source fingerprint and
full real-unit prerequisite/proxy tables. Re-run the generator after released
classifier changes. New executable labels/schema/evaluator behavior ship through
normal desktop/browser releases; an admin cannot upload executable code, URLs or
arbitrary new labels through this editor.
