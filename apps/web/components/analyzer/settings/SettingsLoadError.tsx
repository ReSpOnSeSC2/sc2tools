"use client";

import { useState } from "react";
import { RequestError } from "@/components/ui/RequestError";
import { Button } from "@/components/ui/Button";

/** Failed reads never expose a blank settings form as if it were saved data. */
export function SettingsLoadError({ tab, error, retry }: { tab: string; error: unknown; retry: () => unknown }) {
  const [busy, setBusy] = useState(false);
  async function again() {
    if (busy) return;
    setBusy(true);
    try { await retry(); } catch { /* The query keeps the failure visible. */ }
    finally { setBusy(false); }
  }
  return <div className="space-y-3"><RequestError error={error} title={`Couldn't load your ${tab}`} />
    <p className="text-caption text-text-muted">Your saved settings haven&apos;t changed.</p>
    <Button variant="secondary" aria-busy={busy} onClick={() => void again()}>Try again</Button>
  </div>;
}
