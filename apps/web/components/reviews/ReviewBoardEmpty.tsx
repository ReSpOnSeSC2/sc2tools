import Link from "next/link";
import { SignedIn } from "@clerk/nextjs";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { boardQuery, type BoardFilters } from "@/lib/reviews";
import { hasBoardFilters } from "./ActiveFilterChips";
import { AskAboutGameButton } from "./AskGamePicker";

export function ReviewBoardEmpty({ filters }: { filters: BoardFilters }) {
  const filtered = hasBoardFilters(filters);
  return <EmptyStatePanel title={filtered ? "No requests match these filters" : "No open requests yet"} description={filtered ? "Clear a filter to see more requests, or ask about your own game." : "Pick one of your 1v1 games and ask about the moment you want help with."} action={<div className="flex flex-wrap justify-center gap-3">{filtered ? <Link href={`/reviews${boardQuery({ sort: filters.sort, race: null, matchup: null, band: null, tag: null, unanswered: false })}`} className="inline-flex min-h-11 items-center font-semibold text-link underline">Clear filters</Link> : null}<SignedIn><AskAboutGameButton /></SignedIn></div>} />;
}
