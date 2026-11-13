import type { Metadata } from "next";
import { MatchRoomObs } from "@/components/match/MatchRoomObs";
import { availableMapImages } from "@/lib/map-images";

const LADDER_TITLES = availableMapImages().filter(map => map.seasons.length > 0).map(map => map.displayName);

export const metadata: Metadata = {
  title: "Match Room OBS source",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MatchRoomObsPage() {
  return <MatchRoomObs ladderTitles={LADDER_TITLES} />;
}
