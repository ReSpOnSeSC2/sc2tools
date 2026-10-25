"use client";
import { useApi } from "@/lib/clientApi";
import { useRivals } from "@/lib/useRivals";
import { RivalStar } from "./RivalStar";

export function DossierRivalStar({ pulseId, name }: { pulseId: string; name: string }) {
  const rivals = useRivals();
  const identity = useApi<{ keys: string[] }>(`/v1/opponents/${encodeURIComponent(pulseId)}/rival-key`, { revalidateOnFocus: false });
  const keys = identity.isPreviousData ? [] : identity.data?.keys || [];
  return <span className="inline-flex flex-wrap items-center gap-2"><RivalStar name={name} starred={keys.some(key => rivals.keys.includes(key))} disabled={rivals.loading || rivals.saving || rivals.unavailable || !!identity.error || identity.isLoading || !keys.length} onToggle={() => { void rivals.toggle(keys); }} />{rivals.error ? <span role="alert" className="max-w-64 text-caption text-warning">{rivals.error}</span> : null}</span>;
}
