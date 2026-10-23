import Link from "next/link";
import { Compass } from "lucide-react";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { GlowHalo } from "@/components/ui/GlowHalo";

/** Private and missing public pages deliberately share the same neutral explanation. */
export function PublicNotFound() {
  return <section className="relative overflow-hidden rounded-2xl border-2 border-line bg-bg-surface px-4 py-12 shadow-hard sm:px-6 sm:py-20"><GlowHalo color="cyan" position="top" opacity={0.85} size={70} /><div className="relative z-10"><EmptyStatePanel size="lg" icon={<Compass className="h-6 w-6" aria-hidden />} title={<h1 className="text-h3 font-bold text-text">This page is private or no longer shared</h1>} description="The player may have turned off their public profile or replay sharing, or the link is mistyped." action={<div className="flex flex-wrap justify-center gap-4">{[["/community", "Browse community builds"], ["/community/leaderboard", "Leaderboard"], ["/", "Get your own page"]].map(([href, label]) => <Link key={href} href={href} className="inline-flex min-h-11 items-center font-semibold text-accent underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">{label}</Link>)}</div>} /></div></section>;
}
