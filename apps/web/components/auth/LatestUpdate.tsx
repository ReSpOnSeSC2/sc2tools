import Link from "next/link";
import { WHATS_NEW } from "@/lib/whatsNew";

type PublicUpdate = { id: string; title: string; date: string; audience: string };
/** Only explicitly general-audience entries belong on the sign-in page. */
export function latestPublicUpdate(entries: readonly PublicUpdate[]): PublicUpdate | undefined {
  return entries.filter((entry) => entry.audience === "all").sort((a, b) => b.date.localeCompare(a.date))[0];
}
export function LatestUpdate() {
  const entry = latestPublicUpdate(WHATS_NEW);
  if (!entry) return null;
  const date = new Date(`${entry.date}T00:00:00Z`).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  return <aside aria-label="Latest update" className="space-y-1 rounded-lg border border-border bg-bg-surface p-4"><p className="text-caption text-text-muted">Latest · <time dateTime={entry.date}>{date}</time></p><Link className="font-semibold text-accent-cyan underline underline-offset-2" href={`/changelog#${entry.id}`}>{entry.title}</Link></aside>;
}
