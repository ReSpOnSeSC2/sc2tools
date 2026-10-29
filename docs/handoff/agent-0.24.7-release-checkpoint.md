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

## Verified delivery

PR757 passed every exact-head check at
`7158b79bb9c6aa25bb66f4da1b1386150006aa6e`, including both Windows partitions
and their aggregate gate, web/responsive checks, engine parity, versions and
Vercel preview. Fresh-main reconciliation matched tested tree
`f228adabee3c2f25dd3d4ef46cdd6ee785829e4a`.

The PR was squash-merged as `ae21f7a284176112021cdcb80781ca7613fc5032`.
The single annotated `agent-v0.24.7` tag was pushed; GitHub's remote tag object
`6f4aa9b29df8c30a3125fed8f9c861d8b905b22d` was verified to point to that commit.
Never replace this tag or push unrelated tags.

The tag's installer run, `40256176096`, resolved version 0.24.7 successfully
and then failed at **Check signing configuration** with the existing approved
SignPath prerequisite error. Bundle, signature, installer upload and release
steps were skipped. No installer was produced or installed. The signing guard
and owner setup requirements remain intact.

The automatic website production status for merged main ae21f7a2 was also
rate-limited by Vercel. No deployment retry or plan upgrade was attempted;
production rollout remains separate from the verified desktop Git tag.

## 2026-10-29: actual manual unsigned publication

The tag-triggered signing failure and website quota observations above are historical. The later manual artifact and publication below supersede the current no-installer/no-public-release state; they do not claim the signing gate passed.

The owner explicitly approved publishing this 0.24.7 installer unsigned. Existing tag `agent-v0.24.7` and tag object `6f4aa9b29df8c30a3125fed8f9c861d8b905b22d` were preserved. Manual Windows run [40823286314](https://github.com/ReSpOnSeSC2/sc2tools/actions/runs/40823286314), job `123280448387`, succeeded at source `0eb06c18e5d5743e7230e4b4db41553fca6e363f`; agent/packaging inputs match the existing release tag. Bundle/installer/checksum/artifact and two packaged Qt offline paint checks passed. Signing steps were skipped.

[Agent 0.24.7](https://github.com/ReSpOnSeSC2/sc2tools/releases/tag/agent-v0.24.7) was published at `2026-10-29T12:02:09Z` as release `427506713` and confirmed as latest. Installer asset `687504990` is 231,728,420 bytes, SHA-256 `c404cd377da5ed8bb35b3f352537d0af9e134bfdd5c8a1e3092aa965e450d76c`; checksum asset `687504994` is 98 bytes. Anonymous public latest and checksum reads returned 200, and the checksum bytes matched. Exact verified installer bytes retain Authenticode `NotSigned`; no signed-publisher claim is made.

Publication used one update of the existing draft. No rebuild, retag, installer launch, signing request, workflow/security/provider change or secret-value inspection occurred. All eight publication CLI children exited successfully; scoped PID/possible-descendant/listener cleanup was empty. The public HTML web-reader cache miss is retained separately; public REST/checksum verification succeeded.

Installer availability/publication subrequirements can now be recorded for the existing native delivery rows. No whole ledger item is closed by this receipt: installed/updater and live match/capture/session acceptance, actual OBS/provider operations, and each item's remaining original augments are still separately qualified. Public GitHub latest does not by itself prove the application's merged update feed or installed updater uptake. Future unimplemented native/engine features are not supplied by this release.

The original `agent-installer-autostart` signing criterion remains unmet. The accepted unsigned exception fulfills this current publication; it must not be turned back into a current SignPath publication blocker. The owner requested a step-by-step SignPath walkthrough for future versions after the program updates. No account, project, certificate, secret or signing setting was configured here.

Sanitized publication evidence: [publication-2026-10-29.json](validation/agent-0.24.7/publication-2026-10-29.json). Existing ledger statuses/counts remain unchanged; subsequent status changes require the complete original requirements and acceptance evidence.

Four ordinary public GETs separately verified GitHub release-list eligibility
and the actual updater API's 0.24.7 metadata with the expected installer
checksum. Two identical website-feed requests still returned 0.24.6: first
Vercel STALE/Age969 with Date12:41:31, then HIT/Age109 with Date12:57:41.
The outer response refreshed with the same old body. Inner Next data-cache or
regeneration freshness remains unproved; these observations establish neither
a source-selection bug nor a browser-only or simple edge-TTL cause.

GitHub publication and API updater metadata are verified. Website-current
version acceptance and installed updater uptake remain pending. No installer,
forced refresh, purge, rebuild, new signing setup or configuration change was
performed by this follow-up. The approved unsigned publication remains complete.
