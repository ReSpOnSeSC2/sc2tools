# ADR0057: Bounded build timings and declared-plan cohorts

Status: accepted for implementation (`build-dossier-insights`, Wave 4).

Key timings reuse the existing bounded dossier samples and matchup timing
catalog. Winner/loser medians are derived from those same observations and stay
unknown unless both outcomes have at least five samples. There is no extra
replay/R2 hydration for this comparison. Community comparisons require an exact
published guide and recorded comparable timings; missing evidence stays absent.

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
