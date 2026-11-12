import { absoluteUrl } from "./seo/absoluteUrl";

type FeedItem = { path: string; title: string; description: string; date?: string };

const ENTITIES: Record<string, string> = {
  "<": "&lt;",
  ">": "&gt;",
  "&": "&amp;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, character => ENTITIES[character]);
}

function renderItem(item: FeedItem): string {
  const url = escapeXml(absoluteUrl(item.path));
  const published = item.date ? `<pubDate>${new Date(`${item.date}T00:00:00Z`).toUTCString()}</pubDate>` : "";
  return `<item><guid isPermaLink="true">${url}</guid><link>${url}</link><title>${escapeXml(item.title)}</title><description>${escapeXml(item.description)}</description>${published}</item>`;
}

export function rssResponse(title: string, description: string, path: string, items: FeedItem[]): Response {
  const link = escapeXml(absoluteUrl(path));
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeXml(title)}</title><link>${link}</link><description>${escapeXml(description)}</description>${items.map(renderItem).join("")}</channel></rss>`;
  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
