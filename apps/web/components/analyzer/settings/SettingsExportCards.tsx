"use client";

import { useId, useState } from "react";
import { API_BASE } from "@/lib/clientApi";
import { localDayStartIso, localNextDayStartIso } from "@/lib/localDateRange";
import type { useExportDownload } from "@/lib/exports/useExportDownload";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import Link from "next/link";

type Download = ReturnType<typeof useExportDownload>;

/** Owner-keyed by its parent: filters and continuation never survive an account transition. */
export function SettingsExportCards({ download }: { download: Download }) {
  const id = useId();
  const [details, setDetails] = useState(false), [format, setFormat] = useState<"csv" | "ndjson">("csv");
  const [since, setSince] = useState(""), [until, setUntil] = useState("");
  const [page, setPage] = useState<{ scope: string; cursor: string } | null>(null);
  const scope = JSON.stringify([download.owner, format, since, until]);
  const invalidRange = Boolean(since && until && since > until);
  const disabled = !download.owner || download.busy;
  const change = () => { setPage(null); download.clear(); };

  async function archive() {
    if (!download.apiOwner) return;
    setPage(null);
    await download.run({ url: `${API_BASE}/v1/me/export?format=ndjson${details ? "&details=1" : ""}`,
      filename: `sc2tools-account-${Date.now()}.ndjson`, contentType: "application/x-ndjson",
      ndjson: { format: "sc2tools-account-export", apiOwner: download.apiOwner } });
  }

  async function buildOrders(cursor?: string) {
    const capturedScope = scope;
    const query = new URLSearchParams();
    try {
      if (since) query.set("since", localDayStartIso(since));
      if (until) query.set("until", localNextDayStartIso(until));
    } catch { return; }
    if (cursor) query.set("continuation_token", cursor);
    if (!cursor) setPage(null);
    await download.run({ url: `${API_BASE}/v1/export/build-orders.${format}?${query}`,
      filename: `sc2tools-build-orders-${Date.now()}.${format}`, contentType: format === "csv" ? "text/csv" : "application/x-ndjson",
      paged: true, ...(format === "ndjson" ? { ndjson: { format: "sc2tools-build-order-export" as const } } : {}) },
    result => setPage(result.continuation ? { scope: capturedScope, cursor: result.continuation } : null));
  }

  const next = page?.scope === scope ? page.cursor : null;
  return <Section id="export" className="scroll-mt-28" title="Export" description="Save a private copy of your data. File sizes vary with your game history and the details you include.">
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <div className="space-y-3">
          <h3 className="font-semibold">Full account archive</h3>
          <p className="text-caption text-text-muted">NDJSON streams your games, opponents, notes, custom builds, settings and overlay tokens. Keep this file private. It is an account archive, separate from restorable snapshots and redacted support bundles.</p>
          <label className="flex items-center gap-2 text-caption"><input type="checkbox" checked={details} disabled={download.busy} onChange={event => { change(); setDetails(event.target.checked); }} />Include game details (build orders and charts; larger file)</label>
          <Button variant="secondary" disabled={disabled || !download.apiOwner} onClick={archive}>Download full archive</Button>
          {download.owner && !download.apiOwner ? <p className="text-caption text-text-muted">Waiting for your account details…</p> : null}
        </div>
      </Card>
      <Card>
        <div className="space-y-3">
          <h3 className="font-semibold">Build orders</h3>
          <p className="text-caption text-text-muted">Up to 2,000 games per file, three requests per rolling hour. Each page uses one request, including cancelled or failed downloads after admission. Supply is blank when it was not recorded.</p>
          <label htmlFor={`${id}-format`} className="block space-y-1 text-caption">Format<Select id={`${id}-format`} aria-label="Build-order export format" value={format} disabled={download.busy} onChange={event => { change(); setFormat(event.target.value as "csv" | "ndjson"); }}><option value="csv">CSV</option><option value="ndjson">NDJSON</option></Select></label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label htmlFor={`${id}-since`} className="space-y-1 text-caption">From<Input id={`${id}-since`} type="date" aria-label="Export games from" value={since} disabled={download.busy} onChange={event => { change(); setSince(event.target.value); }} /></label>
            <label htmlFor={`${id}-until`} className="space-y-1 text-caption">Through (inclusive)<Input id={`${id}-until`} type="date" aria-label="Export games through" value={until} disabled={download.busy} onChange={event => { change(); setUntil(event.target.value); }} /></label>
          </div>
          <p className="text-caption text-text-muted">Dates use your local time. Leave both empty for all games.</p>
          {invalidRange ? <p role="alert" className="text-caption text-danger">From must be on or before Through.</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={disabled || invalidRange} onClick={() => buildOrders()}>Download build orders</Button>
            {next ? <Button variant="secondary" disabled={disabled || invalidRange} onClick={() => buildOrders(next)}>Download next page</Button> : null}
          </div>
        </div>
      </Card>
    </div>
    <div className="mt-3 space-y-2">
      <p className="text-caption text-text-muted">For original .SC2Replay files, <Link className="text-accent underline" href="/app/replays#replay-packs">create a private replay pack in Replays</Link>. Choose up to 100 games; the archive includes a manifest of saved and unavailable files.</p>
      <p className="text-caption text-text-muted">Save directly to a file when your browser offers it. Other browsers support downloads up to 128 MiB. Exports read records in sequence, so changes made during a download may appear in the file.</p>
      {download.feedback ? <p role="status" className="text-caption">{download.feedback.message}{download.feedback.bytes ? ` (${(download.feedback.bytes / 1024 / 1024).toFixed(1)} MiB)` : ""}</p> : null}
      {download.busy ? <Button variant="secondary" onClick={download.cancel}>Cancel export</Button> : null}
    </div>
  </Section>;
}
