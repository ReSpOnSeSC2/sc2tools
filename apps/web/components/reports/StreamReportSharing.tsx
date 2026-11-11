"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { PlayerCopyButton } from "@/components/public-profile/PlayerCopyButton";
import { apiCall } from "@/lib/clientApi";
import type { StreamPublication } from "@/lib/reports";

export function StreamReportSharing({ id, publication, onSave }: {
  id: string; publication: StreamPublication; onSave: (value: StreamPublication) => void;
}) {
  const { getToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function update(enabled: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await apiCall<StreamPublication>(getToken, `/v1/reports/streams/${encodeURIComponent(id)}/sharing`, {
        method: "PATCH", body: JSON.stringify({ enabled }),
      });
      onSave(result);
    } catch {
      setError("Couldn’t update sharing. Check your public player page and report settings, then try again.");
    } finally {
      setBusy(false);
    }
  }
  return <Card title="Share stream report">
    <p className="text-caption text-text-muted">People with the link can see your totals, MMR change and matchup records. Viewer names, opponents and private clip notes stay private.</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {publication.enabled && publication.href ? <>
        <PlayerCopyButton path={publication.href} label="Copy public report link" />
        <Button size="sm" variant="secondary" className="min-h-11" loading={busy} onClick={() => void update(false)}>Turn off sharing</Button>
      </> : publication.eligible ? <Button size="sm" className="min-h-11" loading={busy} onClick={() => void update(true)}>Share report</Button>
        : <LinkButton href="/settings?tab=profile" variant="secondary" size="sm" className="min-h-11">Set up your public player page</LinkButton>}
    </div>
    {error ? <p role="alert" className="mt-2 text-caption text-danger">{error}</p> : null}
  </Card>;
}
