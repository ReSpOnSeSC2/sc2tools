import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { guidesEnabled } from "@/lib/guides/flags";
import { getInstantImportMode } from "@/lib/instant/flag";
import { reviewsRollout } from "@/lib/reviews";
import { pageMetadata } from "@/lib/seo/pageMetadata";
import { toolsCatalog } from "@/lib/tools/catalog";

const DESCRIPTION = "Find StarCraft II tools for replay analysis, ladder balance, practice, match rooms, and streaming.";

export const dynamic = "force-static";
export const metadata = pageMetadata({ title: "Tools and features", description: DESCRIPTION, canonical: "/tools" });

export default function ToolsPage() {
  const sections = toolsCatalog({
    browser: getInstantImportMode() === "all",
    guides: guidesEnabled(),
    reviews: reviewsRollout() === "on",
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8 pb-8">
      <h1 className="font-display text-display-lg font-bold leading-tight text-text">Explore SC2 Tools</h1>
      {sections.map(({ id, title, tools }) => (
        <section key={id} className="space-y-3" aria-labelledby={id}>
          <h2 id={id} className="font-display text-h2 font-bold text-text">{title}</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tools.map(tool => {
              const linkId = `tool-${tool.href.slice(1).replace(/[^a-z0-9]+/g, "-")}`;
              return (
                <li key={tool.href}>
                  <Link
                    href={tool.href}
                    prefetch={false}
                    aria-labelledby={linkId}
                    aria-describedby={`${linkId}-description`}
                    className="group block h-full min-h-11 space-y-1 rounded-xl border border-line bg-bg-surface p-4 hover:bg-bg-elevated focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span id={linkId} className="font-display text-h3 font-bold text-text group-hover:text-accent">{tool.title}</span>
                      <ArrowRight className="mt-1 size-4 shrink-0 text-accent" aria-hidden />
                    </span>
                    <p id={`${linkId}-description`} className="text-body text-text-muted">{tool.description}</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
