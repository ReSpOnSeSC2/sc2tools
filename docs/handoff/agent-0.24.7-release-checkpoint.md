# Desktop agent 0.24.7 release

The owner explicitly requested the agent version bump, changelog update and
release tag on 2026-10-25. That instruction overrides the older handoff's
no-version/no-tag restriction for this release. No installer execution,
credential setup or new integration enablement is implied.

Release source starts at tested main
`cfcf5abdebc33c74de24435cfa3729548b5ac9e1`. The preserved branch is
`codex/release-agent-0-24-7` in `wave3-private-scouting`; earlier build-fix
branches and ignored package/build caches remain intact.

The package and website fallback move from 0.24.6 to 0.24.7. Both changelogs
describe the PvT DT priority correction, seven-minute PvZ air openings,
in-game scouting close/minimize controls, recorded scouting confidence and
updated Ghost/OBS guidance. Existing saved replay labels require an explicit
recompute after updating; planned selections remain separate.

Local focused installer/updater/scouting/instant-engine checks: 150 pass.
The initial sandbox attempt could not create temporary fixture directories;
the identical checks pass using a fresh workspace-local directory with normal
reviewed host access. The exact version-check workflow script also passes:
agent/fallback 0.24.7, engine 1.6.12 and Pyodide 314.0.7. No engine version bump
is required. Current main already passed both Windows partitions and engine
parity before the version-only release preparation.
Full web types and strict lint for the changed fallback also pass.

Release prerequisites: `.github/workflows/agent-installer.yml` requires approved
SignPath configuration for tag builds and creates a draft release. A read-only
repository settings check found no Actions repository variables configured,
so the tag build will stop at its existing signing gate until owner setup is
complete. No variables, secrets, account, signing policy or guard was changed.
No installer or signed release is claimed.

The web provider's separate free deployment quota is exhausted. Website
production remains on b97fb80c with the DT browser engine and Macro build editor;
the tested cfcf5abd navigation source is merged but its production rollout is
pending the quota reset. Desktop tagging is a separate pipeline.

Final release commit, PR checks, merge and the single `agent-v0.24.7` tag push
remain to be recorded. Never replace an existing tag or push unrelated tags.
