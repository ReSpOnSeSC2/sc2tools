"use client";
import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { RequestError } from "@/components/ui/RequestError";
import { STUDIO_ROOT, errorText, json, type Policy } from "./studioTypes";

interface History { items: Array<{ revision: number; hash: string; createdAt: string }>; nextBefore: number | null }
export function PolicyHistory({ onChanged }: { onChanged: () => void }) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false); const [before, setBefore] = useState<number | null>(null);
  const history = useApi<History>(open ? `${STUDIO_ROOT}/policy/history${before ? `?before=${before}` : ""}` : null);
  const [review, setReview] = useState<{ previous: Policy; current: Policy } | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const inspect = async (revision: number) => {
    setBusy(true); setError("");
    try {
      const [previous, current] = await Promise.all([apiCall<Policy>(getToken, `${STUDIO_ROOT}/policy/history/${revision}`), apiCall<Policy>(getToken, `${STUDIO_ROOT}/policy`)]);
      setReview({ previous, current });
    } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  const restore = async () => {
    if (!review) return; setBusy(true); setError("");
    try {
      const saved = await apiCall<Policy>(getToken, `${STUDIO_ROOT}/policy/revert`, { method: "POST", body: json({ expectedHash: review.current.hash, revision: review.previous.revision }) });
      setReview(null); setNotice(`Policy restored as new revision ${saved.revision}.`); void history.mutate(); onChanged();
    } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  return <section className="space-y-3">
    <Button variant="secondary" onClick={() => setOpen(value => !value)} aria-expanded={open}>Global preset policy history</Button>
    {notice ? <p role="status">{notice}</p> : null}{error ? <p role="alert">{error}</p> : null}
    {open ? <div className="space-y-2 rounded border border-border p-3"><p className="text-caption">Reverting restores the entire global preset policy as a new immutable revision. Custom and community definitions are independent.</p>
      <Button variant="secondary" disabled={busy} onClick={() => void inspect(0)}>Review bundled defaults (revision 0)</Button>
      {history.error ? <RequestError error={history.error} onRetry={() => void history.mutate()} /> : !history.data ? <p role="status">Loading policy history…</p> : <><ul className="space-y-2">{history.data.items.map(row => <li key={row.revision} className="flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-all text-caption">Revision {row.revision} · {new Date(row.createdAt).toLocaleString()} · {row.hash.slice(0, 12)}</span><Button variant="secondary" disabled={busy} onClick={() => void inspect(row.revision)}>Review revision {row.revision}</Button></li>)}</ul><div className="flex gap-2">{before ? <Button variant="secondary" onClick={() => setBefore(null)}>Latest revisions</Button> : null}{history.data.nextBefore ? <Button variant="secondary" onClick={() => setBefore(history.data!.nextBefore)}>Older revisions</Button> : null}</div></>}
    </div> : null}
    <Modal open={Boolean(review)} title={`Review global policy restore to revision ${review?.previous.revision}`} onClose={() => { if (!busy) setReview(null); }} size="xl" disableScrimClose={busy} footer={<><Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>Cancel</Button><Button loading={busy} onClick={() => void restore()}>Confirm global restore</Button></>}>
      <p>This affects all preset replacements shown below. It keeps immutable history and rejects a save if another admin changed the active hash.</p><div className="grid min-w-0 gap-3 md:grid-cols-2">{[["Current active policy", review?.current], ["Policy to restore", review?.previous]].map(([label, value]) => <div key={String(label)} className="min-w-0"><h3>{String(label)}</h3><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-elevated p-3 text-caption">{json(value)}</pre></div>)}</div>
    </Modal>
  </section>;
}
