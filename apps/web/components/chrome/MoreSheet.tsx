"use client";
import Link from "next/link";
import { Sheet } from "@/components/ui/Sheet";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";
import { ThemeChoice } from "@/components/ui/ThemeChoice";
import type { ReportType } from "@/lib/feedback/reportContext";
import type { NavEntry } from "./appNav";
import { helpMenuItems, type HelpMenuItem } from "./helpMenuItems";
import { startNavProgress } from "./NavProgress";
import { Search } from "lucide-react";
const ROW = "flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-body font-semibold text-text motion-safe:transition-colors hover:bg-bg-subtle/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const TILE = "flex min-h-[4.5rem] flex-col justify-between gap-2 rounded-2xl border border-line p-3 motion-safe:transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const CAPTION = "px-2 pb-1 pt-3 text-micro font-semibold uppercase tracking-[0.14em] text-text-dim";
function beginNavigation(href: string) {
  const target = new URL(href, window.location.href);
  if (target.pathname + target.search !== window.location.pathname + window.location.search) startNavProgress();
}
export function MoreSheet({ entries, activeKey, onClose, onReport, onSearch }: { entries: readonly NavEntry[]; activeKey: string | null; onClose: () => void; onReport: (type: ReportType) => void; onSearch?: () => void }) {
  const explore = entries.find((entry) => entry.group === "explore");
  const ExploreIcon = explore?.icon;
  return <Sheet open side="bottom" title="More sections" onClose={onClose}>
    <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden />
    {onSearch ? <button type="button" onClick={onSearch} aria-haspopup="dialog" className={ROW}>
      <Search className="h-5 w-5" aria-hidden />Search
    </button> : null}
    {explore && ExploreIcon && <Link href={explore.href} prefetch={false} onNavigate={() => beginNavigation(explore.href)} onClick={onClose} className={ROW}>
      <ExploreIcon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />{explore.label}
    </Link>}
    {([['section', 'Analysis'], ['utility', 'Your setup']] as const).map(([group, label]) => <section key={group} aria-label={label}><h3 className={CAPTION}>{label}</h3>
      <div className={group === "section" ? "grid grid-cols-2 gap-2 sm:grid-cols-3" : undefined}>{entries.filter((entry) => entry.group === group).map((entry) => { const Icon = entry.icon; const current = activeKey === entry.key;
        return group === "section"
          ? <Link key={entry.key} href={entry.href} onNavigate={() => beginNavigation(entry.href)} onClick={onClose} aria-current={current ? "page" : undefined} className={`${TILE} ${current ? "bg-accent-cyan/10 text-text ring-1 ring-accent-cyan/30" : "bg-bg-elevated/60 text-text hover:bg-bg-subtle/70"}`}><Icon className={`h-5 w-5 shrink-0 ${current ? "text-accent-cyan" : "text-text-muted"}`} aria-hidden /><span className="text-caption font-semibold">{entry.label}</span></Link>
          : <Link key={entry.key} href={entry.href} onNavigate={() => beginNavigation(entry.href)} onClick={onClose} aria-current={current ? "page" : undefined} className={`${ROW} ${current ? "bg-accent-cyan/10 text-text" : ""}`}><Icon className={`h-5 w-5 shrink-0 ${current ? "text-accent-cyan" : "text-text-muted"}`} aria-hidden />{entry.label}</Link>; })}</div></section>)}
    <section aria-label="Help & support"><h3 className={CAPTION}>Help &amp; support</h3>{helpMenuItems(true).map((item) => <HelpRow key={item.key} item={item} onClose={onClose} onReport={onReport} />)}
      <Link href="/status" prefetch={false} onClick={onClose} className={ROW}>System status</Link>
      <Link href="/legal/privacy" onClick={onClose} className={ROW}>Privacy</Link><Link href="/legal/terms" onClick={onClose} className={ROW}>Terms</Link>
      <InstallAppButton className="w-full text-body" />
    </section><ThemeChoice className="mt-4 border-t border-line pt-3" />
  </Sheet>;
}
function HelpRow({ item, onClose, onReport }: { item: HelpMenuItem; onClose: () => void; onReport: (type: ReportType) => void }) {
  const Icon = item.icon;
  const content = <><Icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />{item.label}</>;
  return item.report ? <button type="button" aria-haspopup="dialog" onClick={() => onReport(item.report!)} className={ROW}>{content}</button> : <Link href={item.href!} onClick={onClose} className={ROW}>{content}</Link>;
}
