import { helpInlineLinks, helpInlinePlainText } from "./inline";
import { helpWidgetText } from "./widgets";
import type { HelpArticle, HelpBlock } from "./types";

/**
 * Plain text and link targets of article blocks: what the search index
 * reads, what structured data quotes, and what the link tests check.
 */

/** Every markup-bearing text field of a block, in reading order. */
function blockFields(block: HelpBlock): string[] {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return [block.text];
    case "steps":
    case "list":
      return block.items;
    case "callout":
      return block.title ? [block.title, block.text] : [block.text];
    case "settingsLink":
      return [block.label];
    case "image":
      return block.caption ? [block.alt, block.caption] : [block.alt];
    case "table":
      return [...block.head, ...block.rows.flat()];
    case "widget":
      return [];
  }
}

/**
 * The text a reader sees in one block, markup removed.
 *
 * Example: `helpBlockText({ type: "steps", items: ["Open **Devices**", "Pair"] })` → "Open Devices Pair".
 */
export function helpBlockText(block: HelpBlock): string {
  const text = blockFields(block).map(helpInlinePlainText);
  if (block.type === "widget") text.push(helpWidgetText(block.widget));
  return text.join(" ");
}

/** The whole article body as plain text. */
export function helpArticleBodyText(article: HelpArticle): string {
  return article.body.map(helpBlockText).join(" ");
}

/**
 * Every link target in an article body: inline [label](href) links and
 * settingsLink blocks.
 *
 * Example: an article with `{ type: "settingsLink", href: "/settings?tab=overlay" }`
 * → ["/settings?tab=overlay", …].
 */
export function helpArticleLinks(article: HelpArticle): string[] {
  const links: string[] = [];
  for (const block of article.body) {
    if (block.type === "settingsLink") links.push(block.href);
    for (const field of blockFields(block)) links.push(...helpInlineLinks(field));
  }
  return links;
}
