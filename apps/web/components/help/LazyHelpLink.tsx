"use client";

import { lazy, Suspense } from "react";
import { CircleHelp } from "lucide-react";
import type { HelpLinkProps } from "./HelpLink";
import { HELP_ICON_LINK_CLASS, HELP_TEXT_LINK_CLASS } from "./HelpInline";

const HelpLink = lazy(() =>
  import("./HelpLink").then((module) => ({ default: module.HelpLink })),
);

/**
 * <HelpLink> for everything outside the help pages themselves.
 *
 * HelpLink reads the article registry, which carries every article's
 * text. Imported statically, that text ships in the first load of every
 * page that shows the link (lib/help/__tests__/helpLinkImports.test.ts
 * keeps it out). This loads it on first render instead; until then the
 * reader sees a plain link to the article page, so it works before the
 * chunk arrives and without JavaScript.
 *
 * The fallback cannot read the article's title: give inline links their
 * text as children.
 *
 * Tests that render a page with several of these at once load the chunk
 * first (components/help/__tests__/loadLazyHelpLink.tsx explains why).
 */
export function LazyHelpLink({ slug, anchor, children, variant = "inline", className = "", onOpen }: HelpLinkProps) {
  const href = anchor ? `/help/${slug}#${anchor}` : `/help/${slug}`;
  const fallback =
    variant === "icon" ? (
      <a href={href} onClick={onOpen} aria-label="Help" className={[HELP_ICON_LINK_CLASS, className].filter(Boolean).join(" ")}>
        <CircleHelp className="h-4 w-4" aria-hidden />
      </a>
    ) : (
      <a href={href} onClick={onOpen} className={[HELP_TEXT_LINK_CLASS, className].filter(Boolean).join(" ")}>
        {children ?? "Help"}
      </a>
    );
  return (
    <Suspense fallback={fallback}>
      <HelpLink slug={slug} anchor={anchor} variant={variant} className={className} onOpen={onOpen}>
        {children}
      </HelpLink>
    </Suspense>
  );
}
