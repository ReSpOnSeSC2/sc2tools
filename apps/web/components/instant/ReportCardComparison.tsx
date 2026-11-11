"use client";

import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyRecoveryDialog } from "@/components/ui/CopyRecoveryDialog";
import { Input } from "@/components/ui/Input";
import {
  compareReportCards, reportCardFromLink, reportComparisonLink, type ReportComparison,
} from "@/lib/instant/reportCardLink";
import { REPORT_CARD_PATH } from "@/lib/instant/reportCardRoute";
import type { ReportCardModel } from "@/lib/instant/reportSharing";
import { useCopy } from "@/lib/useCopy";

function ComparisonSide({ label, record }: { label: string; record: ReportComparison["first"] }) {
  const { games, wins, losses } = record;
  const decided = wins + losses;
  return (
    <Card>
      <h3 className="font-display text-h4 text-text">{label}</h3>
      <dl className="mt-3 space-y-2 text-body tabular-nums text-text-muted">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3"><dt>Games</dt><dd>{games}</dd></div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3"><dt>Record</dt><dd>{wins}W {losses}L</dd></div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <dt>Win rate</dt><dd>{decided ? `${Math.round(wins / decided * 100)}%` : "No decided games"}</dd>
        </div>
      </dl>
    </Card>
  );
}

function CopyComparisonLink({ link }: { link: string }) {
  const scope = useMemo(() => ({ link }), [link]);
  const copy = useCopy({ scopeKey: scope });
  const button = useRef<HTMLButtonElement>(null);

  return (
    <div className="space-y-2">
      <Button ref={button} variant="secondary" aria-disabled={copy.pending} onClick={() => {
        if (!copy.pending) void copy.copy(link);
      }}>Copy comparison link</Button>
      <p role="status" className="text-body text-text-muted">
        {copy.status === "copied" ? "Comparison link copied." : copy.pending ? "Copying comparison link." : null}
      </p>
      <CopyRecoveryDialog text={copy.fallbackText} inputRef={copy.inputRef} triggerRef={button}
        scopeKey={scope} onDismiss={copy.clear} title="Copy comparison link manually" label="Comparison link" />
    </div>
  );
}

export function ReportCardComparison({ model, ownComparison = false }: { model: ReportComparison; ownComparison?: boolean }) {
  const link = reportComparisonLink(model);
  return (
    <div className="space-y-4">
      <h2 className="font-display text-h2 text-text">{ownComparison ? "You versus them" : "Side-by-side results"}</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <ComparisonSide label={ownComparison ? "Your report" : "Report A"} record={model.first} />
        <ComparisonSide label={ownComparison ? "Their report" : "Report B"} record={model.second} />
      </div>
      <p className="text-body text-text-muted">Each report covers its sharer’s selected games. Win rates use games with a recorded win or loss.</p>
      {link ? <CopyComparisonLink link={link} /> : null}
    </div>
  );
}

export function ReportComparisonBuilder({ shared }: { shared: ReportCardModel }) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const result = useRef<HTMLElement>(null);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [comparison, setComparison] = useState<ReportComparison | null>(null);
  const descriptionId = `${inputId}-description`;
  const errorId = `${inputId}-error`;

  useEffect(() => { if (comparison) result.current?.focus(); }, [comparison]);

  function compare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const own = reportCardFromLink(value);
    const next = own ? compareReportCards(own, shared) : null;
    setComparison(next);
    setInvalid(!next);
    if (!next) input.current?.focus();
  }

  if (!shared.totals?.games) return <p className="text-body text-text-muted">A comparison needs game totals in both links.</p>;
  return (
    <div className="space-y-4">
      <form action={REPORT_CARD_PATH} onSubmit={compare} className="space-y-3 rounded-lg border border-line bg-bg-surface p-4">
        <h2 className="font-display text-h2 text-text">Compare with your report</h2>
        <label htmlFor={inputId} className="block font-semibold text-text">Your replay report link</label>
        <p id={descriptionId} className="text-body text-text-muted">Copy a card link with Totals selected in browser replay analysis.</p>
        <Input id={inputId} ref={input} inputSize="lg" autoComplete="off" spellCheck={false}
          aria-describedby={invalid ? `${descriptionId} ${errorId}` : descriptionId} invalid={invalid}
          value={value} onChange={event => { setValue(event.target.value); setInvalid(false); setComparison(null); }} />
        {invalid ? <p id={errorId} role="alert" className="text-body text-danger">Paste a replay report card link that includes game totals.</p> : null}
        <Button type="submit">Compare reports</Button>
      </form>
      {comparison ? (
        <section ref={result} tabIndex={-1} aria-label="Replay report comparison" className="rounded-lg">
          <ReportCardComparison model={comparison} ownComparison />
        </section>
      ) : null}
    </div>
  );
}
