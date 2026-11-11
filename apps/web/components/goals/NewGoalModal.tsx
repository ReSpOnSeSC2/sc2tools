"use client";

import { useMemo, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { RequestError } from "@/components/ui/RequestError";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { BuildPicker } from "@/components/build-checkin/BuildPicker";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { useBuildOptions } from "@/lib/buildIntent";
import { currentPool } from "@/lib/currentMapPool";
import { clientTimezone, todayKeyIn } from "@/lib/timeseries";
import { rollUpSeasons, useSeasons } from "@/lib/useSeasons";
import {
  GOAL_MIN_GAMES,
  GOAL_TEMPLATES,
  MATCHUPS,
  RECURRENCE_LABELS,
  defaultWindow,
  previewLabel,
  recurrencesFor,
  seasonWindow,
  type GoalBuild,
  type GoalInput,
  type GoalRecurrence,
  type GoalsResponse,
  type GoalTemplate,
} from "@/lib/goals";

const HELP_CLASS = "space-y-1 rounded-lg border border-border bg-bg-elevated p-3 text-caption text-text-muted";

/**
 * New goal: pick a template, then its target, scope and window. Inline help
 * covers the three things players ask about — how windows reset, why a rate
 * waits for a minimum number of games, and which games count.
 */
export function NewGoalModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (data: GoalsResponse) => void;
}) {
  return open ? <NewGoalForm onClose={onClose} onCreated={onCreated} /> : null;
}

