import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/PageHeader";
import { GuideBreadcrumbs } from "@/components/guides/GuideBreadcrumbs";
import { HelpArticleBody } from "@/components/help/HelpArticleBody";
import { HelpJsonLd } from "@/components/help/HelpJsonLd";
import { HelpSignInNote } from "@/components/help/HelpSignInNote";
import { HelpSupportLine } from "@/components/help/HelpSupportLine";
import {
  ALL_HELP_ARTICLES,
  articlesByCategory,
  formatHelpDate,
  getArticle,
  helpArticlePath,
  helpAudienceLabel,
  relatedArticles,
} from "@/lib/help";
import { helpCategory } from "@/lib/help/categories";
import { helpInlinePlainText } from "@/lib/help/inline";
import { helpArticleCrumbs, helpArticleJsonLd } from "@/lib/help/jsonLd";
import { siteTitle } from "@/lib/siteTitle";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://sc2tools.com").replace(/\/+$/, "");

type Params = { params: Promise<{ slug: string }> };

// Every article is known at build time; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams(): Array<{ slug: string }> {
  return ALL_HELP_ARTICLES.map((article) => ({ slug: article.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) return { title: "Help article not found" };
  // "Getting started · Help · SC2 Tools" in the tab (root template);
  // social cards get no template, so they carry the brand themselves.
  const title = `${article.title} · Help`;
  const shareTitle = siteTitle(title);
  const description = helpInlinePlainText(article.summary);
  const canonical = helpArticlePath(article.slug);
  return {
    title,
    description,
    alternates: { canonical },
    // Invite-only features stay out of search engines (and the sitemap).
    ...(article.noindex ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: "article",
      siteName: "SC2 Tools",
      url: canonical,
      title: shareTitle,
      description,
      modifiedTime: article.updated,
      images: [{ url: "/og.jpg", width: 1200, height: 630, alt: "SC2 Tools Help" }],
    },
    twitter: { card: "summary_large_image", title: shareTitle, description, images: ["/og.jpg"] },
  };
}

const SIDE_LINK_CLASS =
  "-mx-2 flex min-h-11 items-center rounded-md px-2 py-1.5 text-caption hover:bg-bg-elevated hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

/**
 * /help/<slug> — one help article: breadcrumbs, title and summary, the
 * article body, related articles and the support line, with the other
 * articles in the same topic alongside. Statically generated; FAQPage or
 * HowTo structured data where the content fits (lib/help/jsonLd.ts).
 */
export default async function HelpArticlePage({ params }: Params) {
  const { slug } = await params;
  const article = getArticle(slug);
  if (!article) notFound();

  const category = helpCategory(article.category);
  const siblings = articlesByCategory().find((group) => group.category.id === article.category)?.articles ?? [];
  const related = relatedArticles(article);
  const audience = helpAudienceLabel(article);

  return (
    <div className="space-y-6">
      <HelpJsonLd items={helpArticleJsonLd(article, SITE_URL)} />
      <GuideBreadcrumbs crumbs={helpArticleCrumbs(article)} />

      {/* Topic list on the left at desktop width, after the article on
          phones; the article keeps a readable line length. */}
      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
        <article className="min-w-0 max-w-3xl space-y-6">
          <PageHeader eyebrow={category.name} title={article.title} description={helpInlinePlainText(article.summary)} />
          <p className="flex flex-wrap items-center gap-2 text-caption text-text-dim">
            <span>
              Updated <time dateTime={article.updated}>{formatHelpDate(article.updated)}</time>
            </span>
            {audience ? <Badge size="sm">{audience}</Badge> : null}
          </p>
          {article.signedInOnly ? <HelpSignInNote /> : null}

          <Card>
            <HelpArticleBody article={article} />
          </Card>

          {related.length > 0 ? (
            <section aria-labelledby="help-related-title" className="space-y-3">
              <h2 id="help-related-title" className="font-display text-h4 font-bold text-text">
                Related articles
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {related.map((item) => (
                  <li key={item.slug}>
                    <Link
                      href={helpArticlePath(item.slug)}
                      className="group flex h-full flex-col gap-1 rounded-xl border-2 border-line bg-bg-surface p-4 shadow-hard transition-colors hover:border-accent hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                    >
                      <span className="flex items-center justify-between gap-2 font-semibold text-text group-hover:text-accent">
                        {item.title}
                        <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
                      </span>
                      <span className="text-caption text-text-muted">{helpInlinePlainText(item.summary)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <HelpSupportLine className="border-t border-border pt-6" />
        </article>

        <div className="space-y-4 lg:sticky lg:top-24 lg:order-first lg:self-start">
          <nav aria-labelledby="help-topic-nav-title">
            <h2 id="help-topic-nav-title" className="overline text-text-dim">
              In {category.name}
            </h2>
            <ul className="mt-2 space-y-0.5">
              {siblings.map((item) => (
                <li key={item.slug}>
                  <Link
                    href={helpArticlePath(item.slug)}
                    aria-current={item.slug === article.slug ? "page" : undefined}
                    className={`${SIDE_LINK_CLASS} ${item.slug === article.slug ? "bg-accent/15 font-semibold text-accent" : "text-text-muted"}`}
                  >
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <Link
            href="/help"
            className="inline-flex min-h-11 items-center gap-1.5 rounded-sm text-caption font-semibold text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden />
            All help topics
          </Link>
        </div>
      </div>
    </div>
  );
}
