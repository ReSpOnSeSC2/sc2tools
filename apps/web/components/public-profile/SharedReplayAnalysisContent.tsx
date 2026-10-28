"use client";

import dynamic from "next/dynamic";
import type { PublicReplayDetailResponse } from "@/components/analyzer/replays/types";
import SharedReplayAnalysisLoading from "./SharedReplayAnalysisLoading";

// Keep SSR enabled. The page reaches this island only after its authoritative
// API result, notFound and canonical redirect decisions have completed.
const Analysis = dynamic(() => import("./PublicReplayAnalysis").then(module => module.PublicReplayAnalysis), {
  loading: () => <SharedReplayAnalysisLoading />,
});

export function SharedReplayAnalysisContent({ data, from }: { data: PublicReplayDetailResponse; from?: string }) {
  return <Analysis key={data.game.gameId} data={data} from={from} />;
}
