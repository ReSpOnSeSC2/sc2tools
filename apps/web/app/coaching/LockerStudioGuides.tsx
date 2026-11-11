"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";

export type StudioKind = "notes" | "voice" | "video" | "image" | "replay" | "pdf";
type Guide = { id: string; label: string; prompts: string[]; insertableStructure?: string; starterScript?: string };
type Kit = { matchup: string; voice?: { script: string }; assignment?: { title: string; action: string } };
type Authoring = { matchups: string[]; universalGuides: Guide[]; matchupKits: Kit[] };

const GUIDE: Record<StudioKind, string> = {
  notes: "guide-session-notes", voice: "guide-voice-memo", video: "guide-video",
  image: "guide-annotated-screenshot", replay: "guide-replay-note", pdf: "guide-pdf-practice-card",
};

const FRAMEWORKS = [
  ["guide-session-notes", "Insert session structure"],
  ["guide-replay-note", "Insert replay structure"],
  ["guide-pdf-practice-card", "Insert practice card structure"],
] as const;

export function appendStudioPrompt(value: string, prompt: string, limit = 5000): string {
  const current = value.trimEnd();
  return (current ? `${current}\n\n${prompt}` : prompt).slice(0, limit);
}

/** Loads the same authoring library as Classic only once an editor opens. */
export function LockerStudioGuides({ kind, onInsert, disabled }: {
  kind: StudioKind;
  onInsert: (text: string, title?: string) => void;
  disabled: boolean;
}) {
  const [data, setData] = useState<Authoring>();
  const [failed, setFailed] = useState(false);
  const [matchup, setMatchup] = useState("");
  useEffect(() => {
    let active = true;
    void import("../../../../coaching/authoring_kits.json").then(
      ({ default: kits }) => { if (active) setData(kits); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, []);
  if (!data) return failed ? <p className="text-caption text-text-muted">Authoring prompts could not load. You can keep writing.</p> : null;
  const find = (id: string) => data.universalGuides.find(guide => guide.id === id);
  const guide = find(GUIDE[kind]);
  const kit = data.matchupKits.find(row => row.matchup === matchup);
  const assignment = kit?.assignment;
  const voiceOutline = kit?.voice?.script ?? guide?.starterScript;
  return <div className="min-w-0 space-y-3">
    {guide?.prompts.length ? <details className="space-y-2 rounded-lg border border-border px-3 py-2">
      <summary className="cursor-pointer text-caption font-semibold text-text">{guide.label} prompts</summary>
      <ul className="list-disc space-y-1 pl-5 text-caption text-text-muted">{guide.prompts.map(prompt => <li key={prompt}>{prompt}</li>)}</ul>
    </details> : null}
    {kind === "notes" ? <div className="flex flex-wrap gap-2" aria-label="Session note frameworks">
      {FRAMEWORKS.map(([id, label]) => {
        const framework = find(id);
        return framework?.insertableStructure ? <Button key={id} size="sm" variant="secondary" disabled={disabled}
          onClick={() => onInsert(framework.insertableStructure ?? "", framework.label)}>{label}</Button> : null;
      })}
    </div> : null}
    {(kind === "notes" || kind === "voice") ? <div className="grid items-end gap-2 sm:grid-cols-[1fr_auto]">
      <Field label={kind === "notes" ? "Matchup assignment" : "Matchup for speaking outline"}>
        <Select value={matchup} disabled={disabled} onChange={event => setMatchup(event.target.value)}>
          <option value="">{kind === "voice" ? "Any matchup" : "Choose a matchup"}</option>
          {data.matchups.map(value => <option key={value} value={value}>{value}</option>)}
        </Select>
      </Field>
      {kind === "notes" ? <Button size="sm" variant="secondary" disabled={disabled || !assignment}
        onClick={() => { if (assignment) onInsert(assignment.action, assignment.title); }}>Insert assignment</Button>
        : <Button size="sm" variant="secondary" disabled={disabled || !voiceOutline}
          onClick={() => { if (voiceOutline) onInsert(voiceOutline); }}>Insert speaking outline</Button>}
    </div> : null}
    {(kind === "pdf" || kind === "replay") && guide?.insertableStructure ? <Button size="sm" variant="secondary" disabled={disabled}
      onClick={() => onInsert(guide.insertableStructure ?? "")}>Insert {kind === "pdf" ? "one-page practice outline" : "replay note structure"}</Button> : null}
  </div>;
}
