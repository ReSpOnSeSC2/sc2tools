"use client";

import { useId, useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { apiCall, type ClientApiError } from "@/lib/clientApi";
import { clock, type PracticeCheckpoint, type PracticeCheckpointStat, type PracticeStep } from "@/lib/practiceLog";

interface CheckpointEditorProps {
  matchup: string;
  targetHash: string;
  steps: PracticeStep[];
  checkpoints: PracticeCheckpointStat[];
  onSaved: () => void;
}

interface DraftCheckpoint { id: number; i: number; tolerance: string }

export function CheckpointResults({ checkpoints }: { checkpoints: PracticeCheckpointStat[] }) {
  if (!checkpoints.length) return null;
  return (
    <ul aria-label="Checkpoint hit rates" className="space-y-1 text-caption">
      {checkpoints.map((point) => (
        <li key={point.i} className="flex flex-wrap gap-x-2">
          <span className="font-medium text-text">{point.name} (±{point.toleranceSec}s)</span>
          <span className="text-text-muted">{point.attempts ? `${point.hits} of ${point.attempts} on time (${Math.round(100 * point.hits / point.attempts)}%)` : "No attempts yet"}</span>
        </li>
      ))}
    </ul>
  );
}

export function CheckpointEditor({ matchup, targetHash, steps, checkpoints, onSaved }: CheckpointEditorProps) {
  const { getToken } = useAuth();
  const prefix = useId();
  const [expected, setExpected] = useState(() => checkpoints.map(({ i, toleranceSec }) => ({ i, toleranceSec })));
  const [draft, setDraft] = useState<DraftCheckpoint[]>(() => expected.map((point, id) => ({ id, i: point.i, tolerance: String(point.toleranceSec) })));
  const [nextId, setNextId] = useState(expected.length);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const addable = steps.find((step) => !draft.some((point) => point.i === step.i));
  const normalized = draft.map((point) => ({ i: point.i, toleranceSec: Number(point.tolerance) })).sort((a, b) => a.i - b.i);
  const dirty = JSON.stringify(normalized) !== JSON.stringify(expected);

  function add() {
    if (!addable || draft.length >= 3) return;
    setDraft([...draft, { id: nextId, i: addable.i, tolerance: "10" }]);
    setNextId(nextId + 1);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await apiCall<{ checkpoints: PracticeCheckpoint[] }>(getToken, "/v1/practice/checkpoints", {
        method: "PUT", body: JSON.stringify({ matchup, targetHash, expected, checkpoints: normalized }),
      });
      setExpected(result.checkpoints);
      setMessage({ text: "Checkpoints saved." });
      onSaved();
    } catch (error) {
      setMessage({ error: true, text: (error as ClientApiError | null)?.status === 409
        ? "This target or its checkpoints changed. Reload the practice log before saving."
        : "Couldn’t save your checkpoints. Try again." });
    } finally { setSaving(false); }
  }

  return (
    <Card title="Checkpoints">
      <form className="space-y-3" onSubmit={(event) => void save(event)}>
        <p className="text-caption text-text-muted">Choose up to three build steps and how many seconds early or late count as on time.</p>
        <CheckpointResults checkpoints={checkpoints} />
        <fieldset className="space-y-2" disabled={saving}>
          <legend className="sr-only">Edit checkpoints</legend>
          {draft.map((point, index) => (
            <div key={point.id} className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-caption" htmlFor={`${prefix}-step-${point.id}`}>
                Step {index + 1}
                <Select id={`${prefix}-step-${point.id}`} value={point.i} onChange={(event) => setDraft(draft.map((row) => row.id === point.id ? { ...row, i: Number(event.target.value) } : row))}>
                  {steps.filter((step) => step.i === point.i || !draft.some((row) => row.i === step.i)).map((step) => (
                    <option key={step.i} value={step.i}>{clock(step.t)} {step.name}</option>
                  ))}
                </Select>
              </label>
              <label className="flex w-32 flex-col gap-1 text-caption" htmlFor={`${prefix}-tolerance-${point.id}`}>
                Tolerance {index + 1} (s)
                <Input id={`${prefix}-tolerance-${point.id}`} type="number" min={1} max={180} step={1} required value={point.tolerance}
                  onChange={(event) => setDraft(draft.map((row) => row.id === point.id ? { ...row, tolerance: event.target.value } : row))} />
              </label>
              <Button type="button" variant="ghost" onClick={() => setDraft(draft.filter((row) => row.id !== point.id))} aria-label={`Remove checkpoint ${index + 1}`}>Remove</Button>
            </div>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="secondary" disabled={saving || draft.length >= 3 || !addable} onClick={add}>Add checkpoint</Button>
          <Button type="submit" loading={saving} disabled={!dirty}>Save checkpoints</Button>
        </div>
        {message ? <p role={message.error ? "alert" : "status"} className={message.error ? "text-caption text-danger" : "text-caption text-text-muted"}>{message.text}</p> : null}
      </form>
    </Card>
  );
}
