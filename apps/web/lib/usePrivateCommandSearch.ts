"use client";

import {
  privateCommandChoices, privateCommandQuery, requestPrivateCommandSearch, type PrivateCommandSearchResponse,
} from "./privateCommandSearch";
import {
  useOwnerCommandSearch, type OwnerCommandSearchAdapter, type PrivateCommandSearchOptions, type PrivateCommandSelectionDraft,
} from "./useOwnerCommandSearch";

export type { PrivateCommandSearchOptions, PrivateCommandSelectionDraft };

const PRIVATE_SEARCH: OwnerCommandSearchAdapter<PrivateCommandSearchResponse> = Object.freeze({
  query: privateCommandQuery, request: requestPrivateCommandSearch, choices: privateCommandChoices,
  slow: "Private search took too long. Try again.", failed: "Private search is unavailable. Try again.",
});

/** Ephemeral, intent-only private search: the owner's opponents, saved builds
 * and maps groups through POST /v1/search/quick. */
export function usePrivateCommandSearch(options: PrivateCommandSearchOptions) {
  return useOwnerCommandSearch(options, PRIVATE_SEARCH);
}
