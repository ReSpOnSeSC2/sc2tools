"use client";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";
import { ThemeChoice } from "@/components/ui/ThemeChoice";
import type { ReportType } from "@/lib/feedback/reportContext";
import type { NavEntry } from "./appNav";
import { helpMenuItems, type HelpMenuItem } from "./helpMenuItems";
import { startNavProgress } from "./NavProgress";
const ROW = "flex min-h-11 w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-body font-semibold text-text hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const CAPTION = "px-2 pb-1 pt-3 text-micro font-bold uppercase tracking-[0.14em] text-text-dim";
function beginNavigation(href: string) {
  const target = new URL(href, window.location.href);
  if (target.pathname + target.search !== window.location.pathname + window.location.search) startNavProgress();
}
export function MoreSheet({ entries, activeKey, onClose, onReport }: { entries: readonly NavEntry[]; activeKey: string | null; onClose: () => void; onReport: (type: ReportType) => void }) {
  return <Modal open title="More sections" onClose={onClose} mobileLayout="sheet">
    <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-border-strong" aria-hidden />
    {([['section', 'Analysis'], ['utility', 'Your setup']] as const).map(([group, label]) => <section key={group} aria-label={label}><h3 className={CAPTION}>{label}</h3>{entries.filter((entry) => entry.group === group).map((entry) => { const Icon = entry.icon; return <Link key={entry.key} href={entry.href} onNavigate={() => beginNavigation(entry.href)} onClick={onClose} aria-current={activeKey === entry.key ? "page" : undefined} className={`${ROW} ${activeKey === entry.key ? "bg-accent-cyan/10 text-accent-cyan" : ""}`}><Icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />{entry.label}</Link>; })}</section>)}
    <section aria-label="Help & support"><h3 className={CAPTION}>Help &amp; support</h3>{helpMenuItems(true).map((item) => <HelpRow key={item.key} item={item} onClose={onClose} onReport={onReport} />)}
      <a href="https://status.sc2tools.com" target="_blank" rel="noopener noreferrer" className={ROW}>System status <ExternalLink className="h-4 w-4" aria-hidden /></a>
      <Link href="/legal/privacy" onClick={onClose} className={ROW}>Privacy</Link><Link href="/legal/terms" onClick={onClose} className={ROW}>Terms</Link>
      <InstallAppButton className="w-full text-body" />
    </section><ThemeChoice className="mt-4 border-t border-border pt-3" />
  </Modal>;
}
function HelpRow({ item, onClose, onReport }: { item: HelpMenuItem; onClose: () => void; onReport: (type: ReportType) => void }) {
  const Icon = item.icon;
  const content = <><Icon className="h-5 w-5 shrink-0 text-text-muted" aria-hidden />{item.label}</>;
  return item.report ? <button type="button" aria-haspopup="dialog" onClick={() => onReport(item.report!)} className={ROW}>{content}</button> : <Link href={item.href!} onClick={onClose} className={ROW}>{content}</Link>;
}
