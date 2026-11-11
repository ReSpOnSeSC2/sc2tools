// Pure slide builder for the Season Recap. Turns a SeasonRecapResult
// into the ordered list of slides the modal renders. Kept separate
// from the React component so slide content is unit-testable and every
// null section is skipped rather than rendered as an empty slide.

import type { RecapWindow, SeasonRecapResult } from "@/lib/seasonRecap";

export interface RecapSlide {
  key: string;
  eyebrow?: string;
  /** Large hero number/word (optional). */
  big?: string;
  headline: string;
  sub?: string;
}

function hoursLabel(hours: number | null): string | null {
  if (hours === null) return null;
  if (hours < 1) return `${Math.round(hours * 60)} minutes on the ladder`;
  return `${hours.toFixed(1)} hours on the ladder`;
}

interface YearSlides {
  year: number;
  busiestMonth: { month: string; games: number } | null;
}

function yearDetailSlides(recap: SeasonRecapResult, year: YearSlides): RecapSlide[] {
  const slides: RecapSlide[] = [];
  const hours = hoursLabel(recap.totals.hoursPlayed);
  if (hours) slides.push({ key: "hours", eyebrow: "Time played", headline: hours });
  if (year.busiestMonth) {
    const { month, games } = year.busiestMonth;
    slides.push({ key: "month", eyebrow: "Busiest month", headline: month, sub: `${games} ladder ${games === 1 ? "game" : "games"}` });
  }
  return slides;
}

export function buildRecapSlides(
  recap: SeasonRecapResult,
  window: Pick<RecapWindow, "label">,
  year?: YearSlides,
): RecapSlide[] {
  const slides: RecapSlide[] = [];

  // 1. Intro.
  slides.push({
    key: "intro",
    eyebrow: window.label,
    headline: year ? `Your ${year.year} in StarCraft II` : "Your season, wrapped",
    sub: year ? "A recap of the ladder games you selected. The last slide has your share card."
      : "Here's how your ladder journey went. Swipe through — the last slide is yours to share.",
  });

  // 2. Totals.
  const { totals } = recap;
  const wr = totals.winrate !== null ? `${Math.round(totals.winrate * 100)}%` : null;
  slides.push({
    key: "totals",
    eyebrow: "By the numbers",
    big: String(totals.games),
    headline: `games played · ${totals.wins}-${totals.losses}`,
    sub: [wr ? `${wr} win rate` : null, year ? null : hoursLabel(totals.hoursPlayed)]
      .filter(Boolean)
      .join(" · ") || undefined,
  });
  if (year) slides.push(...yearDetailSlides(recap, year));

  // 3. One MMR journey per Battle.net account. Deltas must never be
  // sequenced or summed across independent regional ladders.
  for (const j of recap.mmrJourneys) {
    const climbed = j.delta >= 0;
    slides.push({
      key: `mmr:${j.toonHandle}${j.race ? `:${j.race}` : ""}`,
      eyebrow: `MMR journey · ${j.accountLabel}${j.race ? ` · ${j.race}` : ""}`,
      big: `${climbed ? "+" : ""}${j.delta}`,
      headline: climbed ? "MMR gained" : year ? `MMR in ${year.year}` : "MMR this season",
      sub: `From ${j.start} to ${j.end}, peaking at ${j.peak}.${year ? " Uses the rating recorded before each game." : ""}`,
    });
  }

  // 4. Signature opener.
  if (recap.topOpener) {
    const o = recap.topOpener;
    slides.push({
      key: "opener",
      eyebrow: "Signature opener",
      headline: o.name,
      sub: `${o.games} games · ${Math.round(o.winrate * 100)}% win rate. Your go-to ${year ? `in ${year.year}` : "this season"}.`,
    });
  }

  // 5. Nemesis.
  if (recap.nemesis) {
    const n = recap.nemesis;
    slides.push({
      key: "nemesis",
      eyebrow: "Your nemesis",
      headline: n.name,
      sub: `${n.record} against you. Some rivalries just run deep.`,
    });
  }

  // 6. Best victim.
  if (recap.bestVictim) {
    const v = recap.bestVictim;
    slides.push({
      key: "victim",
      eyebrow: "Favourite matchup",
      headline: v.name,
      sub: `You went ${v.record} against them. Free MMR.`,
    });
  }

  // 7. Biggest upset.
  if (recap.biggestUpset) {
    const u = recap.biggestUpset;
    slides.push({
      key: "upset",
      eyebrow: "Biggest upset",
      big: `+${u.mmrGap}`,
      headline: "MMR upset win",
      sub: `You beat someone ${u.mmrGap} MMR above you${
        u.opponentName ? ` (${u.opponentName})` : ""
      }${u.map ? ` on ${u.map}` : ""}.`,
    });
  }

  // 8. Longest streak.
  if (recap.longestWinStreak >= 3) {
    slides.push({
      key: "streak",
      eyebrow: "Hot streak",
      big: String(recap.longestWinStreak),
      headline: "wins in a row",
      sub: year ? `Your longest unbeaten run in ${year.year}.` : "Your longest unbeaten run this season.",
    });
  }

  // 9. Favourite map.
  if (recap.favoriteMap && recap.favoriteMap.games >= 3) {
    const m = recap.favoriteMap;
    slides.push({
      key: "map",
      eyebrow: "Most-played map",
      headline: m.name,
      sub: `${m.games} games · ${Math.round(m.winrate * 100)}% win rate.`,
    });
  }

  // Final share slide.
  slides.push({
    key: "share",
    eyebrow: year ? "Year in review" : "That's a wrap",
    headline: year ? "Share your year" : "Share your season",
    sub: year ? "Your card contains aggregate stats and a link to this tool."
      : "Post your recap card — link back included so friends can get theirs.",
  });

  return slides;
}
