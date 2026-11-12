import { OPPONENT_FILTER_KEY } from "./opponentListQuery";

/** Section state never enters AnalyzerFilters or its API query serializer. */
export const SECTION_QUERY_KEYS = ["q", OPPONENT_FILTER_KEY, "result", "matchup", "sort", "cursor", "before", "impact", "notes", "review", "tag", "tab", "view", "drill", "focus"] as const;
