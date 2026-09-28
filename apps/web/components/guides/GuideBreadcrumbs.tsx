import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { GuideCrumb } from "@/components/guides/guideSeo";

/**
 * Visible breadcrumb trail (the JSON-LD twin comes from
 * `breadcrumbJsonLd`). The last crumb is the current page and is not a
 * link. Wraps on narrow screens instead of scrolling.
 */
export function GuideBreadcrumbs({ crumbs }: { crumbs: ReadonlyArray<GuideCrumb> }) {
  const lastIndex = crumbs.length - 1;
  return (
    <nav aria-label="Breadcrumb" className="text-caption text-text-muted">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((crumb, index) => (
          <li key={crumb.path} className="flex min-w-0 items-center gap-1">
            {index === lastIndex ? (
              <span aria-current="page" className="truncate font-semibold text-text">
                {crumb.name}
              </span>
            ) : (
              <>
                <Link
                  href={crumb.path}
                  className="rounded-sm hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {crumb.name}
                </Link>
                <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
              </>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
