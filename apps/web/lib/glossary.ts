/**
 * Glossary: the short, plain definitions of terms the analyzer uses
 * without explaining them on screen (Pulse ID, Net MMR, …). Each term
 * points at the help article section that explains it in full, so an
 * info tip beside a column header or a toggle can say one sentence and
 * link to the rest.
 *
 * Plain data, like the help articles; the help tests check that every
 * `help` link resolves to a real article and heading anchor. Add a term
 * here before adding a tip for it in the UI.
 *
 * Deliberately free of imports: an info tip that reads one definition
 * must not pull every help article into its page's bundle.
 */

/** Topic a term belongs to, for grouping on a glossary page. */
export type GlossaryCategory = "opponents" | "mmr" | "macro" | "statistics" | "builds" | "overlay";

export interface GlossaryTerm {
  /** Stable id: lowercase letters, digits and hyphens. */
  id: string;
  /** The term as it appears on screen. */
  term: string;
  /** One plain sentence, short enough for a tooltip. */
  short: string;
  /** Additional context and measurement limits for the glossary page. */
  long?: string;
  /** Plain text for the measured formula or rule; never executed by the UI. */
  formula?: string;
  /** Ids of related terms. */
  related: string[];
  category: GlossaryCategory;
  /** Where the term is explained in full: a help article and, optionally, one of its heading anchors. */
  help: { slug: string; anchor?: string };
}

