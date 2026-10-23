import type { ReactNode } from "react";
import { SectionNav, type SectionNavItem } from "@/components/ui/SectionNav";

/** One mobile chip row becomes the reading page's right rail on large screens. */
export function GuideSectionNav({ items, children }: { items: readonly SectionNavItem[]; children: ReactNode }) {
  if (items.length < 3) return <div className="space-y-10">{children}</div>;
  return <div className="relative min-w-0 lg:grid lg:grid-cols-[minmax(0,1fr)_14rem] lg:items-start lg:gap-8"><SectionNav items={items} /><div className="min-w-0 space-y-10 pt-6 lg:col-start-1 lg:row-start-1 lg:pt-0">{children}</div></div>;
}
