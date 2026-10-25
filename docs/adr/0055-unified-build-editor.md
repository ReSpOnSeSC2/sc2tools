# ADR0055: One rich build editor and a bounded action picker

Status: Accepted

Every create path will reach the existing rich BuildEditorModal. Its explicit
Save, create-only collision checks, locked edit slug, source provenance,
publication controls and unsaved-close guard remain authoritative. A Start
from chooser supplies a game, detected label or blank seed. Paste remains
clearly unavailable until reference-build-order lands; Community remains a
separate copy-to-library route.

The game picker reuses the existing private `/v1/replays` filtered listing,
with 20 rows per cursor page and one selected `/games/:id/build-order` read.
The older `/v1/games` listing does not apply build/matchup filters. No new
endpoint or analysis fanout is needed. The detected-label cohort follows the
existing stored effective build label, including confirmed check-ins; the UI
states that scope explicitly. Owner remounts, request aborts and source epochs
fence late list/detail responses, including an A→B→A filter change.

The reusable Combobox uses the ARIA 1.2 input/listbox pattern, keeps keyboard
focus in the input, supports ordinary Tab navigation, and renders at most 60
filtered choices. TokenPicker supplies a deterministic generated catalog from
the existing unit/icon metadata and explicit upgrade aliases. Friendly labels
are displayed while existing canonical event tokens are retained. Race and
proxy metadata constrain choices without changing the evaluator.

Unknown persisted tokens remain visible for correction. The editor blocks Save
and live preview for unknown draft actions instead of silently omitting them.
The shared structural rule reader remains compatible with existing stored
data. Catalog validation lives in the lazy editor path so unrelated dashboard
and game consumers do not eagerly import the complete picker catalog.

No API schema expansion, provider calls, migrations, new infrastructure, AI,
production activation or native release is required.

Auth return compatibility uses only the public `/definitions?variant=<id>`
continuation. Its exact generated catalog-id allowlist is separate from catalog
prose (1,294 bytes gzip), so auth helpers need not import all descriptions.
The catalog preserves only a single valid variant intent and shows an explicit
signed-in continuation link. No private redirect or write runs automatically,
and private library filters never enter that public continuation. The Auth pack
keeps private `/builds` excluded from its allowlist and owns the corresponding
public-path sanitizer integration. `npm run definitions:gen` regenerates the
tiny IDs through its post script; catalog parity is tested.
