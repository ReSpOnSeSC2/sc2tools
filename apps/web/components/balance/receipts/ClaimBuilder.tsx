"use client";

import { useEffect, useState } from "react";
import { BalanceCardActions } from "@/components/balance/BalanceCardActions";
import { buttonClassName } from "@/components/ui/buttonStyles";
import { Select } from "@/components/ui/Select";
import { BALANCE_MATCHUPS } from "@/lib/balance/bundle";
import { BALANCE_RACE_NAMES, cohortOptions, getBalanceCohort, SC2PULSE_URL, type BalanceEvidence, type BalancePin } from "@/lib/balance/evidence";
import {
  claimPath, DEFAULT_CLAIM, MATCHUP_SIDES, matchupTitle, opponentFor, parseMatchup, readClaimFragment, type ClaimSelection,
} from "./selection";
import { EvidenceLoading, EvidenceNotice } from "./EvidenceState";
import { useEvidence } from "./useEvidence";

const PERCENT = new Intl.NumberFormat("en", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 2 });
const COUNT = new Intl.NumberFormat("en");
const LABEL = "mb-1 block text-caption font-semibold text-text";
const CLAIM_IDS = { matchup: "claim-matchup", race: "claim-race", cohort: "claim-cohort", map: "claim-map" };
type Initial = "loading" | "latest" | "invalid" | NonNullable<ReturnType<typeof readClaimFragment>>;

function verdict(low: number, high: number): string {
  if (low > 0.5) return "Advantage supported";
  if (high < 0.5) return "Opposite advantage supported";
  return "Too close to call";
}

function ClaimReceipt({ selection, bundle }: { selection: ClaimSelection; bundle: BalanceEvidence }) {
  const race = BALANCE_RACE_NAMES[selection.race];
  const opponent = opponentFor(selection);
  const cohort = getBalanceCohort(bundle, selection.cohort, selection.race, opponent, selection.mapId);
  const map = bundle.maps.find(candidate => candidate.id === selection.mapId);
  if (!cohort || cohort.winRate === null || !cohort.interval) {
    return <EvidenceNotice>{selection.mapId !== undefined && !map ? "This map is missing from the pinned snapshot." : "There are no same-tier games for this claim in the selected snapshot."}</EvidenceNotice>;
  }

  const result = verdict(cohort.interval.low, cohort.interval.high);
  const rate = PERCENT.format(cohort.winRate);
  const interval = `${PERCENT.format(cohort.interval.low)}–${PERCENT.format(cohort.interval.high)}`;
  const games = COUNT.format(cohort.games);
  const cohortLabel = cohortOptions(bundle).find(option => option.value === selection.cohort)?.label ?? selection.cohort;
  const context = `${cohortLabel} · ${map?.name ?? "All maps"}`;
  const snapshot = `Season ${bundle.season} · ${bundle.asOf} UTC`;
  const description = `Claimed advantage for ${race} over ${BALANCE_RACE_NAMES[opponent]}`;

  return (
    <article className="space-y-4 rounded-xl border-2 border-line bg-bg-surface p-4 sm:p-6" aria-labelledby="balance-receipt-heading">
      <header className="space-y-1">
        <h2 id="balance-receipt-heading" className="font-display text-h2 font-bold text-text">{result}</h2>
        <p className="text-body text-text">{description}.</p>
        <p className="break-words text-caption text-text-muted">{context}</p>
      </header>
      <dl className="grid grid-cols-2 gap-3 text-caption text-text-muted sm:grid-cols-3">
        <div><dt>{race} win rate</dt><dd className="text-h3 font-bold tabular-nums text-text">{rate}</dd></div>
        <div><dt>Same-tier games</dt><dd className="text-h3 font-bold tabular-nums text-text">{games}</dd></div>
        <div className="col-span-2 sm:col-span-1"><dt>{cohort.confidence}% Wilson interval</dt><dd className="text-h3 font-bold tabular-nums text-text">{interval}</dd></div>
      </dl>
      <p className="text-caption text-text-muted">Season {bundle.season} · <time dateTime={bundle.asOf}>{bundle.asOf}</time> UTC · <a className="inline-flex min-h-11 items-center rounded-sm font-semibold text-accent underline focus-visible:ring-2 focus-visible:ring-accent" href={SC2PULSE_URL}>SC2Pulse API</a></p>
      <BalanceCardActions
        kind="receipt"
        title={result}
        lines={[description, context, `${race} win rate ${rate} · ${games} same-tier games`, `${cohort.confidence}% Wilson interval ${interval}`, snapshot]}
        sharePath={claimPath(bundle, selection)}
      />
    </article>
  );
}

