"use client";

import type { StoryFight, StoryLoss } from "@/lib/gameStory";
import { formatGameClock } from "@/lib/macro";
import { humanizeBuildName } from "@/lib/build-events";
import styles from "./FightLedger.module.css";

type Props = { fights: readonly StoryFight[]; onSeek: (time: number) => void };
const number = (value: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
const tone = { won: "text-success", lost: "text-danger", even: "text-text-muted", unknown: "text-text-dim" };

export function FightLedger({ fights, onSeek }: Props) {
  if (!fights.length) return null;
  const estimated = fights.some(fight => fight.estimated);
  const watch = (fight: StoryFight) => <button type="button" onClick={() => onSeek(fight.start)}
    aria-label={`Watch fight at ${formatGameClock(fight.start)}`}
    className="inline-flex min-h-11 items-center justify-center rounded-md border border-accent/40 px-3 text-caption font-semibold text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Watch</button>;
  return <section aria-label="Fight ledger" className={`${styles.ledger} min-w-0 space-y-3`}>
    <div className="space-y-1">
      <h3 className="text-caption font-semibold">Fight ledger {estimated ? <span className="font-normal text-text-muted">· estimated</span> : null}</h3>
      <p className="text-micro text-text-muted">{estimated
        ? "Army-value drops estimate fight windows. Unit, mineral, gas and supply losses are not measured here."
        : "Deaths within 10 seconds of the previous death share a cluster. Duration spans its first to last recorded casualty."} A won trade means more opposing resources lost; it does not explain the game result.</p>
    </div>
    <div className={`${styles.table} max-w-full overflow-x-auto`} data-testid="fight-ledger-table">
      <table className="w-full text-left text-micro">
        <caption className="sr-only">Fight timing, losses and resource trade outcome</caption>
        <thead className="border-b border-border text-text-dim"><tr>
          {['Time', 'Duration', 'Your losses', 'Their losses', 'Outcome', 'Replay'].map(label => <th key={label} scope="col" className="px-1 py-2 align-bottom font-medium">{label}</th>)}
        </tr></thead>
        <tbody>{fights.map(fight => <tr key={fight.id} className="border-b border-border/60 last:border-0">
          <th scope="row" className="px-1 py-3 align-top font-mono font-normal tabular-nums">{formatGameClock(fight.start)}</th>
          <td className="px-1 py-3 align-top tabular-nums">{number(fight.duration)}s</td>
          <td className="max-w-40 px-1 py-3 align-top"><FightLoss loss={fight.me} estimated={fight.estimated} /></td>
          <td className="max-w-40 px-1 py-3 align-top"><FightLoss loss={fight.opp} estimated={fight.estimated} /></td>
          <td className={`max-w-36 px-1 py-3 align-top font-semibold ${tone[fight.outcome]}`}>{fight.label}</td>
          <td className="px-1 py-2 align-top">{watch(fight)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    <ol className={styles.cards} data-testid="fight-ledger-cards">{fights.map(fight => <li key={fight.id} className="min-w-0 space-y-3 rounded-lg border border-border bg-bg-elevated/50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-caption tabular-nums">{formatGameClock(fight.start)}{fight.end > fight.start ? `–${formatGameClock(fight.end)}` : ""}</span><span className="text-micro text-text-muted">{number(fight.duration)}s {fight.estimated ? "estimated window" : "recorded span"}</span></div>
      <dl className="grid min-w-0 grid-cols-2 gap-3">{[['Your losses', fight.me], ['Their losses', fight.opp]].map(([label, loss]) => <div key={label as string} className="min-w-0"><dt className="mb-1 text-micro text-text-dim">{label as string}</dt><dd><FightLoss loss={loss as StoryLoss} estimated={fight.estimated} /></dd></div>)}</dl>
      <div className="flex flex-wrap items-center justify-between gap-2"><span className={`min-w-0 break-words text-caption font-semibold ${tone[fight.outcome]}`}>{fight.label}</span>{watch(fight)}</div>
    </li>)}</ol>
  </section>;
}

function FightLoss({ loss, estimated }: { loss: StoryLoss; estimated: boolean }) {
  if (estimated) return <div className="space-y-1 text-micro"><p className="tabular-nums">{typeof loss.estimatedValue === "number" && Number.isFinite(loss.estimatedValue) ? `${number(loss.estimatedValue)} estimated resources` : "Resource loss unmeasured"}</p><p className="text-text-dim">Unit and supply detail unavailable</p></div>;
  return <div className="space-y-1 break-words text-micro">
    <p className="tabular-nums">{loss.unpriced ? "Known: " : ""}{number(loss.minerals)} minerals · {number(loss.gas)} gas</p>
    <p className="text-text-muted">{loss.supply === null ? "Supply unmeasured" : `${number(loss.supply)} supply`}{loss.unpriced ? ` · ${loss.unpriced} unpriced` : ""}</p>
    {loss.units.length ? <p className="text-text-dim">{loss.units.map(unit => `${unit.count} ${humanizeBuildName(unit.name)}`).join(" · ")}</p> : <p className="text-text-dim">No recorded losses</p>}
  </div>;
}
