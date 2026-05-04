"use client";

import { useApi } from "@/lib/clientApi";
import { Card, Skeleton } from "@/components/ui/Card";
import { fmtAgo } from "@/lib/format";
import Link from "next/link";

type Me = {
  userId: string;
  email?: string;
  source?: string;
  games?: { total: number; latest: string | null };
  agentVersion?: string | null;
};

export function SettingsFoundation() {
  const me = useApi<Me>("/v1/me");

  if (me.isLoading) return <Skeleton rows={3} />;
  if (!me.data) {
    return (
      <Card>
        <p className="text-danger">Couldn&rsquo;t load your account.</p>
      </Card>
    );
  }

  const games = me.data.games || { total: 0, latest: null };

  return (
    <div className="space-y-4">
      <Card title="Account">
        <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <Field label="Email" value={me.data.email || "—"} />
          <Field label="Cloud user ID" value={me.data.userId} mono />
          <Field label="Games synced" value={String(games.total)} />
          <Field
            label="Latest sync"
            value={games.latest ? fmtAgo(games.latest) : "—"}
          />
          <Field label="Agent version" value={me.data.agentVersion || "—"} />
        </dl>
      </Card>

      <Card title="Quick links">
        <ul className="space-y-1 text-sm">
          <li>
            <Link href="/devices">Devices &rarr;</Link>
          </li>
          <li>
            <Link href="/streaming">Streaming overlay &rarr;</Link>
          </li>
          <li>
            <Link href="/builds">Personal build library &rarr;</Link>
          </li>
          <li>
            <Link href="/download">Download / update agent &rarr;</Link>
          </li>
        </ul>
      </Card>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-border bg-bg-elevated px-3 py-2">
      <span className="text-text-dim">{label}</span>
      <span className={mono ? "font-mono text-xs" : undefined}>{value}</span>
    </div>
  );
}
