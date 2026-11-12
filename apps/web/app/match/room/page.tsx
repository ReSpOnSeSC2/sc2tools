import type { Metadata } from "next";
import { MatchRoom } from "@/components/match/MatchRoom";

export const metadata: Metadata = {
  title: "Match Room",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RoomPage() {
  return <MatchRoom />;
}
