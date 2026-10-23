import type { MetadataRoute } from "next";
import { ALL_HELP_ARTICLES } from "./articles/index.generated";
import type { HelpArticle } from "./types";

const HUB_PRIORITY = 0.6;
const ARTICLE_PRIORITY = 0.5;

/**
 * Sitemap rows for the public help center: the hub plus every article
 * not marked `noindex`, dated by the article's own `updated` field (the
 * hub by its newest listed article), never by the request time.
 *
 * Example: `helpSitemapRows("https://sc2tools.com")` →
 * `[{ url: "https://sc2tools.com/help", lastModified, … }, { url: ".../help/getting-started", … }, …]`.
 */
export function helpSitemapRows(
  siteUrl: string,
  allArticles: ReadonlyArray<HelpArticle> = ALL_HELP_ARTICLES,
): MetadataRoute.Sitemap {
  const articles = allArticles.filter((article) => !article.noindex);
  if (articles.length === 0) return [];
  const newest = articles.reduce((latest, article) => (article.updated > latest ? article.updated : latest), "");
  return [
    {
      url: `${siteUrl}/help`,
      lastModified: new Date(newest),
      changeFrequency: "weekly",
      priority: HUB_PRIORITY,
    },
    ...articles
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map((article) => ({
        url: `${siteUrl}/help/${article.slug}`,
        lastModified: new Date(article.updated),
        changeFrequency: "monthly" as const,
        priority: ARTICLE_PRIORITY,
      })),
  ];
}
