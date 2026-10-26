import Link from "next/link";

export type PlayerSection = "overview" | "builds" | "replays" | "reviews";

/** Public capability links only: omitted sections do not advertise private data. */
export function PlayerSectionNav({ handle, active, sections }: { handle: string; active: PlayerSection; sections: PlayerSection[] }) {
  const root = `/players/${encodeURIComponent(handle)}`;
  const href = (section: PlayerSection) => section === "overview" ? root : section === "replays" ? `${root}/replays` : `${root}?tab=${section}`;
  return <nav aria-label="Player sections" className="flex flex-wrap gap-2 border-b border-border pb-3">
    {sections.map(section => <Link key={section} href={href(section)} aria-current={active === section ? "page" : undefined}
      className={`inline-flex min-h-11 items-center rounded-full border px-4 text-caption font-semibold capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active === section ? "border-accent bg-accent/10 text-accent" : "border-border text-text-muted hover:bg-bg-elevated"}`}>{section}</Link>)}
  </nav>;
}
