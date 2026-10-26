# ADR 0066: Extend the shared chart foundations

Status: Source implemented; validation and delivery pending.

## Existing foundations and compatibility

The chart kit builds on useChartTheme, ChartTooltip, QueryState and
WinRateComparison. Existing hook fields stay present and the new palette is an
optional field, so pending dossier/execution consumers do not need a synchronized
API change. Its dark fallback matches current CSS. New kit values/functions are
memoized until the resolved theme or motion preference changes.

ChartTooltip keeps its existing props and reads CSS tokens, including nested
replay colors. Legacy concrete wrRamp/wrRampHex signatures and default numerical
palette remain available; an optional palette supports new concrete consumers.
CSS wrColor readers use theme tokens/interpolation and retain their old under-3
neutral threshold. The new kit's chart cue is under20 decided results. No caller
that currently consumes wrColor parses its result as RGB numbers.

## Data and interaction boundaries

ChartFrame receives the same already-filtered rows as the visual. It does not
request data or calculate metrics. QueryState preserves error versus empty and
current versus previous-filter behavior; failed stale summaries stay hidden.
The frame adds a summary, optional legend, and a keyboard-scrollable data table.
Drilldown/table actions keep their existing callback and boundary inputs.

MMR/macro bands use comparisons instead of connected categories or dual axes.
Each existing denominator, timezone, date/play-count ordering, domain, reference,
minimum and top-N filter remains owned by the existing consumer. Mechanics uses
measured sample counts; other rate cues use decided outcomes separately from the
rate denominator. Missing measurements remain missing. Reduced motion suppresses
effects without changing the evidence or preventing selection.

## Color and limits

Eight category tokens are paired across Light/Dark and replay scopes. Color
names and dashes supplement the legend; overflow series may repeat a color.
Actual CSS colors are tested for contrast and pairwise CIE76 ΔE >=15 under normal
vision and a severity-1 deuteranopia simulation. The reference calculations use
[CIE Lab](https://cie.co.at/eilvterm/17-23-076),
[CIE76 distance](https://cie.co.at/eilvterm/17-23-077) and the rounded matrix in
[Machado's author-hosted thesis, Appendix A](https://www.inf.ufrgs.br/~oliveira/students_dissertations/Masters/Gustavo_Machado_Masters_thesis_UFRGS_2010.pdf).
This is a regression model, not a claim about every person's color perception or
full assistive-technology conformance. Names, patterns, records and tables remain
the primary alternative to color.

No dependency, API, provider, integration, budget or metric is added. Scope is
the named chart-kit consumers and matrix ramp; the wider UI roadmap remains
separate. Delivery and exact proof are root-owned after local validation.
