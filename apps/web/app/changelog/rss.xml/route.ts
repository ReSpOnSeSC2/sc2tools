import { WHATS_NEW } from "@/lib/whatsNew";
import { rssResponse } from "@/lib/rss";

export const dynamic = "force-static";

export function GET() {
  const items = WHATS_NEW.map(entry => ({
    path: `/changelog#${entry.id}`,
    title: entry.title,
    description: [entry.summary, ...entry.highlights].join("\n"),
    date: entry.date,
  }));
  return rssResponse("SC2 Tools updates", "Recent SC2 Tools improvements", "/changelog", items);
}
