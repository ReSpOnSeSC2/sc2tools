/**
 * schema.org structured data for a public help article:
 *
 *   - BreadcrumbList on every article (Help center › topic › article).
 *   - FAQPage when the article has two or more question items: list
 *     items written as "**Question?** Answer" (troubleshooting lists).
 *   - Otherwise HowTo when the article has a numbered steps block (the
 *     first one is the procedure).
 *
 * Pure: the site origin is passed in. Every string is plain text (markup
 * removed); the page serializes the result with serializeJsonLd so no
 * text can close the script tag.
 */
import { helpCategory } from "./categories";
import { helpInlinePlainText } from "./inline";
import type { HelpArticle } from "./types";

const SCHEMA_CONTEXT = "https://schema.org";
const QUESTION_ITEM_RE = /^\*\*([^*]+\?)\*\*\s+([\s\S]+)$/;
const STEP_LABEL_RE = /^\*\*([^*]+?)[.:]?\*\*/;
const MIN_FAQ_ITEMS = 2;

export interface HelpFaqItem {
  question: string;
  answer: string;
}

/**
 * The article's "**Question?** Answer" list items.
 *
 * Example: an item "**Widget blank?** Check the widget is enabled…" →
 * `{ question: "Widget blank?", answer: "Check the widget is enabled…" }`.
 */
export function helpFaqItems(article: HelpArticle): HelpFaqItem[] {
  const items: HelpFaqItem[] = [];
  for (const block of article.body) {
    if (block.type !== "list") continue;
    for (const item of block.items) {
      const match = QUESTION_ITEM_RE.exec(item);
      if (match) {
        items.push({ question: helpInlinePlainText(match[1]), answer: helpInlinePlainText(match[2]) });
      }
    }
  }
  return items;
}

/** The visible breadcrumb trail for an article (site-relative paths). */
export function helpArticleCrumbs(article: HelpArticle): Array<{ name: string; path: string }> {
  const category = helpCategory(article.category);
  return [
    { name: "Help center", path: "/help" },
    { name: category.name, path: `/help#${category.id}` },
    { name: article.title, path: `/help/${article.slug}` },
  ];
}

function breadcrumbList(article: HelpArticle, siteUrl: string): Record<string, unknown> {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: helpArticleCrumbs(article).map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: `${siteUrl}${crumb.path}`,
    })),
  };
}

function howTo(article: HelpArticle, siteUrl: string): Record<string, unknown> | null {
  const steps = article.body.find((block) => block.type === "steps");
  if (!steps || steps.type !== "steps" || steps.items.length === 0) return null;
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "HowTo",
    name: article.title,
    description: helpInlinePlainText(article.summary),
    url: `${siteUrl}/help/${article.slug}`,
    dateModified: article.updated,
    step: steps.items.map((item, index) => {
      const text = helpInlinePlainText(item);
      const label = STEP_LABEL_RE.exec(item)?.[1];
      return {
        "@type": "HowToStep",
        position: index + 1,
        name: label ? helpInlinePlainText(label) : `Step ${index + 1}`,
        text,
      };
    }),
  };
}

function faqPage(items: ReadonlyArray<HelpFaqItem>): Record<string, unknown> {
  return {
    "@context": SCHEMA_CONTEXT,
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

/**
 * Structured data blocks for an article page.
 *
 * Example: `helpArticleJsonLd(gettingStarted, "https://sc2tools.com")` →
 * `[BreadcrumbList, HowTo]`.
 */
export function helpArticleJsonLd(article: HelpArticle, siteUrl: string): Array<Record<string, unknown>> {
  const blocks = [breadcrumbList(article, siteUrl)];
  const faq = helpFaqItems(article);
  if (faq.length >= MIN_FAQ_ITEMS) {
    blocks.push(faqPage(faq));
  } else {
    const steps = howTo(article, siteUrl);
    if (steps) blocks.push(steps);
  }
  return blocks;
}
