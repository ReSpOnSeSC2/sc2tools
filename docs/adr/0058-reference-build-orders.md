# ADR 0058: Reference build orders

Status: accepted for implementation, 2026-10-25.

The optional `buildOrder` is a bounded display and practice contract, separate
from classifier `rules` and legacy `signature`. It contains version 1, a source
(`game`, `paste`, or `manual`), and at most 120 steps. Each step has an integer
time in seconds or `null`, supply or `null`, an action of at most 80 characters,
an optional 140-character shareable instruction, and optional `supplyApprox`.
Supply-only imports retain unknown time; they never acquire an invented 0:00.

Unknown actions remain reference text with a warning. They do not weaken the
rules editor's strict token validation. Classification projections and rule
hashes never read this field. Reference-only builds have no matching rules.

API validation projects known nested leaves before validation and retains one
excess step to reject oversized requests. Full owner detail includes reference
data. Library lists and classifier pages omit it. Community publication and
detail include bounded reference steps but never `buildOrder.sourceGameId`;
step instructions are explicitly shareable, while the build's personal notes
remain private. Community listings omit full reference orders.

The deterministic paste parser accepts bracketed clocks, Spawning Tool columns,
Liquipedia supply-only rows and plain clocks. Errors prevent partial import;
unknown action and unknown timing warnings do not prevent saving. A maximum of
120 nonempty input lines bounds both preview and error rendering.

Practice uses supplied valid timed steps only, and requires enough eligible
checkpoints under the existing Ghost target contract. It must not infer times
from supply or turn rule deadlines into recorded build times.

Clarification, 2026-10-27: source replay IDs are opaque private strings, not
classifier tokens. Web and API accept a nonblank single line of at most 256
Unicode code points, rejecting controls while retaining exact punctuation,
names and separators. Public projections still omit this provenance. Detailed
field errors stay in the rich editor and share the compact reader's scalar
validators, so public reference displays do not load the editor's error copy.
