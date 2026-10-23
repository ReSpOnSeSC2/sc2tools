"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { OpponentsTab } from "./OpponentsTab";
import { SectionHeader } from "./SectionHeader";

/**
 * Route wrapper: the section header, then the opponent list, with rows
 * navigating to real dossier URLs.
 */
export function OpponentsRoute() {
  const router = useRouter();
  const pathname = usePathname() || "/app/opponents";
  const params = useSearchParams();
  const query = params?.toString() || "";
  const location = useMemo(() => ({ pathname, query, replace: (href: string) => router.replace(href, { scroll: false }), prefetch: (href: string) => router.prefetch(href), navigate: (href: string) => router.push(href) }), [pathname, query, router]);
  const [count, setCount] = useState<number | null>(null);
  return (
    <div className="space-y-5">
      <SectionHeader tab="opponents" description="Everyone you've faced, keyed to their SC2Pulse ID" actions={count === null ? null : <span className="rounded-full border border-line px-2 py-1 text-caption tabular-nums">{count.toLocaleString()} results</span>} />
      <OpponentsTab
        location={location}
        onResultCount={setCount}
      />
    </div>
  );
}
