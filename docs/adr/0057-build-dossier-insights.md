# ADR0057: Bounded build timings and declared-plan cohorts

Status: accepted for implementation (`build-dossier-insights`, Wave 4).

Key timings reuse the existing bounded dossier samples and matchup timing
catalog. Winner/loser medians are derived from those same observations and stay
unknown unless both outcomes have at least five samples. There is no extra
replay/R2 hydration for this comparison. Community comparisons require an exact
published guide and recorded comparable timings; missing evidence stays absent.
Win rate uses decided results, retaining ties and unknowns only in timing counts.
Timestamp ordering drives recency; missing dates suppress recency claims.

The shared split-store hydrator reads at most 25 games sequentially and retains
detached bounded first-start observations, including correct morph rewind for
unordered logs. Performance retains the complete slim cohort. Community uses
one indexed maximum-nine-key guide snapshot batch with serve-time publication
floors, exact catalog provenance, matching era and first-start equivalence.
Private same-name definitions and completion/later-occurrence milestones do
not create deltas.

Plan survival is a facet of the existing owner/visibility-scoped slim game
aggregation. Confirmed check-ins already preserve the declared effective build
label while storing the detector's label separately. Ordinary detected games
stay in performance totals but never inflate the declared denominator. A known
custom slug is compared before its mutable name; otherwise labels match exactly.
Missing detection means no different label was recorded, not proven execution.

Counts and W-L rates cover the complete declared cohort. Ranked lists remain
bounded to five rows. Full game duration when labels differed uses the existing
Mongo approximate-percentile pattern and is explicitly labelled an estimate;
it never claims to date when or why a plan changed. No unbounded game array,
additional list fanout, new collection/index/job/infrastructure, production
mutation or AI/model call is introduced.

Rank links carry at most 20 latest owner-only sample IDs, independent of their
full counts. Library Held summaries reuse their existing grouped stats query
and are null below five declarations. Owned game comparisons reuse one exact
loaded-intent dossier SWR resource for all rows, with no row requests. Only the
first owner building occurrence receives a chip; previous/failed cache data,
deleted or unidentified references and the opponent column supply no baseline.
