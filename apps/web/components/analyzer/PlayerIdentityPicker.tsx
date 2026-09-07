"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Search, UserRound } from "lucide-react";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

export type IdentityPlayer = {
  key: string;
  pulseId: string;
  pulseCharacterId?: string | null;
  toonHandle?: string | null;
  displayName: string;
  race?: string | null;
  region?: string | null;
};

type SearchResponse = { items: IdentityPlayer[]; nextCursor: string | null };

export function IdentityPlayerLabel({ player }: { player: IdentityPlayer }) {
  return <span className="block min-w-0 space-y-1">
    <span className="block break-words font-semibold text-text">{player.displayName || "Unnamed player"}</span>
    <span className="block text-caption text-text-muted">{[player.race, player.region].filter(Boolean).join(" · ") || "Race and region unavailable"}</span>
    <span className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-micro text-text-dim">{player.toonHandle ? <span className="break-all">{player.toonHandle}</span> : null}{player.pulseCharacterId ? <span className="break-all">Pulse {player.pulseCharacterId}</span> : null}{!player.toonHandle && !player.pulseCharacterId ? <span className="break-all">{player.pulseId}</span> : null}</span>
  </span>;
}

/** Search by stable identity; names are only labels, never mutation keys. */
export function PlayerIdentityPicker({ value, onChange, disabled = false, excludeKey, label = "Known player" }: {
  value: IdentityPlayer | null;
  onChange: (player: IdentityPlayer | null) => void;
  disabled?: boolean;
  excludeKey?: string;
  label?: string;
}) {
  const { getToken } = useAuth();
  const choiceName = useId();
  const resultsId = useId();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [editing, setEditing] = useState(!value);
  const previousSelection = useRef(value?.key);
  useEffect(() => {
    if (value && value.key !== previousSelection.current) setEditing(false);
    previousSelection.current = value?.key;
  }, [value]);
  const [pulseProfile, setPulseProfile] = useState("");
  const [pulseLoading, setPulseLoading] = useState(false);
  const [pulseError, setPulseError] = useState<string | null>(null);
  const [pulseCandidate, setPulseCandidate] = useState<IdentityPlayer | null>(null);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    const timer = window.setTimeout(() => { setSearch(query.trim()); setCursors([null]); }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);
  const active = editing && search.length >= 2 && query.trim() === search;
  const path = active ? `/v1/player-identities/search?q=${encodeURIComponent(search)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}` : null;
  const { data, error, isLoading, mutate } = useApi<SearchResponse>(path, { keepPreviousData: false });
  const items = (data?.items ?? []).filter((item) => item.key !== excludeKey);
  const searching = query.trim().length >= 2 && (query.trim() !== search || isLoading);

  async function lookupPulse() {
    if (disabled || pulseLoading || !pulseProfile.trim()) return;
    setPulseLoading(true); setPulseError(null); setPulseCandidate(null);
    try {
      const response = await apiCall<{ player: IdentityPlayer }>(getToken, "/v1/player-identities/pulse", { method: "POST", body: JSON.stringify({ profile: pulseProfile.trim() }) });
      if (response.player.key === excludeKey) setPulseError("Choose a different player account from the source barcode.");
      else setPulseCandidate(response.player);
    } catch (error) {
      setPulseError((error as { message?: string })?.message || "Couldn't look up this SC2Pulse player. Please try again.");
    } finally { setPulseLoading(false); }
  }

  if (!editing && value) return <div className="space-y-2">
    <p className="text-caption font-medium text-text">{label}</p>
    <div className="flex flex-col items-start gap-3 rounded-lg border border-accent/40 bg-accent/5 p-3 sm:flex-row sm:justify-between">
      <div className="flex min-w-0 flex-1 items-start gap-2"><UserRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden /><IdentityPlayerLabel player={value} /></div>
      <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditing(true)}>Choose another player</Button>
    </div>
  </div>;

  return <div className="space-y-3">
    <Field label={label} hint="Search by name, Pulse ID, or toon handle. Check the region and identity before selecting.">
      <Input type="search" value={query} maxLength={80} disabled={disabled} aria-controls={resultsId} placeholder="Search known players" onChange={(event) => setQuery(event.target.value)} />
    </Field>
    <div id={resultsId}>
      {query.trim().length < 2 ? <p className="inline-flex items-center gap-2 text-caption text-text-dim"><Search className="h-4 w-4" aria-hidden />Enter at least 2 characters to search.</p>
        : searching ? <p role="status" className="text-caption text-text-muted">Searching players…</p>
        : error ? <div className="space-y-2"><p role="alert" className="text-caption text-danger">Couldn&apos;t search players. {error.message}</p><Button variant="secondary" size="sm" onClick={() => void mutate()} disabled={disabled}>Retry search</Button></div>
        : active && !items.length ? <p role="status" className="text-caption text-text-muted">No matching players. Try a different name or stable identity.</p>
        : active ? <fieldset disabled={disabled} className="min-w-0">
          <legend className="sr-only">Search results for {search}</legend>
          <div className="max-h-72 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
            {items.map((item) => <label key={item.key} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:border-accent focus-within:ring-2 focus-within:ring-accent">
              <input type="radio" name={choiceName} checked={value?.key === item.key} className="mt-1 h-4 w-4 shrink-0 accent-accent" onChange={() => { onChange(item); setEditing(false); }} />
              <IdentityPlayerLabel player={item} />
            </label>)}
          </div>
        </fieldset> : null}
    </div>
    {active && !isLoading && !error && (cursors.length > 1 || data?.nextCursor) ? <nav aria-label="Player search pages" className="flex items-center justify-between gap-2">
      <Button size="sm" variant="ghost" disabled={disabled || cursors.length <= 1} onClick={() => setCursors((current) => current.slice(0, -1))}>Previous results</Button>
      <span className="text-micro text-text-dim">Page {cursors.length}</span>
      <Button size="sm" variant="ghost" disabled={disabled || !data?.nextCursor} onClick={() => { if (data?.nextCursor) setCursors((current) => [...current, data.nextCursor]); }}>Next results</Button>
    </nav> : null}
    <details className="rounded-lg border border-border bg-bg-elevated/20 p-3">
      <summary className="min-h-9 cursor-pointer py-1 text-caption font-semibold text-accent">Use a SC2Pulse profile that is not listed</summary>
      <div className="mt-3 space-y-3">
        <Field label="SC2Pulse profile URL or character ID" hint="Paste the character profile link from SC2Pulse, or its numeric character ID. The account will be verified before you can select it.">
          <Input value={pulseProfile} maxLength={500} disabled={disabled || pulseLoading} placeholder="SC2Pulse profile URL or character ID" onChange={(event) => { setPulseProfile(event.target.value); setPulseCandidate(null); setPulseError(null); }} />
        </Field>
        <Button variant="secondary" size="sm" loading={pulseLoading} disabled={disabled || !pulseProfile.trim()} onClick={() => void lookupPulse()}>Find SC2Pulse player</Button>
        {pulseError ? <p role="alert" className="text-caption text-danger">{pulseError}</p> : null}
        {pulseCandidate ? <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3"><IdentityPlayerLabel player={pulseCandidate} /><Button size="sm" disabled={disabled} onClick={() => { onChange(pulseCandidate); setEditing(false); }}>Select SC2Pulse player</Button></div> : null}
      </div>
    </details>
    {value ? <Button variant="ghost" size="sm" disabled={disabled} onClick={() => setEditing(false)}>Keep {value.displayName}</Button> : null}
  </div>;
}
