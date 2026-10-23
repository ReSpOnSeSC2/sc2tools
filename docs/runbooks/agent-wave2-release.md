# Coordinated Wave 2 desktop release

Pairing recovery and calm sync ship in the same installer as the other accepted
Wave 2 desktop changes. Preparation PRs can run unsigned verification builds and
the offline packaged Qt diagnostic. They do not publish, tag, or execute setup.

1. Merge the pairing website/devices dependency and all accepted desktop Wave 2
   PRs. Keep the existing device poll response: `ready` includes `deviceToken`
   and `userId`. Pairing start accepts hostname, OS, and version metadata.
2. Run the complete Windows agent test suite with Qt offscreen, the web help
   suites and generator, and the existing production build and bundle budgets.
   Exercise first pairing, offline start, expiry renewal, unlink/relink, and
   reconnection with a real pending replay on a test PC. Check relaunch activation,
   close with and without a tray, timed pause, instant folder Undo, status/action
   agreement, history/capture holds during a match, OBS-output update deferral,
   manual install with auto-update off, and mandatory snooze persistence.
   Installer signing and publication remain owner release steps; source tests do
   not prove a published installer is signed.
3. In the final coordinated release PR, set the chosen version in
   `apps/agent/sc2tools_agent/__init__.py` and the matching web fallback in
   `apps/web/lib/agentNotice.ts`. Move the agent Unreleased notes under that
   version and update the release notes. Version-check CI must pass.
4. Before creating a tag, the owner obtains the approved SignPath Foundation
   project/certificate and configures `SIGNPATH_API_TOKEN` plus the repository
   variables listed in `apps/agent/packaging/README.md`. A real signed workflow
   run must verify trusted timestamped signatures on the inner executable and
   setup. Tagged builds fail closed while signing is unconfigured. Local unsigned
   build success does not prove certificate issuance or publisher trust.
5. After that PR merges and integrated CI passes, the **owner** creates and
   pushes `agent-vX.Y.Z` using the chosen package version. Follow
   `apps/agent/packaging/README.md` for the existing installer workflow,
   checksum, signature, GUI smoke check, and release verification.
6. Verify that Download and the update feed resolve the new stable installer.
   Existing PCs keep their settings, queued work, and replay cursor when they
   update. No application-server environment or infrastructure changes are
   required. The release workflow does require the owner-managed signing secret
   and repository variables above. Before publishing, test fresh/upgrade options,
   legacy startup migration, silent opt-out preservation, and both uninstall-data
   choices on a disposable Windows test profile. Never use real replay folders as
   a deletion fixture.

Do not push a release tag from a preparation branch. To roll back the source,
revert the affected PR; to change the published stable installer, follow the
existing owner release procedure rather than replacing a checksum in place.
