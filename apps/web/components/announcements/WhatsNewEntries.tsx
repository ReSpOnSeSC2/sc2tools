import Link from "next/link";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { AUDIENCE_LABELS, type WhatsNewEntry } from "@/lib/whatsNew";

export function WhatsNewEntries({ entries }: { entries: WhatsNewEntry[] }) {
  return <ol className="space-y-5">{entries.map((entry) => <li key={entry.id}><article id={entry.id} className="scroll-mt-24 space-y-3 rounded-xl border border-border bg-bg-surface p-4">
    <div className="flex flex-wrap items-center gap-2 text-micro text-text-dim"><time dateTime={entry.date}>{entry.date}</time><span className="rounded-full bg-bg-elevated px-2 py-1">{AUDIENCE_LABELS[entry.audience]}</span>{entry.agentVersion ? <span>Agent {entry.agentVersion}</span> : null}</div>
    <h2 className="text-h3 font-semibold text-text"><Link href={`/changelog#${entry.id}`} className="rounded text-text hover:text-accent-cyan focus-visible:ring-2 focus-visible:ring-accent">{entry.title}</Link></h2><p className="text-body text-text-muted">{entry.summary}</p>
    <ul className="list-disc space-y-1 pl-5 text-caption text-text-muted">{entry.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}</ul>
    {entry.helpSlug ? <LazyHelpLink slug={entry.helpSlug}>Learn how to use it</LazyHelpLink> : null}
  </article></li>)}</ol>;
}
