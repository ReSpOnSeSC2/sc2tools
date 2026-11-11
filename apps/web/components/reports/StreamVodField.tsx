"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { apiCall } from "@/lib/clientApi";

export function StreamVodField({ streamId, url, onSave }: { streamId: string; url: string | null; onSave: (value: string | null) => void }) {
  const { getToken } = useAuth();
  const [draft, setDraft] = useState(url || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function update(value: string | null) {
    setBusy(true);
    setError("");
    try {
      const result = await apiCall<{ vodUrl: string | null }>(getToken, `/v1/reports/streams/${encodeURIComponent(streamId)}/vod`, {
        method: "PUT", body: JSON.stringify({ url: value }),
      });
      setDraft(result.vodUrl || "");
      onSave(result.vodUrl);
    } catch {
      setError("Couldn’t save the recording. Use a Twitch or YouTube video link.");
    } finally {
      setBusy(false);
    }
  }

  return <form className="mt-3 space-y-2" onSubmit={(event) => { event.preventDefault(); void update(draft.trim()); }}>
    <Field label="Twitch or YouTube recording" hint="Clip timestamps open in this recording." error={error || undefined}>
      <Input type="url" autoComplete="off" spellCheck={false} maxLength={300} value={draft} onChange={(event) => setDraft(event.target.value)} />
    </Field>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" size="sm" className="min-h-11" disabled={busy || !draft.trim() || draft.trim() === url}>Save recording link</Button>
      {url ? <Button type="button" variant="secondary" size="sm" className="min-h-11" disabled={busy} onClick={() => void update(null)}>Remove recording link</Button> : null}
    </div>
  </form>;
}
