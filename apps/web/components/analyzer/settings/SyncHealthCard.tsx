"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button, LinkButton } from "@/components/ui/Button";
import { QueryState, hasQueryData } from "@/components/ui/QueryState";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { LazyReportIssueModal } from "@/components/feedback/LazyReportIssueModal";
import { useApi } from "@/lib/clientApi";
import { fmtAgo } from "@/lib/format";
import {
  SYNC_HEALTH_HELP,
  SYNC_NOT_REPORTED_HELP,
  otherSkippedByDevice,
  syncHealthItems,
  syncHealthStatus,
  syncReportPrefill,
  unresolvedNamesFor,
  type SyncFix,
  type SyncHealthItem,
  type SyncHealthResponse,
  type SyncReport,
} from "@/lib/syncHealth";
import { SyncHealthSkeleton } from "./SyncHealthSection";

const TONE_TEXT = { error: "text-danger", warn: "text-warning", info: "text-text-muted", ok: "text-success" } as const;

/**
 * Settings → Account → Sync health: what each PC's desktop app reports about
 * syncing, one row per reason with its fix and help section. It reads
 * GET /v1/me/sync-health once when shown, with no polling; Check again reads
 * it again. The names and toon handles of players the app couldn't match
 * appear here only, so the owner can recognise an account of their own.
 */
export function SyncHealthCard() {
  const health = useApi<SyncHealthResponse>("/v1/me/sync-health", { revalidateOnFocus: false, revalidateOnReconnect: false });
  const [reporting, setReporting] = useState(false);
  if (!hasQueryData(health)) return <QueryState q={health} skeleton={<SyncHealthSkeleton />} errorTitle="Sync health" />;
  const data = health.data;
  const items = syncHealthItems(data);
  const status = syncHealthStatus(data, items);
  return <Card title={status.title} headingLevel={2}>
    <p className="mb-3 text-caption text-text-muted">Sync health · <LazyHelpLink slug={SYNC_HEALTH_HELP.helpSlug} anchor={SYNC_HEALTH_HELP.anchor}>What these rows mean</LazyHelpLink></p>
    {status.sentence ? <div className="mb-3 flex flex-wrap items-center gap-3">
      <p className={`flex min-w-0 items-start gap-2 break-words text-caption ${status.tone === "ok" ? TONE_TEXT.ok : "text-text"}`}>
        {status.tone === "ok" ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : null}{status.sentence}
      </p>
      {status.action ? <LinkButton href={status.action.href} variant="secondary" size="sm">{status.action.label}</LinkButton> : null}
      {status.kind === "not_reported" ? <LazyHelpLink slug={SYNC_NOT_REPORTED_HELP.helpSlug} anchor={SYNC_NOT_REPORTED_HELP.anchor} className="text-caption">Why it isn&apos;t reported</LazyHelpLink> : null}
    </div> : null}
    {items.length ? <ul className="divide-y divide-border">{items.map((item) => <SyncHealthRowItem key={item.key} item={item}
      names={item.code === "replays_skipped_unresolved" ? unresolvedNamesFor(data, item.deviceId) : undefined}
      onReport={() => setReporting(true)} />)}</ul> : null}
    <OtherSkippedReplays data={data} />
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <Button variant="ghost" size="sm" loading={health.isValidating} onClick={() => { void health.mutate(); }}>Check again</Button>
      <span className="text-caption text-text-muted">Checked {fmtAgo(data.checkedAt)}</span>
    </div>
    <LazyReportIssueModal open={reporting} onClose={() => setReporting(false)} prefill={syncReportPrefill(data)} />
  </Card>;
}

function SyncHealthRowItem({ item, names, onReport }: { item: SyncHealthItem; names?: SyncReport["unresolvedNames"]; onReport: () => void }) {
  const Icon = item.tone === "error" ? XCircle : item.tone === "warn" ? AlertTriangle : Info;
  return <li className="flex items-start gap-3 py-3">
    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${TONE_TEXT[item.tone]}`} aria-hidden />
    <div className="min-w-0 flex-1 space-y-2">
      <div>
        <h3 className="text-caption font-semibold">{item.title}</h3>
        <p className="break-words text-caption text-text-muted">{item.sentence}{item.pc ? <> On <span className="break-all">{item.pc}</span>.</> : null}</p>
      </div>
      {names?.length ? <UnresolvedNames names={names} /> : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SyncFixAction fix={item.fix} onReport={onReport} />
        <LazyHelpLink slug={item.helpSlug} anchor={item.anchor} className="text-caption">Learn more<span className="sr-only"> about {item.title.toLowerCase()}</span></LazyHelpLink>
      </div>
    </div>
  </li>;
}

function SyncFixAction({ fix, onReport }: { fix: SyncFix | null; onReport: () => void }) {
  if (!fix) return null;
  if (fix.kind === "agent") return <p className="text-caption text-text">{fix.text}</p>;
  if (fix.kind === "link") return <LinkButton href={fix.href} variant="secondary" size="sm">{fix.label}</LinkButton>;
  // The sync range is a desktop app setting, so this fix is the help section that walks through it.
  if (fix.kind === "help") return <LazyHelpLink slug={fix.helpSlug} anchor={fix.anchor} className="text-caption font-semibold">{fix.label}</LazyHelpLink>;
  return <Button variant="secondary" size="sm" aria-haspopup="dialog" onClick={onReport}>{fix.label}</Button>;
}

/** The owner's own report: players the app saw often but couldn't match to this account. */
function UnresolvedNames({ names }: { names: NonNullable<SyncReport["unresolvedNames"]> }) {
  return <div className="rounded-lg border border-border bg-bg-elevated px-3 py-2">
    <p className="text-caption text-text-muted">Players in these replays. Only you see this list. If one of them is you, add that account to your profile.</p>
    <ul className="mt-1 space-y-0.5">{names.map((entry) => <li key={entry.toonHandle} className="break-all text-caption text-text">
      <span className="font-semibold">{entry.name}</span> · <span className="font-mono">{entry.toonHandle}</span> · {entry.count.toLocaleString("en-US")} {entry.count === 1 ? "replay" : "replays"}
    </li>)}</ul>
  </div>;
}

/** Skip counts with no row of their own, per reporting PC: why a replay never became a game. */
function OtherSkippedReplays({ data }: { data: SyncHealthResponse }) {
  const groups = otherSkippedByDevice(data);
  if (!groups.length) return null;
  return <details className="mt-3 text-caption">
    <summary className="cursor-pointer text-text-muted">Other skipped replays</summary>
    {groups.map(({ deviceId, pc, skips }) => <div key={deviceId} className="mt-2">
      <p className="break-all font-semibold">{pc}</p>
      <ul className="mt-1 space-y-1">{skips.map((skip) => <li key={skip.code} className="break-words">
        <span className="font-medium">{skip.count.toLocaleString("en-US")}</span> · {skip.text}
      </li>)}</ul>
    </div>)}
  </details>;
}
