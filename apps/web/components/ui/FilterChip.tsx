import Link from "next/link";
import { X } from "lucide-react";

/** Link version of the analyzer's removable filter chip; works without JS. */
export function FilterChip({ href, label }: { href: string; label: string }) {
  return <Link href={href} aria-label={`Remove filter: ${label}`} className="inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 pl-3 pr-2 text-caption text-text transition-colors hover:border-accent hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg sm:min-h-8">
    <span className="min-w-0 break-words font-semibold">{label}</span><X className="h-3.5 w-3.5 flex-none" aria-hidden />
  </Link>;
}
