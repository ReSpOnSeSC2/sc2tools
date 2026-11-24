# ADR 0100: Agent release notes follow published GitHub releases

Status: Accepted, November 24, 2026. Supersedes the consequence in ADR 0077
(`docs/adr/0077-game-start-scouting-recent-builds.md`) that every agent
release needs a website edit once it is published.

## Context

- `FALLBACK_LATEST_AGENT_VERSION` (`apps/web/lib/agentNotice.ts`) did two
  jobs. `AgentUpgradeNotice` and `DoctorBanner` show it before
  `/api/agent/version` answers or when that request fails, and it was the
  newest entry of the public Agent release history (`/changelog` and
  `/changelog/agent.xml`), which was rendered once per deploy.
- An agent release is cut by pushing an `agent-vX.Y.Z` tag. The installer
  workflow builds a draft release, and the owner publishes it by hand later.
  The release commit leaves the constant on the previous release, because the
  new one isn't published yet; version-check accepts the package version or
  the release before it.
- So after every publish someone had to open a pull request to raise the
  constant (#982 for 0.25.6, #985 for 0.25.8). Until it merged, the changelog
  page and the feed stayed one release behind. `/api/agent/version` and the
  API's `/v1/agent/version` already followed GitHub.
- Unauthenticated GitHub API calls from shared hosting IP addresses are
  routinely rate-limited (recorded in
  `apps/api/src/services/agentGithubReleases.js`).

## Decision

1. One server module, `apps/web/lib/agentReleaseSource.server.ts`, reads the
   newest published `agent-v*` release from GitHub's release list: not a
   draft or prerelease, and with the Windows installer attached.
   `/api/agent/version`, the changelog page and the Agent RSS feed all use it,
   so they name the same release and share one request, kept in Next's data
   cache for 10 minutes. The lookup gives up after 10 seconds. It enforces
   that deadline itself, because Next drops a fetch's abort signal whenever it
   refreshes a stale cache entry, which every regeneration and every Vercel
   build does.
2. The changelog page and the feed stay statically rendered and revalidate
   every 10 minutes. They list the agent changelog from the newest entry at
   or below the newest published version, so notes for a version still being
   prepared never show. A published release appears within about 20 minutes
   (at most two 10-minute cache periods) of the next visit, with no deploy or
   pull request.
3. When GitHub can't be read:
   - while building, in development and in tests, the list starts at the
     committed `FALLBACK_LATEST_AGENT_VERSION`, so a deploy never fails because
     of GitHub. A deploy made during such an outage therefore starts at most
     one release behind, until a regeneration reads GitHub;
   - on a production server the lookup throws `AgentReleasesUnavailableError`,
     so Next keeps serving the page it last rendered from a good answer. A
     running site never drops back to an older list. Next retries a failed
     regeneration about every 30 seconds while the route is visited. The error
     is expected, so `instrumentation.ts` leaves it out of Sentry reports;
     Next still logs it.
   A release list with no published agent release also starts at the
   constant.
4. `FALLBACK_LATEST_AGENT_VERSION` keeps only its safety-net role. Each
   release commit still sets it to the release before the version it
   prepares, and nothing has to change after publishing; raising it to the
   published version afterwards stays allowed and only makes the loading
   placeholder current sooner. version-check keeps its rule (the package
   version or the release before it). It can't tell whether the package
   version is published, so it can't catch a release commit that names the
   version it prepares. That mistake would show the unpublished version only
   where the constant is used (the loading placeholder, and the changelog
   while GitHub can't be read). The release checklist and this ADR rule it
   out. A stricter check would have to ask GitHub whether the package version
   is published.
5. `next.config.mjs` traces `apps/agent/CHANGELOG.md` into the changelog
   routes, because they now read it whenever they render, not only during the
   build. A unit test checks that the include covers both routes.
6. The end-to-end smoke points `AGENT_RELEASES_URL` at its fixture API, which
   can't answer, so CI never depends on GitHub; it checks the fallback path.
   Unit tests cover following GitHub. Production leaves the variable unset,
   and `GITHUB_TOKEN` is only ever sent to `api.github.com`.

## Alternatives considered

- **A workflow on `release: published` that commits the new constant to
  main.** main isn't branch-protected, so a `GITHUB_TOKEN` push would work,
  but a push made with that token starts no workflows: main would carry a
  commit no CI ever checked, and a personal or app token that does start them
  is a new secret, which the standing rules exclude. The push would also race
  the owner's fast-forward pushes and any open branch that edits the same
  line, cost a full production deploy per release, and keep naming a release
  that is later unpublished or deleted unless it handled those events too.
  Reading GitHub when the page renders has none of these problems.
- **On-demand revalidation from a release webhook.** It needs a secret shared
  between GitHub and the web host, excluded for the same reason.
- **Falling back to the constant on the live site too.** Simpler, but every
  rate limit would move the page and feed back one release for at least 10
  minutes, the symptom this change removes.

## Consequences

- Publishing the draft release is the last manual step. No pull request is
  needed afterwards; the raise to 0.25.8 (#985, landed on main as f28251ea)
  is the last one.
- Unless someone raises it, the loading and failure placeholder in
  `AgentUpgradeNotice` and `DoctorBanner` names the release before the
  package version: one release behind once that version is published, but
  always a published one, and replaced as soon as `/api/agent/version`
  answers.
- The changelog page and the feed depend on GitHub when they render;
  failures are handled as in decision 3. Setting `GITHUB_TOKEN` on the web
  deployment is optional and lifts the rate limit, as it already does for
  `/api/agent/version`.
- In normal operation the two routes regenerate at most 12 times an hour in
  all, and only when visited; during a GitHub failure, Next's retries add one
  GitHub request about every 30 seconds per visited route. No new service or
  paid feature is involved.
