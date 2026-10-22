"use client";

import { Fragment, useCallback, useEffect, useMemo } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  articlesByCategory,
  helpArticlePath,
  helpSettingsPath,
  relatedArticles,
  resolveLegacyAnchor,
} from "@/lib/help";
import type { HelpArticle } from "@/lib/help/types";
import { HelpArticleBody } from "./HelpArticleBody";
import { HELP_TEXT_LINK_CLASS, isPlainClick, type HelpLinkOptions } from "./HelpInline";
import { HelpSearch } from "./HelpSearch";
import { HelpSupportLine } from "./HelpSupportLine";

/**
 * The help center embedded in Settings → Help: search on top, then every
 * article as a collapsible section grouped by topic, then the support
 * line. Same articles as the public /help pages.
 *
 * Each section's id is its slug, so `/settings?tab=help#<slug>` opens
 * and scrolls to it, as does an old anchor listed in an article's
 * `legacyAnchors` (the URL is rewritten to the current slug). Search
 * results, related links and links between articles open the target
 * section in place and move focus to it. Getting started is open by
 * default.
 */

const DEFAULT_OPEN_SLUG = "getting-started";

/** Open a section, scroll it into view and optionally focus its summary. */
function openSection(slug: string, focus: boolean): void {
  const section = document.getElementById(slug);
  if (!(section instanceof HTMLDetailsElement)) return;
  section.open = true;
  section.scrollIntoView?.({ block: "start" });
  if (focus) section.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
}

/** Point the URL's #anchor at a slug without adding a history entry. */
function writeHash(slug: string): void {
  if (window.location.hash === `#${slug}`) return;
  const url = new URL(window.location.href);
  url.hash = slug;
  window.history.replaceState(null, "", url);
}

function HelpSection({
  article,
  defaultOpen,
  links,
}: {
  article: HelpArticle;
  defaultOpen: boolean;
  links: Required<HelpLinkOptions>;
}) {
  const related = relatedArticles(article);
  return (
    <details
      id={article.slug}
      open={defaultOpen}
      className="group scroll-mt-20 rounded-lg border border-border bg-bg-elevated/40"
    >
      <summary className="cursor-pointer select-none list-none rounded-lg px-4 py-3 text-body font-medium text-text marker:content-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="mr-2 inline-block text-text-dim transition-transform group-open:rotate-90">
          ▸
        </span>
        {article.title}
      </summary>
      <div className="space-y-4 border-t border-border px-4 py-3">
        <HelpArticleBody article={article} variant="compact" links={links} />
        <div className="flex flex-col gap-2 border-t border-border pt-3 text-caption text-text-dim sm:flex-row sm:items-center sm:justify-between">
          {related.length > 0 ? (
            <p>
              Related:{" "}
              {related.map((item, index) => (
                <Fragment key={item.slug}>
                  {index > 0 ? " · " : null}
                  <a
                    href={links.articleHref(item.slug)}
                    className={HELP_TEXT_LINK_CLASS}
                    onClick={(event) => {
                      if (!isPlainClick(event)) return;
                      event.preventDefault();
                      links.onOpenArticle(item.slug);
                    }}
                  >
                    {item.title}
                  </a>
                </Fragment>
              ))}
            </p>
          ) : (
            <span />
          )}
          <Link
            href={helpArticlePath(article.slug)}
            className={`inline-flex min-h-11 shrink-0 items-center gap-1 sm:min-h-0 ${HELP_TEXT_LINK_CLASS}`}
          >
            Open full article
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </div>
      </div>
    </details>
  );
}

export function HelpCenter() {
  const groups = useMemo(() => articlesByCategory(), []);

  const openArticle = useCallback((slug: string) => {
    writeHash(slug);
    openSection(slug, true);
  }, []);

  // Deep links: open the section the URL names, now and on every later
  // #anchor change (back/forward, a pasted link).
  useEffect(() => {
    const openFromHash = () => {
      const slug = resolveLegacyAnchor(window.location.hash);
      if (!slug) return;
      writeHash(slug);
      openSection(slug, false);
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);

  const links = useMemo<Required<HelpLinkOptions>>(
    () => ({ articleHref: helpSettingsPath, onOpenArticle: openArticle }),
    [openArticle],
  );

  return (
    <div className="space-y-6">
      <HelpSearch articleHref={helpSettingsPath} onOpenArticle={openArticle} />
      {groups.map(({ category, articles }) => (
        <section key={category.id} aria-labelledby={`help-topic-${category.id}`} className="space-y-3">
          <h3 id={`help-topic-${category.id}`} className="overline text-text-dim">
            {category.name}
          </h3>
          {articles.map((article) => (
            <HelpSection
              key={article.slug}
              article={article}
              defaultOpen={article.slug === DEFAULT_OPEN_SLUG}
              links={links}
            />
          ))}
        </section>
      ))}
      <HelpSupportLine className="border-t border-border pt-4" />
    </div>
  );
}
