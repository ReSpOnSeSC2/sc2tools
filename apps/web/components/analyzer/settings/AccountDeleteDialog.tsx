"use client";

import { useState } from "react";
import { useAuth, useClerk } from "@clerk/nextjs";
import { forgetDeviceCopy } from "@/lib/analysisCorpus/deviceClear";
import { apiCall, useApi } from "@/lib/clientApi";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { BackupRetention } from "@/components/legal/BackupRetention";

type Inventory = { removed: Record<string, number>; anonymized: Record<string, number>; countedAt: string };
const LABELS: Record<string, string> = {
  games: "Games and analysis", archivedReplays: "Replay archive records", opponents: "Opponent records", notes: "Opponent notes",
  builds: "Custom builds", devices: "Paired devices", overlayTokens: "Overlay links", snapshots: "Private snapshots", sounds: "Stream sounds",
  publishedBuilds: "Published builds", reports: "Community reports", connectedAccounts: "Connected streaming accounts", notifications: "Notifications",
  reviewRequests: "Review requests", reviewThreadComments: "Comments on your review requests", playerChannels: "Player channel submissions",
  streamRows: "Stream Studio, viewer and prediction records", reviewComments: "Comments on other review requests", activityEvents: "Service activity records", auditRows: "Admin audit records",
};

export default function AccountDeleteDialog({ onClose, onExport }: { onClose: () => void; onExport: () => Promise<boolean> }) {
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  const [step, setStep] = useState(1);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleted, setDeleted] = useState(false);
  const inventory = useApi<Inventory>("/v1/me/data-inventory", { revalidateOnFocus: false });
  async function finish() {
    if (busy || (!deleted && typed !== "DELETE")) return;
    setBusy(true); setError("");
    let dataDeleted = deleted;
    try {
      // Once erasure succeeds, a failed sign-out must never retry deletion with
      // an already-deleted JWT. Keep a dedicated sign-out retry in the dialog.
      if (!deleted) {
        try { await apiCall(getToken, "/v1/me", { method: "DELETE" }); }
        catch (failure) {
          // A lost success response can leave us retrying with an erased JWT.
          // Only the explicit deletion guard proves this state; an ordinary
          // expired or invalid session still surfaces as a deletion failure.
          const error = failure as { status?: number; code?: string };
          if (error?.status !== 401 || error.code !== "account_deleted") throw failure;
        }
        setDeleted(true); dataDeleted = true;
        // The erased account's history leaves this device too, even if signing out fails.
        forgetDeviceCopy();
      }
      await signOut({ redirectUrl: "/goodbye" });
    } catch {
      setError(dataDeleted ? "Your data was deleted. Signing out failed; retry signing out." : "Could not finish. Your account may have been partially cleared; retry to complete deletion.");
    } finally { setBusy(false); }
  }
  return <Modal open onClose={() => { if (!busy && !deleted) onClose(); }} disableScrimClose={busy || deleted} hideClose={busy || deleted}
    title={deleted ? "Finish signing out" : "Delete your account"} description={`Step ${step} of 3`} size="md"
    footer={<>
      {!deleted ? <Button variant="secondary" disabled={busy} onClick={step === 1 ? onClose : () => { setStep(step - 1); setError(""); }}>{step === 1 ? "Cancel" : "Back"}</Button> : null}
      {step < 3 ? <Button disabled={busy || (step === 2 && !inventory.data)} onClick={() => { setStep(step + 1); setError(""); }}>Continue</Button>
        : <Button variant="danger" loading={busy} disabled={!deleted && typed !== "DELETE"} onClick={finish}>{deleted ? "Retry signing out" : "Delete account permanently"}</Button>}
    </>}>
    <div className="space-y-4">
      {step === 1 ? <>
        <h3 className="font-semibold">Download my data first</h3>
        <p className="text-body-sm">Keep a JSON export of your structured account data before you leave. Original replays download separately from replay history. An export is optional.</p>
        <Button variant="secondary" loading={busy} onClick={async () => { setBusy(true); try { await onExport(); } finally { setBusy(false); } }}>Download my data</Button>
        <p className="text-caption text-text-muted">Deletion also ends your sign-in account. Paired PCs and overlay links stop working.</p>
      </> : null}
      {step === 2 ? <>
        <h3 className="font-semibold">What happens to your data</h3>
        {!inventory.data ? <div role={inventory.error ? "alert" : "status"}>{inventory.error ? <><p>Couldn&apos;t load your data inventory.</p><Button variant="secondary" onClick={() => { void inventory.mutate(); }}>Retry inventory</Button></> : "Counting your data…"}</div> : <>
          <InventoryList title="Removed" counts={inventory.data.removed} />
          <InventoryList title="Anonymized" counts={inventory.data.anonymized} />
          <p className="text-caption text-text-muted">Comments you wrote on other people&apos;s review requests remain as [deleted user]. Your profile, preferences, coaching relationships and private files are removed. Counts may change before deletion.</p>
        </>}
        <BackupRetention />
      </> : null}
      {step === 3 ? <>
        <p>This permanently deletes your account and its live data. Your existing private snapshots are deleted too. Service backup copies expire under the backup schedule.</p>
        <label className="block space-y-2"><span>Type DELETE to confirm</span><Input value={typed} onChange={(event) => setTyped(event.target.value)} disabled={busy || deleted} autoComplete="off" spellCheck={false} /></label>
        <p className="text-caption text-text-muted">If the identity provider is unavailable, sign-in deletion is retried automatically. The deleted identity cannot reopen the account while that retry is pending.</p>
      </> : null}
      {error ? <p role="alert" className="text-danger">{error}</p> : null}
    </div>
  </Modal>;
}

function InventoryList({ title, counts }: { title: string; counts: Record<string, number> }) {
  return <section><h4 className="mb-2 font-semibold">{title}</h4><dl className="space-y-1 text-body-sm">{Object.entries(counts).map(([key, count]) => <div key={key} className="flex justify-between gap-3"><dt className="min-w-0">{LABELS[key] || key}</dt><dd className="shrink-0 tabular-nums">{count.toLocaleString()}</dd></div>)}</dl></section>;
}
