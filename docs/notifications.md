# Personal notification center

The authenticated `/v1/me/notifications` router is always available. Review rollout flags gate review producers, not the inbox. Both normal web shells render the bell for signed-in users; overlay and Dock token surfaces keep their existing isolated UI.

Notifications remain in the existing collection with its 90-day TTL. The server emits only `notifications:changed {kind}` to the user's room. Text and destination URLs are read through authenticated, user-scoped REST endpoints. The web keeps its slow polling recovery. No new scheduled job, delivery provider, push infrastructure, or email send is introduced.

## Event delivery and grouping

`NotificationsService.notify()` reads only the recipient's notification preferences and skips muted kinds. New event-driven producers pass both `groupKey` and `eventKey`. An unread group folds distinct deliveries together, while the unique `(userId, deliveryKeys)` multikey index prevents retries from incrementing a group or creating another row after it was marked read. Delivery keys are not serialized to clients. Retention bounds their lifetime to the existing notification lifetime.

| Producer | Kind | Delivery identity |
| --- | --- | --- |
| Completed desktop import | `import.done` | Import job ID |
| Authenticated heartbeat below the release's minimum version | `agent.update_required` | Minimum supported version |
| Positive community vote transition | `community.vote` | Voter, build slug and UTC day; grouped per slug/day |
| Report status or reply | `support.status`, `support.reply` | Report ID and admin action request ID |
| Existing coaching mutation emit points | `coaching.booked`, `coaching.cancelled`, `coaching.assigned`, `coaching.practice_sharing_*` | Booking, assignment or sharing-request identity and event kind |

Import completion uses the authoritative job's `completed` count and says **games synced**. That metric includes successful reuploads; calling it newly added games would be inaccurate. No desktop protocol or GUI change is needed. Cancelled, failed or stalled jobs do not create a completion notification. There is no scheduled “agent offline” notification.

## Support round trip

Reports remain `user_message` admin events. `GET /v1/messages/mine` returns only the signed-in sender's latest 20 reports, status and replies, with an explicit public projection. It excludes admin identity, account email, Clerk IDs and attached diagnostics. The Settings Help tab renders this history.

Admins update a report through `PATCH /v1/admin/messages/:eventId` with `{expectedRevision,requestId,status?,reply?}`. Status is `new`, `looking`, `fixed` or `wontfix`; replies are limited to 2,000 characters. Compare-and-set revision checks protect concurrent edits. Reusing the same request ID retries the original action and its notification delivery; conflicting reuse is rejected. Each report holds at most 50 actions. The admin UI preserves reply drafts on failure. Email-only reports have no in-app reply recipient.

## Preferences and UI

`GET/PUT /v1/me/preferences/notifications` stores `{muted: string[]}` separately from Misc and onboarding preferences. Settings Misc has per-kind controls and its own save/recovery state. Muting affects future deliveries only.

The bell preserves its cursor and read-acknowledgement behavior. Its presentation is loaded on demand to protect route budgets. Opening marks visible rows read but retains their per-open New tint. Unread/All is a visible segmented control, categories filter loaded rows, and the full `/notifications` page uses server-side category filtering plus compound cursors. Focus enters the first row or empty header and returns to the bell on close. The bell remains available on count errors with Retry. Coaching alerts and build check-ins remain actionable queues and use the same compact chip/badge visual treatment.
