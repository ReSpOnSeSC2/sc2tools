"use client";

import { useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { RequestError } from "@/components/ui/RequestError";
import { apiCall, useApi } from "@/lib/clientApi";
import type { CoverageMonth } from "@/lib/donationCoverage";

type MonthResponse = { coverage: CoverageMonth | null };
type Entry = { id: string; editId: string | null; displayName: string; message: string; month: string };
type QueueResponse = { items: Entry[] };
type ReviewStatus = "approved" | "rejected";

export function DonationLedgerCard() {
  const now = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState(now);
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/u.test(month) && month <= now;
  return (
    <Card title="Monthly donations">
      <div className="space-y-4">
        <Field label="Month (UTC)"><Input type="month" value={month} max={now} onChange={(event) => setMonth(event.target.value)} /></Field>
        {validMonth ? <MonthEditor key={month} month={month} /> : null}
        <SupporterReview />
      </div>
    </Card>
  );
}

function MonthEditor({ month }: { month: string }) {
  const { getToken } = useAuth();
  const path = `/v1/admin/donations/${month}`;
  const stored = useApi<MonthResponse>(path, { revalidateOnFocus: false });
  const [usd, setUsd] = useState<string>();
  const [supporters, setSupporters] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const amount = usd ?? stored.data?.coverage?.receivedUsd.toString() ?? "";
  const count = supporters ?? stored.data?.coverage?.supporterCount.toString() ?? "";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || amount === "" || count === "") return;
    setError(null);
    setStatus(null);
    setSaving(true);
    try {
      const saved = await apiCall<MonthResponse>(getToken, path, {
        method: "PUT", body: JSON.stringify({ receivedUsd: Number(amount), supporterCount: Number(count) }),
      });
      await stored.mutate(saved, { revalidate: false });
      setUsd(undefined);
      setSupporters(undefined);
      setStatus("Monthly totals saved.");
    } catch {
      setError("Couldn't save these totals. Check the amounts and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (stored.error) return <RequestError title="Couldn't load this month" error={stored.error} onRetry={() => stored.mutate()} />;
  if (stored.isLoading) return <p role="status">Loading monthly totals…</p>;
  return (
    <form onSubmit={(event) => { void save(event); }} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Received (USD)"><Input type="number" inputMode="decimal" min="0" step="0.01" required value={amount} onChange={(event) => setUsd(event.target.value)} /></Field>
        <Field label="Supporter count"><Input type="number" inputMode="numeric" min="0" step="1" required value={count} onChange={(event) => setSupporters(event.target.value)} /></Field>
      </div>
      <Button type="submit" loading={saving}>Save totals</Button>
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </form>
  );
}

function SupporterReview() {
  const { getToken } = useAuth();
  const queue = useApi<QueueResponse>("/v1/admin/supporters?status=pending", { revalidateOnFocus: false });
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function review(entry: Entry, status: ReviewStatus) {
    setActive(entry.id);
    setError(null);
    try {
      await apiCall(getToken, `/v1/admin/supporters/${entry.id}`, {
        method: "PATCH", body: JSON.stringify({ status, editId: entry.editId }),
      });
      await queue.mutate();
    } catch {
      setError("Couldn't review the entry. Check the current version before retrying.");
      await queue.mutate();
    } finally {
      setActive(null);
    }
  }

  return (
    <section className="space-y-2 border-t border-border pt-3" aria-labelledby="supporter-review">
      <h3 id="supporter-review" className="text-h4 font-semibold">Supporter wall review</h3>
      {queue.error ? <RequestError title="Couldn't load supporter entries" error={queue.error} onRetry={() => queue.mutate()} /> : null}
      {queue.isLoading ? <p role="status">Loading supporter entries…</p> : null}
      {queue.data && !queue.data.items.length ? <p className="text-text-muted">No entries awaiting review.</p> : null}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
      <ul className="divide-y divide-border">
        {(queue.data?.items ?? []).map((entry) => (
          <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0 break-words">
              <p className="font-semibold">{entry.displayName} · {entry.month}</p>
              {entry.message ? <p className="text-caption text-text-muted">{entry.message}</p> : null}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" disabled={active !== null} aria-label={`Approve ${entry.displayName}`} onClick={() => { void review(entry, "approved"); }}>Approve</Button>
              <Button size="sm" variant="ghost" disabled={active !== null} aria-label={`Reject ${entry.displayName}`} onClick={() => { void review(entry, "rejected"); }}>Reject</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
