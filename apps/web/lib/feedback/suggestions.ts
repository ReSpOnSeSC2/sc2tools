import { searchHelp } from "@/lib/help/search";
import type { HelpArticle } from "@/lib/help/types";

/** How many articles "These might help" shows. */
export const SUGGESTION_LIMIT = 3;
/**
 * Lowest search score worth suggesting. Below it a match is one shared
 * word ("chart", "add"), which reads as noise next to a report; a title
 * or keyword hit on the main words scores well above it.
 */
export const MIN_SUGGESTION_SCORE = 5;
const MIN_QUERY_CHARS = 3;

/**
 * Help articles that might answer a report before it is sent, from the
 * subject the player is typing. Same in-browser index as the help search.
 *
 * Example: `reportHelpSuggestions("overlay not showing in obs")[0].slug` → "troubleshooting-and-support".
 */
export function reportHelpSuggestions(subject: string): HelpArticle[] {
  const query = subject.trim();
  if (query.length < MIN_QUERY_CHARS) return [];
  return searchHelp(query, { limit: SUGGESTION_LIMIT })
    .filter((result) => result.score >= MIN_SUGGESTION_SCORE)
    .map((result) => result.article);
}
