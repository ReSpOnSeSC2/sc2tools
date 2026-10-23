import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { helpArticleSlugFromHref, parseHelpInline, type HelpInlineNode } from "@/lib/help/inline";
import { reviewsRollout } from "@/lib/reviews";

/**
 * Renders a help text field (the inline markup of lib/help/inline.ts)
 * as React elements. No HTML strings: text nodes stay text.
 *
 * Server-safe (no hooks). Event handlers are only attached when the
 * caller passes `onOpenArticle`, which only client surfaces do.
 */

export interface HelpLinkOptions {
  /** Where a link to another help article points (default: its public page). */
  articleHref?: (slug: string) => string;
  /** Open another article in place (Settings → Help) instead of navigating. */
  onOpenArticle?: (slug: string) => void;
}

export const HELP_TEXT_LINK_CLASS =
  "rounded-sm font-medium text-accent-cyan underline decoration-accent-cyan/40 underline-offset-2 hover:decoration-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** The round "?" button of `<HelpLink variant="icon">`. */
export const HELP_ICON_LINK_CLASS =
  "inline-flex h-8 w-8 items-center justify-center rounded-full text-text-dim hover:bg-bg-elevated hover:text-accent-cyan focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/** A click that should open in place: plain left click, no modifier keys. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function renderLink(
  node: Extract<HelpInlineNode, { kind: "link" }>,
  key: string,
  links: HelpLinkOptions,
): ReactNode {
  const children = renderNodes(node.children, `${key}.`, links);
  if (node.hrefKind === "internal") {
    // The public guide remains readable during a limited rollout. Avoid
    // sending its readers to a feature page that would return 404.
    if (/^\/reviews(?:[/?#]|$)/.test(node.href) && reviewsRollout() !== "on") {
      return <span key={key}>{children}</span>;
    }
    const slug = helpArticleSlugFromHref(node.href);
    if (slug) {
      const href = links.articleHref?.(slug) ?? node.href;
      const open = links.onOpenArticle;
      if (open) {
        return (
          <a
            key={key}
            href={href}
            className={HELP_TEXT_LINK_CLASS}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              event.preventDefault();
              open(slug);
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <Link key={key} href={href} className={HELP_TEXT_LINK_CLASS}>
          {children}
        </Link>
      );
    }
    return (
      <Link key={key} href={node.href} className={HELP_TEXT_LINK_CLASS}>
        {children}
      </Link>
    );
  }
  if (node.hrefKind === "external") {
    return (
      <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className={HELP_TEXT_LINK_CLASS}>
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <a key={key} href={node.href} className={HELP_TEXT_LINK_CLASS}>
      {children}
    </a>
  );
}

function renderNodes(nodes: ReadonlyArray<HelpInlineNode>, prefix: string, links: HelpLinkOptions): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${index}`;
    switch (node.kind) {
      case "text":
        return node.text;
      case "strong":
        return (
          <strong key={key} className="font-semibold text-text">
            {renderNodes(node.children, `${key}.`, links)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderNodes(node.children, `${key}.`, links)}</em>;
      case "code":
        return (
          <code key={key} className="rounded bg-bg-elevated px-1 py-0.5 font-mono text-[0.9em] text-text">
            {node.text}
          </code>
        );
      case "link":
        return renderLink(node, key, links);
    }
  });
}

/**
 * One text field as inline React nodes.
 *
 * Example: `<HelpInline text="Open [Devices](/devices)" />` → `Open <a href="/devices">Devices</a>`.
 */
export function HelpInline({ text, links = {} }: { text: string; links?: HelpLinkOptions }) {
  return <>{renderNodes(parseHelpInline(text), "n", links)}</>;
}
