# Shared editor ownership correction

Save, preview and replay-inspection requests are scoped to the loaded signed-in
owner and one open/source epoch. An account/loading/close/source change makes
old callbacks invalid during render, before JWT acquisition can dispatch. A
single 20-second operation deadline covers JWT, headers, response body and any
publication repair. Abort also settles adapters that ignore cancellation.
Late results cannot repair publication, set success, toast or call `onSaved`.

The source identity includes the locked slug, replay/perspective, save intent,
create-only mode, bounded legacy source signature and initial draft content.
Same-owner changes to the source signature or create-only mode are covered by
held-JWT regressions in addition to account A→B and A→B→A response-body cases.

The reviewed optional-editor lazy boundary and its three existing landing/
replay entry points are reused to keep the added safety code out of initial
page bundles. It preserves exact props, retries a rejected/timed-out import
and leaves the surrounding page available on Cancel. No Reference-only schema,
token catalog or classifier behavior is included in this hotfix.

The baseline backport retains main's existing token rules. Complete-auth test
fixtures preserve the real bounded request helper. Initial verification: 58
affected assertions passed across the actual request hook, modal, saved-editor,
lazy-load and landing consumers; full web types passed. Final production,
browser and remote CI evidence is recorded with the PR before merge.

No provider call, integration enabling, environment mutation, version, release,
data migration, infrastructure or budget change accompanies this correction.
