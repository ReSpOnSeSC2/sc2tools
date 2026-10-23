# Coordinated Wave 2 desktop release

Pairing recovery and calm sync ship in the same installer as the other accepted
Wave 2 desktop changes. This PR prepares source and help only; it does not build,
publish, tag, or execute an installer.

1. Merge the pairing website/devices dependency and all accepted desktop Wave 2
   PRs. Keep the existing device poll response: `ready` includes `deviceToken`
   and `userId`. Pairing start accepts hostname, OS, and version metadata.
2. Run the complete Windows agent test suite with Qt offscreen, the web help
   suites and generator, and the existing production build and bundle budgets.
   Exercise first pairing, offline start, expiry renewal, unlink/relink, and
   reconnection with a real pending replay on a test PC.
3. In the final coordinated release PR, set the chosen version in
   `apps/agent/sc2tools_agent/__init__.py` and the matching web fallback in
   `apps/web/lib/agentNotice.ts`. Move the agent Unreleased notes under that
   version and update the release notes. Version-check CI must pass.
4. After that PR merges and integrated CI passes, the **owner** creates and
   pushes `agent-vX.Y.Z` using the chosen package version. Follow
   `apps/agent/packaging/README.md` for the existing installer workflow,
   checksum, signature, GUI smoke check, and release verification.
5. Verify that Download and the update feed resolve the new stable installer.
   Existing PCs keep their settings, queued work, and replay cursor when they
   update. No new environment variables, secrets, services, or infrastructure
   are required.

Do not push a release tag from a preparation branch. To roll back the source,
revert the affected PR; to change the published stable installer, follow the
existing owner release procedure rather than replacing a checksum in place.
