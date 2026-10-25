"use client";

import { useRef } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi } from "@/lib/clientApi";
import { accountFilter, accountHandles, accountLabel, gameAccounts, MAX_FILTER_ACCOUNTS } from "@/lib/accountFilter";
import { useFilters } from "@/lib/filterContext";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";

export function AccountFilterPicker() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  return isLoaded && isSignedIn && userId ? <OwnerAccounts key={userId} /> : null;
}

function OwnerAccounts() {
  const { filters, setFilters, dbRev } = useFilters();
  const response = useApi<{ items: unknown[] }>(`/v1/game-accounts#${dbRev}`, { keepPreviousData: false, revalidateOnFocus: false });
  const details = useRef<HTMLDetailsElement>(null);
  const active = accountHandles(filters.accounts);
  const accounts = gameAccounts(response.isPreviousData ? undefined : response.data?.items);
  // A selected handle remains clearable if its label drops out of the bounded
  // account catalog, including after a hide/delete or a temporary API error.
  const choices = [...accounts, ...active.filter(handle => !accounts.some(row => row.handle === handle)).map(handle => ({ handle, label: handle, region: "", leagueId: null, mmr: null }))];
  if (choices.length <= 1 && !active.length && !response.error) return null;
  const toggle = (handle: string) => {
    const next = active.includes(handle) ? active.filter(value => value !== handle) : [...active, handle];
    setFilters({ ...filters, accounts: next.length ? accountFilter(next) : undefined });
  };
  return <details ref={details} className="min-w-0 w-full max-w-full" onKeyDown={event => {
    if (event.key === "Escape" && details.current?.open) { details.current.open = false; details.current.querySelector("summary")?.focus(); }
  }}>
    <summary className="min-h-11 cursor-pointer rounded-lg border-2 border-line bg-bg-surface px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      Account · {active.length ? `${active.length} selected` : "All accounts"}
    </summary>
    <div className="mt-2 min-w-0 max-w-full rounded-lg border border-border bg-bg-surface p-3">
      <fieldset className="max-h-72 min-w-0 overflow-y-auto"><legend className="mb-2 font-semibold">Your accounts</legend>
        <button type="button" className="mb-2 min-h-11 px-2 text-accent underline" onClick={() => setFilters({ ...filters, accounts: undefined })}>All accounts</button>
        {choices.map(account => <label key={account.handle} className="flex min-h-11 cursor-pointer items-center gap-3 rounded p-2 hover:bg-bg-elevated">
          <input type="checkbox" checked={active.includes(account.handle)} disabled={!active.includes(account.handle) && active.length >= MAX_FILTER_ACCOUNTS} onChange={() => toggle(account.handle)} className="h-4 w-4 shrink-0 accent-accent" />
          <span className="min-w-0 break-words text-caption"><span className="block">{accountLabel(account)}</span><span className="text-micro text-text-dim">{account.handle}{account.mmr !== null ? ` · ${account.mmr} MMR` : ""}</span></span>
        </label>)}
      </fieldset>
      {response.error ? <p role="status" className="text-caption text-text-muted">Account labels are unavailable. <button type="button" className="min-h-11 px-2 text-accent underline" onClick={() => { void response.mutate(); }}>Retry</button></p> : null}
      <p className="mt-2 text-micro text-text-dim">Clear the selection to include every account. Other filters still apply.</p>
      <LazyHelpLink slug="filter-by-account">About account filters</LazyHelpLink>
    </div>
  </details>;
}
