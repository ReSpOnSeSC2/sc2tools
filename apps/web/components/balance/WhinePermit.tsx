"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { BALANCE_RACE_NAMES, cohortOptions, loadBalanceEvidence, type BalanceEvidence, type BalanceRace } from "@/lib/balance/evidence";
import { evaluatePermit, MAX_PERMIT_GAMES, parsePermitNumber } from "@/lib/balance/permit";
import { PermitCard } from "./PermitCard";

const RACES: BalanceRace[] = ["P", "T", "Z"];
type Fields = Record<BalanceRace, { wins: string; losses: string }>;
const EMPTY: Fields = { P: { wins: "", losses: "" }, T: { wins: "", losses: "" }, Z: { wins: "", losses: "" } };
const INPUT = "w-full min-h-12 rounded-lg border-2 border-line bg-bg-surface px-3 text-body text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/40";
const LABEL = "block text-caption font-semibold text-text";

function PermitForm({ evidence }: { evidence: BalanceEvidence }) {
  const options = cohortOptions(evidence);
  const [race, setRace] = useState<BalanceRace>("P");
  const [cohort, setCohort] = useState("diamond-1");
  const [fields, setFields] = useState(EMPTY);
  const [submitted, setSubmitted] = useState(false);
  const [message, setMessage] = useState("");
  const opponents = RACES.filter(candidate => candidate !== race);
  const rows = opponents.map(opponent => {
    const { wins, losses } = fields[opponent];
    const played = wins !== "" || losses !== "";
    return { opponent, wins: parsePermitNumber(wins || "0"), losses: parsePermitNumber(losses || "0"), played };
  }).filter(row => row.played);
  const label = options.find(option => option.value === cohort)?.label ?? "";

  function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rows.length) {
      setMessage("Enter a win or loss against at least one race.");
      setSubmitted(false);
    } else if (rows.some(row => row.wins === null || row.losses === null || row.wins + row.losses < 1 || row.wins + row.losses > MAX_PERMIT_GAMES)) {
      setMessage("Enter whole numbers with 1 to 100,000 total games per matchup.");
      setSubmitted(false);
    } else {
      setMessage("");
      setSubmitted(true);
    }
  }

  return (
    <>
      <form onSubmit={issue} onChange={() => { setSubmitted(false); setMessage(""); }} className="space-y-4 rounded-xl border border-line bg-bg-surface p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1"><span className={LABEL}>Your race</span><Select selectSize="lg" value={race} onChange={event => { setRace(event.target.value as BalanceRace); setFields(EMPTY); }}>
            {RACES.map(key => <option key={key} value={key}>{BALANCE_RACE_NAMES[key]}</option>)}
          </Select></label>
          <label className="space-y-1"><span className={LABEL}>Ladder tier or league</span><Select selectSize="lg" value={cohort} onChange={event => setCohort(event.target.value)}>
            {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </Select></label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {opponents.map(opponent => (
            <fieldset key={opponent} className="min-w-0 rounded-lg border border-line p-3">
              <legend className="px-1 font-semibold text-text">vs {BALANCE_RACE_NAMES[opponent]}</legend>
              <div className="grid grid-cols-2 gap-2">
                {(["wins", "losses"] as const).map(field => (
                  <label key={field} className="space-y-1">
                    <span className={LABEL}>{field === "wins" ? "Wins" : "Losses"}</span>
                    <input inputMode="numeric" name={`${opponent}-${field}`} maxLength={6} autoComplete="off" className={INPUT} value={fields[opponent][field]}
                      onChange={event => { const value = event.target.value; setFields(previous => ({ ...previous, [opponent]: { ...previous[opponent], [field]: value } })); }} />
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <Button size="lg" type="submit">Issue permit</Button>
        {message && <p role="alert" className="text-body text-text">{message}</p>}
      </form>
      {submitted && <section className="space-y-3" aria-labelledby="permit-results">
        <h2 id="permit-results" className="font-display text-h2 font-bold text-text">Your permit results</h2>
        {rows.map(({ opponent, wins, losses }) => {
          if (wins === null || losses === null) return null;
          const result = evaluatePermit(evidence, cohort, race, opponent, wins, losses);
          return result ? <PermitCard key={opponent} evidence={evidence} race={race} opponent={opponent} cohort={label} wins={wins} losses={losses} result={result} />
            : <p key={opponent} className="text-body text-text-muted">No ladder sample for {BALANCE_RACE_NAMES[race]} vs {BALANCE_RACE_NAMES[opponent]} in {label}.</p>;
        })}
      </section>}
    </>
  );
}

export function WhinePermit() {
  const [evidence, setEvidence] = useState<BalanceEvidence | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    loadBalanceEvidence(undefined, controller.signal).then(
      data => { if (!controller.signal.aborted) setEvidence(data); },
      () => { if (!controller.signal.aborted) setFailed(true); },
    );
    return () => controller.abort();
  }, [attempt]);
  if (evidence) return <PermitForm evidence={evidence} />;
  if (failed) return <div className="space-y-2">
    <p role="status" className="text-body text-text-muted">Ladder evidence is temporarily unavailable.</p>
    <Button variant="secondary" size="lg" onClick={() => { setFailed(false); setAttempt(value => value + 1); }}>Retry</Button>
  </div>;
  return <p role="status" className="text-body text-text-muted">Loading ladder evidence…</p>;
}
