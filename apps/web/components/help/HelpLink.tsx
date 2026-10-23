"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, CircleHelp } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { getArticle, helpArticlePath } from "@/lib/help";
import { helpInlinePlainText } from "@/lib/help/inline";
import { HelpArticleBody } from "./HelpArticleBody";
import { HELP_ICON_LINK_CLASS, HELP_TEXT_LINK_CLASS, isPlainClick } from "./HelpInline";
import { HelpSupportLine } from "./HelpSupportLine";

/**
 * <HelpLink slug="build-check-in">How build check-in works</HelpLink>
 *
 * Opens a help article in a side sheet next to the feature (a bottom
 * sheet on phones), built on Modal: focus is trapped inside, Esc or the
 * close button closes it, and focus returns to the link. "Open full
 * article" goes to /help/<slug>.
 *
 * It is a real link to the article, so a middle-click or Ctrl/Cmd-click
 * still opens the page in a new tab, and it works before hydration.
 *
 *   variant="inline" (default): text link; children default to the title.
 *   variant="icon": a small "?" button for tight spots next to a setting;
 *     its accessible name is "Help: <article title>".
 */
export interface HelpLinkProps {
  slug: string;
  children?: ReactNode;
  variant?: "inline" | "icon";
  className?: string;
}

export function HelpLink({ slug, children, variant = "inline", className = "" }: HelpLinkProps) {
  const [open, setOpen] = useState(false);
  const article = getArticle(slug);
  // An unknown slug is a content bug (the help tests catch it); never
  // render a link that leads nowhere.
  if (!article) return children ? <>{children}</> : null;

  const href = helpArticlePath(article.slug);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <>
      {variant === "icon" ? (
        <a
          href={href}
          onClick={onClick}
          aria-haspopup="dialog"
          aria-label={`Help: ${article.title}`}
          title={article.title}
          className={[HELP_ICON_LINK_CLASS, className].filter(Boolean).join(" ")}
        >
          <CircleHelp className="h-4 w-4" aria-hidden />
        </a>
      ) : (
        <a
          href={href}
          onClick={onClick}
          aria-haspopup="dialog"
          className={[HELP_TEXT_LINK_CLASS, className].filter(Boolean).join(" ")}
        >
          {children ?? article.title}
        </a>
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={article.title}
        description={helpInlinePlainText(article.summary)}
        desktopLayout="side"
        size="lg"
        footer={
          <Link
            href={href}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 font-semibold text-accent-cyan hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open full article
            <ArrowUpRight className="h-4 w-4" aria-hidden />
          </Link>
        }
      >
        <div className="space-y-5">
          <HelpArticleBody article={article} variant="compact" />
          <HelpSupportLine className="border-t border-border pt-4 text-caption" />
        </div>
      </Modal>
    </>
  );
}
