# Admin operations

This covers the existing account repair tools and service notices. Later
operations-console controls will extend these procedures.

## Identify the account

Open Admin → Users and verify the account's internal user ID, Clerk ID and recent
activity. The tools accept the internal user ID. Avoid copying an email address
or Clerk ID into an internal-ID field. Record the support issue and the intended
repair before making changes.

## Rebuild opponent counters

Open the user's detail page and choose Rebuild opponents. Read the confirmation,
then run it once and inspect the outcome. This derives opponent counters from
surviving stored games; it does not invent missing games. Refresh the user's
opponents view to verify the corrected counts. Fix my counters in Tools runs the
same repair for the signed-in admin's own account.

## Wipe game history

This permanently removes game history and associated detail/replay storage for
the selected account. Confirm the exact target and the user's intended scope.
The admin wipe is an all-history operation. For a date-limited request, have the
user use Settings → Backups & data → Delete game history with the intended dates;
do not replace a date-limited request with an admin all-history wipe.

Inspect the result before asking the desktop app to re-sync. Wipes record their
scope and bounds in `gdpr_games_wiped`. A database restore must reapply the same
scope; see [Restore database](restore-database.md). Atlas backups do not roll
back deleted R2 objects.

## When a tool fails

Keep the outcome and any Error ID with the support issue. Refresh the account
before retrying an operation whose outcome is uncertain. For a reported-content
decision, the moderation queue explicitly handles an already-resolved report;
see [Moderation](../admin-console.md#moderation).

## Posting an incident notice

Open **Admin → Announcements**. This edits the one public `site_config` document with `_id: 'banner'`; a saved notice is visible to its selected audience. Draft previews stay in the browser until Save.

1. Choose a template or write a short impact statement (maximum 240 characters). Explain what users should do and whether their local files or saved data are affected. Verify those claims before publishing.
2. Choose the narrowest audience. **All** reaches web and agent; **Website** reaches the app; **Agent** is returned by the version feed; **Stream Studio** and **Guides** reach matching web goals/surfaces.
3. Choose **info**, **warning** or **critical**. Critical notices cannot be dismissed. Other notices can be dismissed in that browser for that notice identity.
4. Set the start and required end time in your local time. The API stores UTC. A scheduled notice stays hidden until its start; expiry is enforced by both the API and web component. Only same-site More information links are accepted.
5. Check the live preview, then Save. Connected authenticated tabs receive a text-free `site:banner` refresh hint. The public endpoint uses `max-age=60` and ETags; cached copies can take one minute to refresh. The agent reads applicable notices through its existing version check, even when no newer installer is available.
6. End the current notice early when the issue is resolved. This expires it and keeps its revision. If another admin saved first, reload and review the current notice before making another edit. A failed save keeps your draft and offers Retry.

`GET /v1/site/banner` is public and returns only the active notice, never admin identity. Admin GET/PUT/DELETE `/v1/admin/announcements` require existing admin authorization. The version feed includes only `all` or `agent` notices. No email, push provider or scheduled job is added.

## Curating product updates

Add reviewed entries to `apps/api/src/data/whatsNew.json`; `apps/web/lib/whatsNew.ts` exports the shared catalogue. Keep stable lowercase IDs, dates in descending order, short highlights, an accurate audience and a resolving help slug. Only set `major` for changes that deserve a personal notification. Do not announce unfinished functionality or invent a desktop version; `agentVersion` is optional.

The public changelog/RSS and signed-in sheet use the same entries. A signed-in `/v1/me` visit lazily delivers recent major entries; the existing notification delivery index prevents repeat delivery after retries or reads. There is no all-users fan-out job. Notification muting and the existing 90-day retention apply.

Before merging, run the curated-catalogue, RSS, Markdown, banner, editor and updater tests, regenerate the help index, and check the production route budgets. Normal startup creates the global configuration collection on its first save. No production save or notice was executed as part of development verification.
