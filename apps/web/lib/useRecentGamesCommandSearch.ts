"use client";

import {
  recentGameChoices, recentGamesQuery, requestRecentGames, type RecentGamesResponse,
} from "./recentGamesCommandSearch";
import { useOwnerCommandSearch, type OwnerCommandSearchAdapter, type PrivateCommandSearchOptions } from "./useOwnerCommandSearch";

const RECENT_GAMES: OwnerCommandSearchAdapter<RecentGamesResponse> = Object.freeze({
  query: recentGamesQuery, request: requestRecentGames, choices: recentGameChoices,
  slow: "Recent games took too long. Try again.", failed: "Recent games are unavailable. Try again.",
});

/** Ephemeral, intent-only search of the owner's latest games through the
 * replay library, independent of the private POST: its own debounce, abort,
 * failure and Retry. Example: useRecentGamesCommandSearch(paletteOptions). */
export function useRecentGamesCommandSearch(options: PrivateCommandSearchOptions) {
  return useOwnerCommandSearch(options, RECENT_GAMES);
}
