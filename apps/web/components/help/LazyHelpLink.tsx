"use client";

import { lazy, Suspense } from "react";
import type { HelpLinkProps } from "./HelpLink";
import { HELP_TEXT_LINK_CLASS } from "./HelpInline";

const HelpLink = lazy(() =>
  import("./HelpLink").then((module) => ({ default: module.HelpLink })),
);

/**
 * <HelpLink> for shared primitives (Card's EmptyState, RequestError,
 * SectionBoundary, the connection banner).
 *
 * HelpLink reads the article registry, which carries every article's
 * text. Imported statically from a primitive, that text would ship
 * with every page that renders a card. This loads it on first render
 * instead; until then the reader sees a plain link to the article page,
 * so it works before the chunk arrives and without JavaScript.
 *
 * Feature code that already links to help can keep importing HelpLink.
 */
export function LazyHelpLink({ slug, children, className = "" }: Pick<HelpLinkProps, "slug" | "children" | "className">) {
  return (
    <Suspense
      fallback={
        <a href={`/help/${slug}`} className={[HELP_TEXT_LINK_CLASS, className].filter(Boolean).join(" ")}>
          {children}
        </a>
      }
    >
      <HelpLink slug={slug} className={className}>
        {children}
      </HelpLink>
    </Suspense>
  );
}
