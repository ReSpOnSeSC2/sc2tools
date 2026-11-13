"use client";

import { useEffect, useState } from "react";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { Select } from "@/components/ui/Select";
import { SkeletonBar, SkeletonCard, SkeletonRegion } from "@/components/ui/Skeleton";
import { balanceTierKey, balanceTierLabel, selectBalanceTier, type BalanceBundle } from "@/lib/balance/bundle";
import { loadBalanceBundle } from "@/lib/balance/loadBundle";
import { BalanceMatchupCard } from "./BalanceMatchupCard";

const DATE = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" });
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const CARD_GRID = "grid gap-4 md:grid-cols-3";
type State = { kind: "loading" } | { kind: "ready"; bundle: BalanceBundle } | { kind: "unavailable" };

function LoadingBalance() {
  return (
    <SkeletonRegion label="Loading ladder balance snapshot" className="space-y-4">
      <SkeletonBar className="h-12 w-64 max-w-full" />
      <div className={CARD_GRID}>
        {Array.from({ length: 3 }, (_, index) => (
          <SkeletonCard key={index} className="space-y-3">
            <SkeletonBar className="h-6 w-32" />
            <SkeletonBar className="h-24 w-full" />
          </SkeletonCard>
        ))}
      </div>
    </SkeletonRegion>
  );
}

function CurrentBalance({ bundle }: { bundle: BalanceBundle }) {
  const [selected, setSelected] = useState("");
  const tier = selectBalanceTier(bundle, selected);
  if (!tier) return null;
  const snapshotDate = new Date(bundle.asOf);
  const stale = Date.now() - snapshotDate.valueOf() >= TWO_DAYS_MS;
  return (
    <section className="space-y-4" aria-labelledby="balance-tier-heading">
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-line bg-bg-surface p-4">
        <div>
          <p className="text-body font-semibold text-text">Season {bundle.season}</p>
          <p className="text-caption text-text-muted">Snapshot taken <time dateTime={bundle.asOf}>{DATE.format(snapshotDate)} UTC</time></p>
          {stale && <p className="text-caption text-text-muted">Showing the last complete snapshot.</p>}
        </div>
        <div className="w-full sm:w-52">
          <label htmlFor="balance-tier" className="mb-1 block text-caption font-semibold text-text">Ladder tier</label>
          <Select id="balance-tier" selectSize="lg" value={balanceTierKey(tier)} onChange={event => setSelected(event.target.value)}>
            {bundle.tiers.map(option => (
              <option key={balanceTierKey(option)} value={balanceTierKey(option)}>{balanceTierLabel(option)}</option>
            ))}
          </Select>
        </div>
      </div>
      <h2 id="balance-tier-heading" className="font-display text-h2 font-bold text-text">{balanceTierLabel(tier)} same-tier matchups</h2>
      <div className={CARD_GRID}>
        {tier.matchups.map(match => <BalanceMatchupCard key={match.matchup} {...match} />)}
      </div>
    </section>
  );
}

export function LadderBalance() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const request = new AbortController();
    loadBalanceBundle(request.signal).then(
      bundle => { if (!request.signal.aborted) setState({ kind: "ready", bundle }); },
      () => { if (!request.signal.aborted) setState({ kind: "unavailable" }); },
    );
    return () => request.abort();
  }, [attempt]);

  if (state.kind === "ready") return <CurrentBalance bundle={state.bundle} />;
  if (state.kind === "loading") return <LoadingBalance />;
  return (
    <div className="space-y-3 rounded-xl border border-line bg-bg-surface p-4">
      <p role="status" className="text-body text-text-muted">The ladder balance snapshot is unavailable. Try again to check for the latest data.</p>
      <button
        type="button"
        className={buttonClassName({ variant: "secondary" })}
        onClick={() => { setState({ kind: "loading" }); setAttempt(previous => previous + 1); }}
      >
        Retry snapshot
      </button>
    </div>
  );
}