function NewGoalForm({ onClose, onCreated }: { onClose: () => void; onCreated: (data: GoalsResponse) => void }) {
  const { getToken } = useAuth();
  const tz = useMemo(() => clientTimezone(), []);
  const today = useMemo(() => todayKeyIn(tz), [tz]);
  const seasons = useSeasons();
  const seasonList = useMemo(() => rollUpSeasons(seasons.data?.items).filter((s) => s.start).slice(0, 3), [seasons.data]);
  const pool = currentPool(seasons.data).maps;
  const [templateId, setTemplateId] = useState<string>(GOAL_TEMPLATES[0].id);
  const template = GOAL_TEMPLATES.find((t) => t.id === templateId) ?? GOAL_TEMPLATES[0];
  const [target, setTarget] = useState<string>(String(template.target));
  const [minGames, setMinGames] = useState<string>("");
  const [matchup, setMatchup] = useState<string>("");
  const [ranked, setRanked] = useState(true);
  const [map, setMap] = useState("");
  const [recurrence, setRecurrence] = useState<GoalRecurrence>(template.recurrence);
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);
  const [dates, setDates] = useState(() => defaultWindow(template.recurrence === "season" ? "once" : template.recurrence, today));
  const [build, setBuild] = useState<GoalBuild | null>(null);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ClientApiError | null>(null);
  const practice = template.type === "build_reps";
  const rated = template.type === "mmr_reach";
  const options = useBuildOptions(matchup || null);

  const season = seasonList.find((s) => s.number === seasonNumber) ?? seasonList.find((s) => s.isCurrent) ?? seasonList[0] ?? null;
  const minRule = GOAL_MIN_GAMES[template.type];

  function chooseTemplate(next: GoalTemplate) {
    setTemplateId(next.id);
    setTarget(String(next.target));
    setMinGames("");
    setRecurrence(next.recurrence);
    if (next.recurrence !== "season") setDates(defaultWindow(next.recurrence, today));
    setError(null);
  }

  function chooseRecurrence(next: GoalRecurrence) {
    setRecurrence(next);
    if (next !== "season") setDates(defaultWindow(next, today));
  }

  const goalWindow = recurrence === "season" && season
    ? { recurrence, ...seasonWindow(season.start as string, season.end, tz), tz, season: season.number }
    : { recurrence, ...dates, tz, season: null };
  const input: GoalInput = {
    type: template.type,
    params: {
      target: Number(target),
      ...(minRule ? { minGames: minGames === "" ? minRule.fallback : Number(minGames) } : {}),
      ...(practice && build ? { build } : {}),
    },
    filters: { matchup: matchup || null, map: rated ? null : map || null, ranked: rated || ranked, ...(!practice && build ? { build } : {}) },
    window: goalWindow,
    title: title.trim() || null,
  };
  const problem = !Number.isFinite(input.params.target) || input.params.target < template.min || input.params.target > template.max
    ? `Choose a target from ${template.min} to ${template.max}.`
    : template.type === "build_reps" && (!matchup || !build) ? "Choose a matchup and a build."
      : recurrence === "season" && !season ? "The season list hasn't loaded yet."
        : minRule && minGames !== "" && (!Number.isInteger(Number(minGames)) || Number(minGames) < minRule.floor)
          ? `Count from at least ${minRule.floor} games.` : null;

  async function submit() {
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    try {
      const data = await apiCall<GoalsResponse>(getToken, "/v1/goals", { method: "POST", body: JSON.stringify(input) });
      onCreated(data);
      onClose();
    } catch (cause) {
      setError(cause as ClientApiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="New goal"
      description="Progress fills in automatically from your replays."
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void submit()} loading={saving} disabled={!!problem}>Create goal</Button>
        </div>
      }
    >
      <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <fieldset className="space-y-2">
          <legend className="text-caption font-medium text-text">Template</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {GOAL_TEMPLATES.map((option) => (
              <label key={option.id} className={`flex min-h-11 cursor-pointer gap-2 rounded-lg border p-3 focus-within:ring-2 focus-within:ring-accent ${option.id === template.id ? "border-accent bg-accent/10" : "border-border"}`}>
                <input type="radio" name="goal-template" value={option.id} checked={option.id === template.id} onChange={() => chooseTemplate(option)} className="mt-1" />
                <span className="min-w-0 text-body font-medium text-text">
                  {option.title}
                  <span className="block text-caption font-normal text-text-muted">{option.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`Target (${template.unit})`}>
            <Input type="number" inputMode="decimal" min={template.min} max={template.max} step={template.step} value={target} onChange={(event) => setTarget(event.target.value)} />
          </Field>
          {minRule ? (
            <Field label="Count from" hint={`At least ${minRule.floor} games; ${minRule.fallback} if left empty.`}>
              <Input type="number" inputMode="numeric" min={minRule.floor} max={500} step={1} placeholder={String(minRule.fallback)} value={minGames} onChange={(event) => setMinGames(event.target.value)} />
            </Field>
          ) : null}
          <Field label="Matchup" hint={template.type === "build_reps" ? "Required for a build." : undefined}>
            <Select value={matchup} onChange={(event) => { setMatchup(event.target.value); setBuild(null); }}>
              <option value="">Any matchup</option>
              {MATCHUPS.map((mu) => <option key={mu} value={mu}>{mu}</option>)}
            </Select>
          </Field>
          {template.type !== "mmr_reach" ? (
            <Field label="Map">
              <Select value={map} onChange={(event) => setMap(event.target.value)}>
                <option value="">Any map</option>
                {pool.map((name) => <option key={name} value={name}>{name}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label="Repeats">
            <Select value={recurrence} onChange={(event) => chooseRecurrence(event.target.value as GoalRecurrence)}>
              {recurrencesFor(template.type).map((value) => <option key={value} value={value}>{RECURRENCE_LABELS[value]}</option>)}
            </Select>
          </Field>
          {recurrence === "season" ? (
            <Field label="Season">
              <Select value={season ? String(season.number) : ""} onChange={(event) => setSeasonNumber(Number(event.target.value))} disabled={seasonList.length === 0}>
                {seasonList.length === 0 ? <option value="">Loading seasons…</option> : null}
                {seasonList.map((s) => <option key={s.number} value={s.number}>Season {s.number}{s.isCurrent ? " (current)" : ""}</option>)}
              </Select>
            </Field>
          ) : (
            <>
              <Field label="From">
                <Input type="date" value={dates.startsOn} onChange={(event) => setDates((d) => ({ ...d, startsOn: event.target.value }))} />
              </Field>
              <Field label="Until (inclusive)">
                <Input type="date" value={dates.endsOn} min={dates.startsOn} onChange={(event) => setDates((d) => ({ ...d, endsOn: event.target.value }))} />
              </Field>
            </>
          )}
        </div>

        <label className="flex min-h-11 items-center gap-2 text-body text-text">
          <input type="checkbox" checked={rated || ranked} disabled={rated} onChange={(event) => setRanked(event.target.checked)} />
          Ranked 1v1 only
        </label>

        {matchup ? (
          <div className="space-y-2">
            <BuildPicker
              options={options.data?.builds}
              loading={!options.data && options.isLoading}
              error={!options.data && options.error ? "The build list couldn't load." : null}
              onRetry={() => void options.mutate()}
              value={build?.key ?? null}
              onChange={(option) => setBuild({ key: option.key, name: option.name, slug: option.slug, source: option.source })}
              usualKey={options.data?.usualKey ?? null}
              label={practice ? "Build to practise" : "Build filter (optional)"}
            />
            {!practice && build ? <Button variant="ghost" size="sm" onClick={() => setBuild(null)}>Clear build filter</Button> : null}
          </div>
        ) : practice ? <p className="text-caption text-text-muted">Choose a matchup to pick the build.</p> : null}

        <Field label="Name (optional)" hint="Shown instead of the sentence below.">
          <Input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)} />
        </Field>

        <p className="text-body text-text" aria-live="polite"><span className="text-text-muted">Goal: </span>{input.title || previewLabel(input)}</p>

        <div className={HELP_CLASS}>
          <p><strong className="text-text">Windows.</strong> A weekly goal resets every Monday, a daily one at local midnight, a monthly one on the 1st, all in your timezone ({tz}). One window or a season runs once.</p>
          <p><strong className="text-text">Minimum games.</strong> A win rate counts from 20 decided games and an average from its minimum; until then the bar shows how many games are left.</p>
          <p><strong className="text-text">What counts.</strong> Your own games in the window that match the filters; ranked 1v1 by default. For a build, a game you checked in to that build counts too. <LazyHelpLink slug="goals">Help</LazyHelpLink></p>
        </div>

        {problem ? <p className="text-caption text-warning">{problem}</p> : null}
        {error ? <RequestError title="Couldn't create the goal" error={error} /> : null}
      </form>
    </Modal>
  );
}
