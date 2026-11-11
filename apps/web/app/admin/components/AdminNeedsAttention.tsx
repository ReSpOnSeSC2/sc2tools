"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, Fingerprint, MessageSquare, Server, ShieldAlert, TriangleAlert, Tv } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { formatNumber } from "@/lib/i18n/format";
import { AdminHelpLink, LoadingRows } from "./AdminFragments";
import { useAdminAttention } from "./useAdminAttention";

const QUEUES = [
  { key: "unreadMessages", verb: "Read", noun: "user message", href: "/admin/notifications?type=user_message", icon: MessageSquare },
  { key: "alerts", verb: "Check", noun: "system alert", href: "/admin/notifications", icon: TriangleAlert },
  { key: "openReports", verb: "Resolve", noun: "community report", href: "/admin/moderation", icon: ShieldAlert },
  { key: "pendingIdentities", verb: "Review", noun: "identity submission", href: "/admin/player-identities", icon: Fingerprint },
  { key: "pendingChannels", verb: "Review", noun: "channel submission", href: "/admin/player-channels?pendingOnly=1", icon: Tv },
] as const;

export function AdminNeedsAttention() {
  const { data, error, mutate } = useAdminAttention();
  const rows = data ? QUEUES.filter((row) => data[row.key] > 0) : [];
  const level = data?.advisories.level;
  const checkedAt = data ? new Date(data.generatedAt) : null;
  const time = checkedAt && Number.isFinite(checkedAt.getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(checkedAt) : null;
  return <section aria-labelledby="admin-attention-heading" className="space-y-2">
    <Card>
      <h2 id="admin-attention-heading" className="text-h3 font-semibold text-text">Needs attention</h2>
      {error ? <RequestError title="Could not check the queues" error={error} onRetry={() => mutate()} /> : !data ? (
        <div role="status" aria-label="Checking admin queues" className="mt-3"><LoadingRows rows={3} /></div>
      ) : rows.length || level ? (
        <ul className="mt-2 divide-y divide-border">
          {rows.map(({ key, verb, noun, href, icon: Icon }) => <li key={key}>
            <AttentionLink href={href} icon={Icon}>{verb} {formatNumber(data[key])} {noun}{data[key] === 1 ? "" : "s"}</AttentionLink>
          </li>)}
          {level ? <li><AttentionLink href="/admin/health" icon={Server}>
            {level === "upgrade" ? "Infrastructure: upgrade advised" : "Infrastructure: review capacity"}
          </AttentionLink></li> : null}
        </ul>
      ) : <p role="status" className="mt-3 flex flex-wrap items-center gap-2 text-body text-text-muted">
        <CheckCircle2 className="h-5 w-5 text-success" aria-hidden />All clear{time ? <span>· checked {time}</span> : null}
      </p>}
    </Card>
    <AdminHelpLink anchor="daily-triage" label="How to triage" />
  </section>;
}

function AttentionLink({ href, icon: Icon, children }: { href: string; icon: typeof Server; children: React.ReactNode }) {
  return <Link href={href} className="flex min-h-11 items-center gap-2 rounded px-1 text-caption font-semibold text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
    <Icon className="h-4 w-4 shrink-0" aria-hidden />
    <span className="min-w-0 flex-1 break-words">{children}</span>
    <ArrowRight className="h-4 w-4 shrink-0" aria-hidden />
  </Link>;
}