function ClaimForm({ bundle, initial, pin, useLatest }: { bundle: BalanceEvidence; initial?: ClaimSelection; pin?: BalancePin; useLatest: () => void }) {
  const [draft, setDraft] = useState(initial ?? DEFAULT_CLAIM);
  const [checked, setChecked] = useState(initial);
  const options = cohortOptions(bundle);

  return (
    <div className="space-y-5">
      <form className="space-y-4 rounded-xl border border-line bg-bg-surface p-4 sm:p-6" onSubmit={event => {
        event.preventDefault();
        setChecked(draft);
        window.history.replaceState(window.history.state, "", claimPath(bundle, draft));
      }}>
        <h2 className="font-display text-h2 font-bold text-text">Build a claim</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={CLAIM_IDS.matchup} className={LABEL}>Matchup</label>
            <Select id={CLAIM_IDS.matchup} selectSize="lg" value={draft.matchup} onChange={event => {
              const matchup = parseMatchup(event.target.value.toLowerCase());
              if (matchup) setDraft({ ...draft, matchup, race: MATCHUP_SIDES[matchup][0] });
            }}>
              {BALANCE_MATCHUPS.map(matchup => <option key={matchup} value={matchup}>{matchupTitle(matchup)}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor={CLAIM_IDS.race} className={LABEL}>Race you think has the advantage</label>
            <Select id={CLAIM_IDS.race} selectSize="lg" value={draft.race} onChange={event => {
              const race = MATCHUP_SIDES[draft.matchup].find(side => side === event.target.value);
              if (race) setDraft({ ...draft, race });
            }}>
              {MATCHUP_SIDES[draft.matchup].map(race => <option key={race} value={race}>{BALANCE_RACE_NAMES[race]}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor={CLAIM_IDS.cohort} className={LABEL}>League or tier</label>
            <Select id={CLAIM_IDS.cohort} selectSize="lg" value={draft.cohort} onChange={event => setDraft({ ...draft, cohort: event.target.value })}>
              {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Select>
          </div>
          <div>
            <label htmlFor={CLAIM_IDS.map} className={LABEL}>Map</label>
            <Select id={CLAIM_IDS.map} selectSize="lg" value={draft.mapId ?? ""} onChange={event => setDraft({ ...draft, mapId: event.target.value ? Number(event.target.value) : undefined })}>
              <option value="">All maps</option>
              {draft.mapId !== undefined && !bundle.maps.some(map => map.id === draft.mapId) && <option value={draft.mapId}>Map unavailable</option>}
              {bundle.maps.map(map => <option key={map.id} value={map.id}>{map.name}</option>)}
            </Select>
          </div>
        </div>
        <p className="max-w-prose text-caption text-text-muted">Claims use same-tier games tracked in the Americas, Europe, and Korea. A map filter uses a wider 99% interval. An advantage is supported when the entire interval sits above 50%.</p>
        <div className="flex flex-wrap gap-3">
          <button type="submit" className={buttonClassName()}>Check claim</button>
          {pin && <button type="button" className={buttonClassName({ variant: "secondary" })} onClick={useLatest}>Use latest snapshot</button>}
        </div>
      </form>
      <div aria-live="polite">{checked && <ClaimReceipt selection={checked} bundle={bundle} />}</div>
    </div>
  );
}

export function ClaimBuilder() {
  const [initial, setInitial] = useState<Initial>("loading");
  useEffect(() => {
    const readHash = () => setInitial(window.location.hash ? readClaimFragment(window.location.hash) ?? "invalid" : "latest");
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, []);

  const pin = typeof initial === "object" ? initial.pin : undefined;
  const enabled = initial !== "loading" && initial !== "invalid";
  const { value, retry } = useEvidence(pin, enabled);
  const useLatest = () => {
    window.history.replaceState(window.history.state, "", "/balance/claim");
    setInitial("latest");
  };

  if (initial === "invalid") return <EvidenceNotice reset={useLatest}>This receipt link is incomplete or invalid.</EvidenceNotice>;
  if (!enabled || value.kind === "loading") return <EvidenceLoading />;
  if (value.kind === "unavailable") {
    return <EvidenceNotice retry={retry} reset={pin ? useLatest : undefined}>{pin ? "This pinned snapshot is unavailable." : "The latest ladder evidence is unavailable."}</EvidenceNotice>;
  }

  const selection = typeof initial === "object" ? initial.selection : undefined;
  return <ClaimForm key={pin && selection ? claimPath(pin, selection) : "latest"} bundle={value.bundle} initial={selection} pin={pin} useLatest={useLatest} />;
}
