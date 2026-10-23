import type { HelpArticle } from "@/lib/help/types";
import { GUIDE_CELL_MIN_GAMES, GUIDE_CELL_MIN_USERS, GUIDE_PAGE_MIN_GAMES, GUIDE_CONFIDENCE_PERCENT, GUIDE_TREND_BASELINE_DAYS } from "@/lib/guides/guideCopy";
import { GUIDE_TREND_FLAT_THRESHOLD } from "@/lib/guides/format";

const article: HelpArticle = {
  slug: "reading-guide-stats", title: "Build guides: reading the stats",
  summary: "Read win rates, likely ranges, verdict symbols and trends, and understand why some guide numbers stay hidden.",
  category: "builds", audience: "all", keywords: ["confidence", "likely range", "sample", "publishing floor", "win rate", "trend", "glyph", "guides"], updated: "2026-10-23",
  body: [
    { type: "paragraph", text: "[Build guides](/guides) count ranked 1v1 games uploaded to SC2 Tools. Every number and explanation uses fixed rules and recorded results, with no AI. The guide describes these players' games, rather than promising your next result." },
    { type: "heading", text: "Why some numbers are hidden", anchor: "publishing-floors" },
    { type: "paragraph", text: `A cell needs at least ${GUIDE_CELL_MIN_GAMES} games from ${GUIDE_CELL_MIN_USERS} players. A full guide needs ${GUIDE_PAGE_MIN_GAMES} games. Below these publishing floors, you see **Not enough games** instead of an unreliable number. A missing army snapshot means too few games reached that time.` },
    { type: "heading", text: "Win rate and likely range", anchor: "likely-range" },
    { type: "paragraph", text: `The win rate is the share of recorded games won. The likely range shows uncertainty: we're ${GUIDE_CONFIDENCE_PERCENT}% sure the true win rate is inside it. Fewer games make the range wider. Openers are ranked by the **low end** of this range, so a few lucky games cannot top the table.` },
    { type: "table", head: ["Symbol", "Meaning"], rows: [["▲ ahead · green", "The whole likely range is above 50%."], ["● even · hatched chart bar", "Too close to call: the likely range crosses 50%."], ["▼ behind · red", "The whole likely range is below 50%."]] },
    { type: "paragraph", text: "Symbols and accessible labels carry the same meaning as colour. On map guides, read each row race against the column race. Mirror cells show only games and **mirror**, because a mirror win rate does not favor either race." },
    { type: "heading", text: "Trends and updates", anchor: "trends" },
    { type: "paragraph", text: `Trend arrows compare the current win rate with a snapshot at least ${GUIDE_TREND_BASELINE_DAYS} days old. Moves under ${GUIDE_TREND_FLAT_THRESHOLD * 100} percentage points count as flat. **New** means there is no suitable earlier comparison. Guides update nightly; the last update is printed on the page.` },
    { type: "heading", text: "Compare the right opponents", anchor: "filtering" },
    { type: "paragraph", text: "Choose an opponent league or MMR band before comparing openers. The table summary states which opponents it counts. See [Build guides: filtering](/help/build-guides#opponent-filters) for the controls and ways to clear them." },
    { type: "paragraph", text: "The **8-worker patch** is an archive with different opening timings. Its videos stay collapsed below current 12-worker guides. Keep the era in mind when comparing numbers or practicing a build." },
    { type: "heading", text: "Practice what you found", anchor: "practice" },
    { type: "paragraph", text: "Use **Practice it on stream** on a build guide to load its targets in Ghost Build. [Practice Ghost Build](/help/practice-ghost-build) explains the stream setup. Use the guide's section links to save or share the timings, army or matchups you want to revisit." },
  ], related: ["build-guides", "practice-ghost-build", "rules-explained"],
};
export default article;
