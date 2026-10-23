# Admin console

## Tabs at a glance

Overview contains Dashboard and Notifications. Community contains Users, Player
identities, Player channels and Moderation. Insights contains Global players,
Global trends and Web analytics. Content contains Guides. Operations contains
Tools and Infrastructure. Each page's Help link opens the relevant section here.

## Granting admin

An existing admin opens Users, finds the account, opens its detail page and uses
Grant admin. Server operators can also put the account's Clerk user ID in
`SC2TOOLS_ADMIN_USER_IDS`. Use an individual account so actions stay attributable.

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

Find the exact account before running a repair. Read the action's confirmation
and outcome. Follow the [admin operations runbook](runbooks/admin-operations.md)
for the existing rebuild and wipe tools. Later operations tools will extend it.

## Notifications and support inbox

Read the report, supplied context and Error ID. Mark activity read after triage;
filter to the relevant activity type or use View all activity to clear filters.

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

Admin URLs require an admin account. Sharing a URL does not grant access. More
sharing controls will be documented when they ship.
