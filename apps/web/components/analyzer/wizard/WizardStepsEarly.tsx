"use client";

import { useApi } from "@/lib/clientApi";
import Link from "next/link";
import { Skeleton } from "@/components/ui/Card";

type Me = {
  email?: string;
  userId: string;
  games?: { total: number; latest: string | null };
};

export function WizardStepsEarly() {
  const me = useApi<Me>("/v1/me");
  if (me.isLoading) return <Skeleton rows={2} />;
  const total = me.data?.games?.total || 0;

  return (
    <div className="space-y-3 text-sm">
      <h2 className="text-lg font-semibold">Account check</h2>
      <p className="text-text-muted">
        You&rsquo;re signed in as{" "}
        <span className="font-mono">{me.data?.email || "—"}</span>.
      </p>
      <ul className="space-y-1 text-text-muted">
        <li>
          ✓ Cloud user ID:{" "}
          <span className="font-mono text-xs">{me.data?.userId}</span>
        </li>
        <li>
          {total > 0 ? "✓" : "·"} Games synced:{" "}
          <strong>{total}</strong>
        </li>
        <li>
          ·{" "}
          <Link href="/devices">
            Pair the local agent in Devices →
          </Link>
        </li>
      </ul>
      {total === 0 && (
        <p className="rounded border border-warning/30 bg-warning/10 p-3 text-warning">
          No games yet. Install the agent and play a ranked match — this
          page will tick once it arrives.
        </p>
      )}
    </div>
  );
}
