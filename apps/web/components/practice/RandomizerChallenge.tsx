"use client";

import { useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useApi, type ClientApiError } from "@/lib/clientApi";
import { useUserSocket } from "@/lib/useUserSocket";
import { formatDate, formatDateTime, formatNumber } from "@/lib/i18n/format";
import { Button, LinkButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { QueryState } from "@/components/ui/QueryState";
import { RequestError } from "@/components/ui/RequestError";
import { Section } from "@/components/ui/Section";

const CHALLENGE_PATH = "/v1/build-intents/randomizer-stats";

type Pool = {
  matchup: string; enabled: boolean; builds: number; completed: number;
  rolled: number; playedAsRolled: number; wins: number; losses: number; lastPlayed: string | null;
};
type Challenge = { challengeStartedAt: string | null; pools: Pool[] };

export function RandomizerChallenge() {
  const { userId } = useAuth();
  return userId ? <ChallengeBody key={userId} /> : null;
}

function ChallengeBody() {
  const data = useApi<Challenge>(CHALLENGE_PATH);
  const [confirming, setConfirming] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  const [resetDone, setResetDone] = useState(false);
  useUserSocket({
    "games:changed": () => { void data.mutate(); },
    "build-intent:changed": (value) => {
      if (value && typeof value === "object" && "prefs" in value && value.prefs === true) void data.mutate();
    },
  });

  async function reset() {
    if (resetting) return;
    setResetting(true);
    setError(null);
    try {
      const result = await data.request<Pick<Challenge, "challengeStartedAt">>({ method: "POST" });
      setConfirming(false);
      setResetDone(true);
      void data.mutate((current) => current ? {
        ...result,
        pools: current.pools.filter((pool) => pool.builds > 0).map((pool) =>
          ({ ...pool, rolled: 0, playedAsRolled: 0, wins: 0, losses: 0, completed: 0, lastPlayed: null })),
      } : current, { revalidate: true });
    } catch (error) {
      if ((error as Error)?.name !== "AbortError") setError(error as ClientApiError);
    } finally { setResetting(false); }
  }

  const started = data.data?.challengeStartedAt;
  return <Section id="randomizer-challenge" className="scroll-mt-28" title="Randomizer challenge"
    description="Work through each matchup pool. A game counts as played as rolled when its confirmed check-in matches the saved draw."
    actions={data.data?.pools.length
      ? <Button variant="secondary" onClick={() => { setConfirming(true); setError(null); setResetDone(false); }}>Reset challenge</Button> : undefined}>
    <Card>
      {started ? <p className="mb-3 text-caption text-text-muted">Current challenge started {formatDateTime(started, { dateStyle: "medium", timeStyle: "short" })}.</p> : null}
      {resetDone ? <p role="status" className="mb-3 text-caption text-success">Challenge reset.</p> : null}
      <QueryState q={data} isEmpty={(value) => value.pools.length === 0}
        empty={<div className="space-y-2">
          <p className="text-body text-text-muted">Set up a matchup pool to start your challenge.</p>
          <LinkButton href="/settings?tab=randomizer#build-randomizer" variant="secondary" size="sm">Open randomizer settings</LinkButton>
        </div>}>
        {(value) => <ChallengeTable pools={value.pools} />}
      </QueryState>
    </Card>
    <ConfirmDialog open={confirming} loading={resetting} intent="danger" focusCancel
      title="Reset this challenge?"
      description="This starts the challenge from now. Your replays, check-ins and matchup pools stay saved."
      confirmLabel="Reset challenge" onClose={() => { if (!resetting) setConfirming(false); }} onConfirm={() => { void reset(); }}>
      {error ? <RequestError title="Challenge reset unavailable" error={error} /> : null}
    </ConfirmDialog>
  </Section>;
}

function ChallengeTable({ pools }: { pools: Pool[] }) {
  // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The named overflow region must accept keyboard scrolling.
  return <div className="max-w-full overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" tabIndex={0} role="region" aria-label="Randomizer challenge by matchup">
    <table className="w-full text-left text-caption">
      <caption className="sr-only">Randomizer challenge results</caption>
      <thead><tr className="border-b border-border">
        {["Matchup", "Rolled games", "Played as rolled", "W–L", "Pool completed", "Last played"].map((label) =>
          <th key={label} scope="col" className="px-2 py-2 font-semibold text-text-muted">{label}</th>)}
      </tr></thead>
      <tbody className="divide-y divide-border">
        {pools.map((pool) => <tr key={pool.matchup}>
          <th scope="row" className="px-2 py-2 font-semibold">{pool.matchup}</th>
          <td className="px-2 py-2 tabular-nums">{formatNumber(pool.rolled)}</td>
          <td className="px-2 py-2 tabular-nums">{formatNumber(pool.playedAsRolled)}</td>
          <td className="whitespace-nowrap px-2 py-2 tabular-nums">{formatNumber(pool.wins)}–{formatNumber(pool.losses)}</td>
          <td className="px-2 py-2 tabular-nums">{pool.builds ? formatNumber(pool.completed) + " / " + formatNumber(pool.builds) : "—"}</td>
          <td className="px-2 py-2">{pool.lastPlayed ? formatDate(new Date(pool.lastPlayed)) : "—"}</td>
        </tr>)}
      </tbody>
    </table>
  </div>;
}
