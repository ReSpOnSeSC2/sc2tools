# Wave 2 installer/autostart checkpoint

Branch codex/wave2-agent-installer, separately stacked on runtime PR #668.
Scope agent-installer-autostart: one Run startup mechanism, legacy migration,
installer startup/desktop options, silent choice preservation, Finish Launch now,
opt-in named local-data removal, and two-stage signing preparation.

Autostart and packaging contract checks: 22 passed, including actual NSIS
compilation of a fixture bundle and signature-verifier failure cases. The real
unsigned bundle/setup build is in progress; an inaccessible external pip cache
requires a workspace-local cache. No installer has been executed or published.

The SignPath Foundation workflow is prepared and pinned to official v3.0.
Owner-approved project/certificate, API token and repository variables are still
required. No signature has been requested or claimed. Tagged release builds will
fail closed without configured signing. No version bump, tag or publication.

Help/install expander and final full-suite/build verification remain before the
draft opens. No AI feature/call and no application infrastructure change.