export const GLOSSARY: readonly GlossaryTerm[] = [
  {
    id: "likely-range",
    term: "Likely range",
    short: "The uncertainty around a guide's recorded win rate; fewer games make the range wider.",
    long: "Guide openers are ranked by the low end of this range so a few lucky games cannot top the table. Verdict symbols describe whether the whole range is above or below an even result, or too close to call.",
    related: ["sample-size", "publishing-floor", "trend-arrow"],
    category: "statistics",
    help: { slug: "reading-guide-stats", anchor: "likely-range" },
  },
  {
    id: "publishing-floor",
    term: "Publishing floor",
    short: "The minimum sample of games and players needed before a guide statistic is shown.",
    long: "Individual cells and full guide pages have different sample requirements. A filtered sample can fall below its floor even when the broader guide is published; the missing number does not mean a zero win rate.",
    related: ["sample-size", "likely-range"],
    category: "statistics",
    help: { slug: "reading-guide-stats", anchor: "publishing-floors" },
  },
  {
    id: "trend-arrow",
    term: "Trend arrow",
    short: "A guide's win-rate change from an earlier snapshot, with small moves treated as flat.",
    long: "Changes are measured in percentage points using a sufficiently old comparison snapshot. New means no suitable earlier comparison is available. An arrow describes the recorded sample, rather than predicting your next result.",
    related: ["likely-range", "sample-size"],
    category: "statistics",
    help: { slug: "reading-guide-stats", anchor: "trends" },
  },
  {
    id: "session",
    term: "Session",
    short: "A continuous run of games with no gap longer than your selected inactivity threshold.",
    long: "An exact gap stays connected, and undecided games can bridge wins and losses. Auto is 240 minutes with an overlay token and 90 minutes otherwise; set 15–480 minutes in Profile. Each view keeps its existing game/filter scope.",
    related: [],
    category: "statistics",
    help: { slug: "sessions", anchor: "definition" },
  },
  {
    id: "pulse-id",
    term: "Pulse ID",
    short: "A player's ID on SC2Pulse, the public ladder site. It stays the same when they change their name.",
    long: "It brings their current MMR, league and linked accounts. Until it's found, SC2 Tools shows the player's toon instead.",
    related: ["toon", "group-same-player"],
    category: "opponents",
    help: { slug: "opponents", anchor: "pulse-id" },
  },
  {
    id: "toon",
    term: "Toon",
    short: "The account ID inside a replay, such as 1-S2-1-267727: region, realm and account number.",
    long: "Every replay has one, so it identifies an opponent even before their Pulse ID is known.",
    related: ["pulse-id"],
    category: "opponents",
    help: { slug: "opponents", anchor: "pulse-id" },
  },
  {
    id: "net-mmr",
    term: "Net MMR",
    short: "The MMR you gained or lost against an opponent in total, from verified pairs of ranked games.",
    related: ["verified-pairs", "mmr-impact"],
    category: "mmr",
    help: { slug: "opponents", anchor: "net-mmr" },
  },
  {
    id: "verified-pairs",
    term: "Verified pairs",
    short: "Two ranked 1v1 games in a row on the same account and race. The MMR change of the first game is the start MMR of the second minus its own.",
    long: "Pairs with a change bigger than 150 MMR are left out, because something happened in between that the replays don't show.",
    related: ["net-mmr", "mmr-impact"],
    category: "mmr",
    help: { slug: "opponents", anchor: "net-mmr" },
  },
  {
    id: "mmr-impact",
    term: "MMR impact",
    short: "Which opponents you've won the most MMR from, and lost the most MMR to, counted from verified pairs.",
    related: ["net-mmr", "verified-pairs"],
    category: "mmr",
    help: { slug: "opponents", anchor: "mmr-impact" },
  },
  {
    id: "group-same-player",
    term: "Group same player",
    short: "Merges accounts that SC2Pulse links to the same player, or that are confirmed as the same person, into one row.",
    related: ["pulse-id", "barcode"],
    category: "opponents",
    help: { slug: "opponents", anchor: "group-same-player" },
  },
  {
    id: "barcode",
    term: "Barcode",
    short: "A name made only of look-alike characters, such as IIlIlI, used to hide who's playing.",
    long: "When the player behind it is known, from SC2Pulse or an identity confirmed by our team, their real name shows next to it.",
    related: ["group-same-player", "pulse-id"],
    category: "opponents",
    help: { slug: "opponent-dossier", anchor: "barcode" },
  },
  {
    id: "spending-quotient",
    term: "Spending Quotient",
    short: "Spending relative to income, measured from recorded resource samples.",
    long: "Uses arithmetic sample means from 1:00 onward, with each minerals-plus-gas bank floored to 50 before averaging. Fewer than five eligible samples or nonpositive mean income gives a neutral fallback of 75. SQ is not bounded to 0–100. Its Pro, Master, Diamond and Platinum pace labels are not your actual ladder rank.",
    formula: "SQ = 35 × (0.00137 × mean income − ln(mean bank)) + 240; ln is the natural logarithm.",
    related: ["macro-score", "supply-blocked", "float-spikes"],
    category: "macro",
    help: { slug: "macro", anchor: "macro-score" },
  },
  {
    id: "macro-score",
    term: "Macro score",
    short: "A spending-based score reduced by recorded macro penalties.",
    long: "The spending base is clamped before supply, race-mechanic and mineral-float penalties are subtracted. The final score is rounded and limited to 0–100. Insufficient engine samples can produce fallback SQ 75 and a base of 70; a missing frontend measurement instead remains unavailable. Penalty points and estimated mineral costs are different quantities.",
    formula: "Base = clamp(SQ − 5, 0, 100); score = clamp(round(base − supply penalty − race penalty − float penalty), 0, 100).",
    related: ["spending-quotient", "mechanic-efficiency", "float-spikes"],
    category: "macro",
    help: { slug: "macro", anchor: "macro-score" },
  },
  {
    id: "supply-blocked",
    term: "Supply blocked",
    short: "Estimated time spent near the supply limit, below 200 supply.",
    long: "A sample qualifies when used supply is at least capacity minus one and below 200. It credits the nonnegative gap to the next sample, capped at four seconds; a final qualifying sample uses four seconds. This is sampled near-cap time, not proof of continuous production downtime, and it includes early-game samples.",
    formula: "Blocked seconds = sum of min(max(next-sample gap, 0), 4) for qualifying samples; terminal gap defaults to 4 seconds.",
    related: ["macro-score", "sample-size"],
    category: "macro",
    help: { slug: "macro", anchor: "macro-score" },
  },
  {
    id: "float-spikes",
    term: "Float spikes",
    short: "Samples showing more than 800 banked minerals from 4:00 onward.",
    long: "Counts individual mineral samples, not separate episodes, duration or a minerals-plus-gas bank. Exactly 800 minerals does not qualify. Zero qualifying samples does not prove there was no earlier or smaller bank, and absent resource telemetry is not proof of efficient spending.",
    formula: "Count samples with time ≥ 240 seconds and minerals > 800.",
    related: ["macro-score", "spending-quotient"],
    category: "macro",
    help: { slug: "macro", anchor: "macro-score" },
  },
  {
    id: "mechanic-efficiency",
    term: "Mechanic efficiency",
    short: "Recorded race-mechanic casts compared with an uptime-based estimate.",
    long: "Expected casts use combined caster or base uptime and a mechanic-specific period, with initial free casts where applicable. No positive recorded uptime gives zero expected casts. The displayed percentage uses expected casts; score penalties instead allow grace cycles. A missing count can display a dash while percentage arithmetic uses zero for missing actual casts. No percentage is shown when expected casts are not positive.",
    formula: "Displayed percentage = clamp(actual / expected, 0, 1) × 100 when expected > 0. No mechanic penalty when expected ≤ grace; otherwise target = expected − grace, with full penalty at 50% of target or less, tapering to zero at 100%.",
    related: ["injects", "chrono-boost", "mules"],
    category: "macro",
    help: { slug: "game-page", anchor: "macro" },
  },
  {
    id: "injects",
    term: "Injects",
    short: "Recorded Inject Larva casts versus estimated hatchery opportunities.",
    long: "Expected opportunities use combined Hatchery, Lair and Hive uptime, not Queen energy or actual availability. Four grace cycles are allowed for the score penalty. Tagged casts are preferred, with legacy event names used when that count is zero.",
    formula: "Expected injects = floor(combined hatchery alive seconds / 29); penalty grace = 4 cycles.",
    related: ["mechanic-efficiency", "creep-tumors"],
    category: "macro",
    help: { slug: "game-page", anchor: "macro" },
  },
  {
    id: "chrono-boost",
    term: "Chrono Boost",
    short: "Recorded Chrono Boost casts versus estimated Nexus opportunities.",
    long: "The 89-second period estimates sustained energy availability; it is not the buff's duration. Each Nexus adds one initial free cast, and two grace cycles are allowed for the score penalty. The estimate does not prove a useful target was available throughout that uptime.",
    formula: "With positive combined Nexus uptime: expected = floor(alive seconds / 89) + Nexus count; otherwise expected = 0. Penalty grace = 2 cycles.",
    related: ["mechanic-efficiency", "macro-score"],
    category: "macro",
    help: { slug: "game-page", anchor: "macro" },
  },
  {
    id: "mules",
    term: "MULEs",
    short: "Recorded MULE casts versus estimated Orbital opportunities.",
    long: "Each Orbital adds one initial free cast, with two grace cycles for the score penalty. Other Orbital energy spending, such as scans, is not counted as a MULE cast; the estimate is an opportunity baseline rather than a complete account of useful energy spending.",
    formula: "With positive combined Orbital uptime: expected = floor(alive seconds / 64) + Orbital count; otherwise expected = 0. Penalty grace = 2 cycles.",
    related: ["mechanic-efficiency", "macro-score"],
    category: "macro",
    help: { slug: "game-page", anchor: "macro" },
  },
  {
    id: "creep-tumors",
    term: "Creep tumors",
    short: "Recorded tumors planted by Queens and existing tumors.",
    long: "The total adds Queen-planted and spread tumors. Lost tumors have a recorded death time; the first-tumor time is the earliest observed construction time. These counts are informational and do not reduce the macro score. Older extraction with no field is different from a measured empty list or zero.",
    formula: "Tumors planted = Queen-planted count + spread count.",
    related: ["injects", "macro-score"],
    category: "macro",
    help: { slug: "game-page", anchor: "macro" },
  },
  {
    id: "apm",
    term: "APM",
    short: "Recorded actions per minute, using SC2's replay average when available.",
    long: "Trusted curves require version 2 or later. Current syncs prefer the replay-reported average, otherwise using command, selection and control-group events until departure or game end; camera moves do not count. A missing, old or zero trusted average is unavailable. Use Recompute or Re-sync with a current desktop app to add supported telemetry, and use the Match timeline's APM view for pace over time. Higher APM alone does not establish better play.",
    formula: "Event fallback = counted actions / observed minutes; reported-average curves retain the replay's average.",
    related: ["spm", "sample-size", "macro-score"],
    category: "macro",
    help: { slug: "game-page", anchor: "macro" },
  },
  {
    id: "spm",
    term: "SPM",
    short: "Recorded selection events per minute.",
    long: "The timeline derives SPM from duration-weighted selection and action rates, scaled by the trusted average APM. Missing average, samples or selection telemetry, or zero action weight, leaves it unavailable. A measured zero selection rate can still be zero; it is not the same as missing telemetry.",
    formula: "Average SPM = average APM × sum(selection rate × sample duration) / sum(action rate × sample duration).",
    related: ["apm", "measured-average"],
    category: "macro",
    help: { slug: "game-page", anchor: "macro" },
  },
  {
    id: "opponent-win-rate",
    term: "Opponent win rate",
    short: "Your wins divided by decided games against this opponent.",
    long: "Only recorded wins and losses form this denominator. The Games column can also include undecided results, and grouped accounts recompute the rate from summed wins and losses. With no decided results the current table uses 0%; that does not mean those games were losses.",
    formula: "Win rate = wins / (wins + losses) × 100; no decided results displays 0%.",
    related: ["sample-size", "build-stats-win-rate"],
    category: "opponents",
    help: { slug: "opponents", anchor: "columns" },
  },
  {
    id: "last-mmr",
    term: "Last MMR",
    short: "The latest known opponent rating, preferring their most recently played race.",
    long: "Uses the newest suitable same-race rating, with stored opponent or current-rating fallbacks when needed. It is not universally replay-time rating evidence, and it cannot fill gaps in strength-adjusted comparisons that require replay-sourced MMR. Its saved-history scope can differ from the current filters.",
    related: ["pulse-id", "vs-expected"],
    category: "mmr",
    help: { slug: "opponents", anchor: "columns" },
  },
  {
    id: "mmr-won",
    term: "MMR won",
    short: "Positive measured MMR changes against this opponent, added together.",
    long: "Uses the same verified ranked-game pairs as Net MMR. It is rating gained, not the number of wins; games without usable pairs do not supply a measured change.",
    formula: "MMR won = sum of positive verified-pair changes.",
    related: ["net-mmr", "verified-pairs", "mmr-lost"],
    category: "mmr",
    help: { slug: "opponents", anchor: "net-mmr" },
  },
  {
    id: "mmr-lost",
    term: "MMR lost",
    short: "The size of negative measured MMR changes against this opponent, added together.",
    long: "Displayed as a positive loss total using verified ranked-game pairs. It is not the number of losses, and missing pair coverage is not proof that no rating was lost.",
    formula: "MMR lost = sum of the absolute values of negative verified-pair changes.",
    related: ["net-mmr", "verified-pairs", "mmr-won"],
    category: "mmr",
    help: { slug: "opponents", anchor: "net-mmr" },
  },
  {
    id: "measured-average",
    term: "Measured average",
    short: "The sum of valid recorded values divided by their measured count.",
    long: "Valid zeros are included; missing and invalid measurements are left out. No usable measurements leaves the average unavailable. Groups combine sums and measured counts rather than averaging their averages, so a small account does not get the same weight as a much larger one.",
    formula: "Measured average = sum of valid values / measured count, when the count is positive.",
    related: ["sample-size", "median"],
    category: "statistics",
    help: { slug: "opponents", anchor: "columns" },
  },
  {
    id: "latest-known-order",
    term: "Latest known build order",
    short: "The newest indexed game known to have contained an opponent build order.",
    long: "Indexed coverage can be incomplete. A known entry records that the game contained an order; it does not prove its current replay data is available. Missing indexing is not evidence that an opponent never had a recorded order. The date is the game's date, not its download or analysis date.",
    related: ["sample-size", "planned-build"],
    category: "opponents",
    help: { slug: "opponents", anchor: "columns" },
  },
  {
    id: "sample-size",
    term: "Sample size, n",
    short: "The number of usable observations behind this measurement.",
    long: "Counts belong to their metric and cohort, so overall Games and a measured APM or timing count can differ. Your usual uses at most 50 earlier ranked 1v1 games in the same concrete matchup. Private timing and league reference thresholds are separate rules, not a universal minimum sample size. A small sample can show an extreme result.",
    related: ["measured-average", "middle-half", "wilson-interval"],
    category: "statistics",
    help: { slug: "benchmarks", anchor: "your-usual" },
  },
  {
    id: "median",
    term: "Median",
    short: "The middle of a recorded distribution, used to describe a typical result.",
    long: "Timing summaries can interpolate between sorted observations, personal context uses approximate percentiles, and Explorer can weight observations equally per player. These are different methods and cohorts; a displayed median is not necessarily an exact middle replay or the arithmetic average.",
    formula: "Median = the 50th percentile of the selected distribution.",
    related: ["middle-half", "measured-average", "sample-size"],
    category: "statistics",
    help: { slug: "benchmarks", anchor: "your-usual" },
  },
  {
    id: "middle-half",
    term: "Middle half, p25–p75",
    short: "The range containing the middle half of the recorded distribution.",
    long: "This describes spread, not a confidence interval or a promised target. Private execution milestones require at least three usable observations before showing a median, range or delta. Natural loss-analysis comparisons separately require five; other contexts can use different eligibility and weighting.",
    formula: "Middle half = [25th percentile, 75th percentile].",
    related: ["median", "percentile", "sample-size"],
    category: "statistics",
    help: { slug: "build-check-in", anchor: "grading-a-game" },
  },
  {
    id: "percentile",
    term: "Percentile",
    short: "Where a value sits within the selected recorded distribution.",
    long: "League comparisons require at least 50 measurements for the metric and a valid ordered decile table. The display interpolates between the 10th and 90th percentiles, labels the tails, and uses a midpoint for tied quantiles. The bracket is the opponent's recorded league, not your current rank. Longer games or higher action counts are not automatically better.",
    related: ["median", "middle-half", "sample-size"],
    category: "statistics",
    help: { slug: "benchmarks", anchor: "league-band" },
  },
  {
    id: "wilson-interval",
    term: "95% Wilson interval",
    short: "A sample-size-based uncertainty range around the displayed win rate.",
    long: "Uses the displayed raw cohort's trials; rated comparisons have their own rated-game denominator. Invalid wins or trial counts, or zero trials, leave the interval unavailable. This range describes uncertainty in recorded evidence and is not a next-game forecast or proof that a build caused a result.",
    formula: "p = wins/n; z = 1.96; d = 1 + z²/n; center = (p + z²/(2n))/d; margin = z × sqrt(p(1−p)/n + z²/(4n²))/d; endpoints = clamp(center ± margin, 0, 1), rounded to four decimal places.",
    related: ["sample-size", "vs-expected", "opponent-win-rate"],
    category: "statistics",
    help: { slug: "vs-expected", anchor: "uncertainty" },
  },
  {
    id: "vs-expected",
    term: "Vs expected",
    short: "Rated wins minus expected wins, given the opponents you played.",
    long: "Both totals use the same eligible ranked 1v1 games with a decided result, recognized races and replay-sourced integer MMR from 500 to 9999 for both players. Hidden, deleted, pending and resumed contributions are excluded. Current Pulse ratings do not fill missing replay evidence. A validated calibrated model or Elo fallback describes past opposition; no rated sample leaves the comparison unavailable. It is not a next-game forecast or a causal build benefit.",
    formula: "Vs expected = rated wins − sum(expected win chances for those same rated games).",
    related: ["performance-rating", "wilson-interval", "last-mmr"],
    category: "statistics",
    help: { slug: "vs-expected", anchor: "example" },
  },
  {
    id: "performance-rating",
    term: "Performance rating",
    short: "The rating that matches your recorded rated win fraction under the same baseline.",
    long: "The baseline is inverted against the average rated opponent. All-win and all-loss samples have no finite displayed performance rating, and invalid counts or opponent averages leave it unavailable. A flat fitted interval uses its midpoint; finite results are not artificially capped to a ladder range. It is not a new ladder rank or a prediction of future results.",
    formula: "Performance rating = average opponent MMR − inverse baseline(rated wins / rated games).",
    related: ["vs-expected", "sample-size"],
    category: "statistics",
    help: { slug: "vs-expected", anchor: "rating" },
  },
  {
    id: "trade-ratio",
    term: "Trade ratio",
    short: "Their priced resource losses divided by yours in the recorded fight.",
    long: "Minerals and gas have equal price weight. Above 1.25 is labelled won, below 0.8 lost, and the endpoints or middle even. Zero own loss has no numeric ratio; both zero or unknown prices leave the result unknown. Exact clusters chain deaths at gaps of at most 10 seconds, so their span is not the engagement's duration. Only an absent casualty ledger permits bracketed measured army-value-drop estimates with gaps of at most 30 seconds; an explicitly empty ledger does not fabricate a fight. This is resource exchange, not win probability or proof of causation.",
    formula: "Trade ratio = opponent priced mineral-plus-gas losses / your priced mineral-plus-gas losses, with a positive denominator.",
    related: ["sample-size", "measured-average"],
    category: "statistics",
    help: { slug: "game-page", anchor: "game-story" },
  },
  {
    id: "planned-build",
    term: "Planned",
    short: "Your build label comes from an applied, confirmed check-in.",
    long: "The marker remains even when the detector agrees with the chosen build. Its explanation names the detected label or its absence, so an intended plan is not confused with replay evidence. Private owner views can apply this label; public build aggregates use their detector-only scope.",
    related: ["counted-checkins", "corrected-build", "build-record"],
    category: "builds",
    help: { slug: "build-check-in", anchor: "change-build" },
  },
  {
    id: "corrected-build",
    term: "Corrected",
    short: "The opponent's build label comes from your saved correction.",
    long: "Requires an applied correction. Otherwise the detected or available fallback label remains. A correction changes the label used by the relevant private view; it is not additional detector evidence.",
    related: ["planned-build", "build-record"],
    category: "builds",
    help: { slug: "build-check-in" },
  },
  {
    id: "counted-checkins",
    term: "Counted check-ins",
    short: "Games assigned here only because a check-in changed their detected build identity.",
    long: "The count needs an active, confirmed and applied override whose build name or custom-build slug differs from the detected identity. It does not count every confirmed plan. A zero or missing count leaves the note out.",
    related: ["planned-build", "build-record"],
    category: "builds",
    help: { slug: "build-check-in" },
  },
  {
    id: "build-record",
    term: "Build W–L",
    short: "Recorded wins and losses for this build in the selected filters.",
    long: "Only decided wins and losses enter these two buckets; tied and unknown results enter neither. Private owner views can use effective confirmed check-ins, while detector-only views keep detected labels. Check the feature's scope before comparing records.",
    related: ["build-stats-win-rate", "planned-build", "counted-checkins"],
    category: "builds",
    help: { slug: "builds", anchor: "table" },
  },
  {
    id: "build-stats-win-rate",
    term: "Build stats WR",
    short: "Wins divided by all matching games recorded for this build.",
    long: "Unlike Opponents win rate, this denominator includes matching tied or unknown results. No matching records uses 0%. The displayed build identity and filters still determine which games belong to the sample.",
    formula: "Build stats win rate = wins / all matching records × 100; no matching records displays 0%.",
    related: ["build-record", "opponent-win-rate", "sample-size"],
    category: "builds",
    help: { slug: "builds", anchor: "table" },
  },
  {
    id: "overlay-session",
    term: "Session record",
    short: "Your recorded wins and losses in the latest stretch of play.",
    long: "The recorded session splits at gaps greater than your selected inactivity threshold and becomes empty after that threshold since your latest game. Auto uses 240 minutes with any stored overlay token and 90 minutes otherwise; a saved 15–480 minute preference wins. It searches recent candidates within 14 days and respects a manual reset anchor. Decided results can span regions; tied or unknown results can bridge games without adding wins or losses. Midnight does not reset it.",
    related: ["title-token", "build-record"],
    category: "overlay",
    help: { slug: "desktop-stream-titles", anchor: "tokens" },
  },
  {
    id: "title-token",
    term: "Title token",
    short: "A placeholder that inserts a synced statistic into your stream title.",
    long: "This means a title placeholder, not a secret overlay Browser Source credential. Missing data removes its whole pipe-separated segment. Desktop templates allow up to 500 characters; rendered titles are limited to 70 by dropping trailing segments, with an error if the sole remaining segment is too long.",
    related: ["overlay-session", "sample-size"],
    category: "overlay",
    help: { slug: "desktop-stream-titles", anchor: "tokens" },
  },
  {
    id: "best-answer",
    term: "Best answer",
    short: "Your build with the most recorded wins against their favourite opening.",
    long: "Candidates need at least three matching records and sort by wins first, then total games. The displayed rate is wins divided by all matching records. This is not the build with the highest win rate. Without a suitable strategy or candidate the widget stays hidden.",
    related: ["build-stats-win-rate", "sample-size"],
    category: "overlay",
    help: { slug: "opponent-scouting" },
  },
];

const BY_ID: ReadonlyMap<string, GlossaryTerm> = new Map(GLOSSARY.map((term) => [term.id, term]));

/**
 * The term with this id, if any.
 *
 * Example: `glossaryTerm("net-mmr")?.term` → "Net MMR".
 */
export function glossaryTerm(id: string): GlossaryTerm | undefined {
  return BY_ID.get(id);
}

/**
 * Public URL of the help section that explains a term.
 *
 * Example: `glossaryHelpPath(glossaryTerm("net-mmr")!)` → "/help/opponents#net-mmr".
 */
export function glossaryHelpPath(term: GlossaryTerm): string {
  const article = `/help/${term.help.slug}`;
  return term.help.anchor ? `${article}#${term.help.anchor}` : article;
}
