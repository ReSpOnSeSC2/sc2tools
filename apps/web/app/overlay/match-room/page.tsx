import type { Metadata } from "next";
import { MatchRoomObs } from "@/components/match/MatchRoomObs";

export const metadata: Metadata = {
  title: "Match Room OBS source",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MatchRoomObsPage() {
  return <MatchRoomObs />;
}
