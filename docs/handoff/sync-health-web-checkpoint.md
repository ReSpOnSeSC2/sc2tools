# Sync health web: checkpoint (roadmap item 76, B2)

The website now explains the heartbeat sync report exposed by the API slice.
This slice adds no writes. The add-one-identity action and reason-scoped retry
remain B3; the agent heartbeat producer remains B1.

## Surfaces

- Settings → Account has a native `sync-health` section, registered in both
  the section navigation and Find a setting. Its shell loads the card in a
  separate chunk. The card reads `/v1/me/sync-health` when mounted, with no
  polling, focus refresh or reconnect refresh. **Check again** explicitly
  refreshes it. A failed initial read shows the shared request error with
  Retry; a failed refresh keeps the last result and says it could not refresh.
- The card names all six API reasons, their PC when applicable, the next
  action and a help section. Date-filtered counts get **Change sync window**,
  which opens the desktop sync-range help section. Other skip counts appear
  in a disclosure, using the same skip-reason copy as import progress.
- The card alone lists the unresolved names and toon handles from a current
  report. It does not offer a pretend identity or retry button before B3's
  routes exist. **Set up profile** and the desktop-app instructions work now.
- **Report** opens the existing lazy problem report form. Its prefill contains
  reason codes, counts and the check timestamp. It excludes player names,
  toon handles, PC names and labels.
- Devices shows each stored report's state and counts, including the last
  upload. A report older than five minutes, missing its date or dated in the
  future is muted and described as the last report. Player names and toon
  handles never render here. A PC with no report keeps its previous display.
- The agent pill keeps `/v1/me` as its presence and game-count source. The
  summary chunk and `/v1/me/sync-health` read start only when the popover opens.
  It lists the top three reasons and links to Settings, Devices and help. It
  renders no PC or player names or toon handles. Failure of the summary code
  or request leaves the presence details available.
- The Doctor banner and Setup health name the six new warning ids and link
  to their own help sections. The banner omits informational pauses. Its
  shared Doctor hook refreshes every 30 seconds only while an archive or
  sync-health warning exists, so a desktop fix clears the warning. The Today
  upgrade notice reads the Doctor cache without issuing another Doctor
  request and yields when the Doctor already shows the required-version
  warning.

## Old agents and unavailable PCs

`reported: false` is not a healthy report. The pure `lib/syncHealth.ts` module
distinguishes no linked PC, all PCs offline, and an online app that does not
report sync health. Account-wide rejected-upload warnings still show in those
states. The module shares the API's six closed reason ids and preserves an
unknown future row with a generic title and a valid help slug.

`lib/syncReasons.ts` holds the existing import skip copy, re-exported from
`useImportStatus.ts` for its existing consumers. Neither pure sync module
imports React, a component, a hook or a socket.

## Help and navigation

`my-game-didnt-show-up` now has a Sync health section and an anchor for each
reason, filtered replays and the not-reported state. The help contract tests
check every generated link against real article anchors and compare the
closed codes and help slugs with the API source. The Settings search browser
fixture admits the new read and expects the native section in the Account
navigation.

## Verification status

An independent source review and a separate refuting verifier pass found no
confirmed blocker in the completed B2 scope. A strict UTF-8 byte scan found no
replacement characters, NULs or suspicious escaped Unicode in the changed
sources. `git diff --check` passed. These are source checks, not runtime or
build acceptance.

The interrupted WIP and these completion changes need the root's serialized
checks before delivery. No build, test, budget or mutation result is claimed
by this checkpoint yet.

Focused tests include:

- `lib/__tests__/syncHealth.test.ts` (rules, reported states, freshness,
  privacy, skip copy and purity).
- `components/analyzer/settings/__tests__/SyncHealthCard.test.tsx` (all six
  reasons and fixes, names visible in Settings only, Report prefill, initial
  error and retry, explicit refresh and retained stale answer).
- `components/__tests__/AgentSyncPill.test.tsx` and `DevicesPanel.test.tsx`.
- `components/analyzer/__tests__/DoctorBanner.test.tsx`, the Setup health
  suites and `components/dashboard/__tests__/AgentUpgradeNotice.test.tsx`.
- `lib/help/__tests__/syncHealthLinks.test.ts`, existing help suites, Settings
  index targets and `tests/e2e/settings-search.spec.ts`.

The full web gate, TypeScript, changed-file ESLint, UI lint, the unchanged
route budgets, review plus refuting verification and deliberate mutations
are still required. A2 owns `desktop-app-status.ts` and `agentLinks.test.ts`;
this slice does not edit either file.
