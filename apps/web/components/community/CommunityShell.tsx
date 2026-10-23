import Link from "next/link";
import type { ReactNode } from "react";

/** Community sections are separate routes and retain normal link behavior. */
export function CommunityShell({ active, buildCount, children }: { active: "builds" | "leaderboard"; buildCount?: number; children: ReactNode }) {
  return <div className="space-y-4">
    <nav aria-label="Community sections" className="flex flex-wrap gap-4 border-b border-border">
      {([{ id: "builds", href: "/community", label: `Builds${buildCount === undefined ? "" : ` · ${buildCount}`}` }, { id: "leaderboard", href: "/community/leaderboard", label: "Stock Market leaderboard" }] as const).map((item) => <Link key={item.id} href={item.href} aria-current={active === item.id ? "page" : undefined} className={`inline-flex min-h-11 items-center border-b-2 px-1 text-caption font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${active === item.id ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text"}`}>{item.label}</Link>)}
    </nav>
    {children}
  </div>;
}
