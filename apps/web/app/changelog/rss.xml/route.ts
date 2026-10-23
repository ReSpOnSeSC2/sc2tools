import { WHATS_NEW } from "@/lib/whatsNew";
export const dynamic = "force-static";
const escape = (value: string) => value.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);
export function GET() {
  const base = (process.env.NEXT_PUBLIC_SITE_URL || "https://sc2tools.com").replace(/\/+$/, "");
  const items = WHATS_NEW.map((entry) => `<item><guid isPermaLink="true">${escape(`${base}/changelog#${entry.id}`)}</guid><link>${escape(`${base}/changelog#${entry.id}`)}</link><title>${escape(entry.title)}</title><description>${escape([entry.summary, ...entry.highlights].join("\n"))}</description><pubDate>${new Date(`${entry.date}T00:00:00Z`).toUTCString()}</pubDate></item>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>SC2 Tools updates</title><link>${escape(base)}/changelog</link><description>Recent SC2 Tools improvements</description>${items}</channel></rss>`, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}
