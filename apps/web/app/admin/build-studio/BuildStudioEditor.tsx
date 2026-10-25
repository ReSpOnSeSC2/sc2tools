"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { RequestError } from "@/components/ui/RequestError";
import { PresetCriteriaEditor } from "./PresetCriteriaEditor";
import { defaultEntry, errorText, json, resource, type BuildDetail, type JsonObject, type PresetEntry } from "./studioTypes";

const field = "min-h-11 w-full min-w-0 rounded border border-border bg-bg px-3 py-2";
interface Review { title: string; before: unknown; after: unknown; payload: JsonObject }
export function BuildStudioEditor({ detail, onSaved, onReload, onDirtyChange }: { detail: BuildDetail; onSaved: (detail: BuildDetail) => void; onReload: () => Promise<void>; onDirtyChange?: (value: boolean) => void }) {
  const { getToken } = useAuth();
  // One fetched revision owns this draft. Background revalidation must never
  // overwrite newer input; only explicit Reload or successful Save remounts it.
  const [original] = useState(detail);
  const [entry, setEntry] = useState<PresetEntry>(() => defaultEntry(original));
  const [build, setBuild] = useState(() => json(original.build || {}));
  const [title, setTitle] = useState(original.title || "");
  const [description, setDescription] = useState(original.description || "");
  const [reclassify, setReclassify] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [events, setEvents] = useState("[]"); const [preview, setPreview] = useState("");
  const preset = original.scope === "preset";
  const dirty = preset ? json(entry) !== json(defaultEntry(original)) : build !== json(original.build || {}) || title !== (original.title || "") || description !== (original.description || "") || reclassify;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const doPreview = async () => {
    setError(""); setBusy(true);
    try {
      const response = await apiCall<{ label: string; hash: string; evaluatorVersion: number }>(getToken, `${resource("preset", original.id)}/preview`, { method: "POST", body: json({ replacement: entry, events: JSON.parse(events), baseline: original.id }) });
      setPreview(`${response.label} · evaluator ${response.evaluatorVersion} · ${response.hash.slice(0, 12)}`);
    } catch (caught) { setError(errorText(caught)); } finally { setBusy(false); }
  };
  const prepare = (event: FormEvent) => {
    event.preventDefault(); setError("");
    try {
      const edited: unknown = JSON.parse(build);
      const payload = preset ? { expectedHash: original.expectedHash, replacement: entry } : { expectedRevision: original.revision, build: edited, ...(original.scope === "community" ? { title, description } : { reclassify }) };
      const before = preset ? original.replacement || null : original.scope === "community" ? { title: original.title, description: original.description, build: original.build } : original.build;
      const after = preset ? entry : original.scope === "community" ? { title, description, build: edited } : edited;
      setReview({ title: "Review definition changes", before, after, payload });
    } catch { setError("The definition must contain valid JSON. Your draft is preserved."); }
  };
  const save = async () => {
    if (!review) return; setBusy(true); setError("");
    try {
      const saved = await apiCall<BuildDetail>(getToken, resource(original.scope, original.id), { method: "PUT", body: json(review.payload) });
      setReview(null); onSaved(saved);
    } catch (caught) { setReview(null); setError(errorText(caught)); } finally { setBusy(false); }
  };
  const reviewVersion = (row: NonNullable<BuildDetail["history"]>[number]) => {
    const listing = original.scope === "community" ? { title: row.title ?? original.title, description: row.description ?? original.description } : {};
    setReview({ title: `Restore definition revision ${row.revision}`, before: original.scope === "community" ? { title: original.title, description: original.description, build: original.build } : original.build,
      after: original.scope === "community" ? { ...listing, build: row.build } : row.build, payload: { expectedRevision: original.revision, build: row.build, ...listing } });
  };
  return <section className="min-w-0 space-y-4" aria-label="Definition editor">
    <header><h2 className="break-words text-xl font-semibold">{original.name || original.id}</h2><p className="break-all text-caption text-text-muted">{preset ? "Released preset · global policy" : `${original.scope === "custom" ? "Private custom" : "Community snapshot"} · owner ${original.owner || "unavailable"}`}{original.sourceSlug ? ` · private source ${original.sourceSlug}` : ""}</p></header>
    {error ? <div role="alert" className="space-y-2 rounded border border-danger p-3"><p>{error}</p><Button variant="secondary" disabled={busy} onClick={() => void onReload()}>Reload latest (discard draft)</Button></div> : null}
    {original.truncated ? <p role="alert" className="rounded border border-warning p-3">This legacy definition exceeds validated limits or contains invalid rule/step entries. The bounded projection below is incomplete, so saving is blocked to prevent data loss. Repair the original definition through a reviewed data repair before editing it here. Stored counts: {json(original.definitionCounts)}.</p> : null}
    <form onSubmit={prepare} className="space-y-4"><fieldset disabled={busy || original.truncated} className="min-w-0 space-y-4">
      {preset ? <>
        <div className="space-y-2 rounded border border-border bg-bg-elevated p-3 text-caption"><p>Shared runtime: schema {original.schemaVersion}, evaluator {original.evaluatorVersion}. Active revision {original.policyRevision} · hash <code className="break-all">{original.expectedHash}</code>.</p><p>Compatible desktop engines refresh after healthy heartbeats. Signed-in browser imports refresh before analysis, at most once per minute; visitor-only Try keeps bundled rules without an API request. Offline engines keep their last verified policy and new installs use released defaults. Older clients and incomplete event samples retain their uploaded labels. Existing games change only when reanalysed.</p><p>Release fingerprint: <code className="break-all">{original.releaseHash}</code></p></div>
        <details><summary className="min-h-11 cursor-pointer py-2">Released definition and source</summary><p className="text-caption">Detection surface: {original.released?.surfaces?.join(" and ") || "released detector"}.</p><p className="whitespace-pre-wrap text-caption">{original.released?.description}</p><p className="mt-2 text-caption">{original.released?.implementation === "declarative" ? "Released criteria are shared with the actual decision tree at its original priority." : "This released definition uses a procedural decision tree. No authored step list or replacement criteria is implied by its description."}</p><a className="text-accent underline" href="https://github.com/ReSpOnSeSC2/sc2tools/tree/main/apps/replay-engine/core" target="_blank" rel="noreferrer">Open released source</a>{original.released?.releasedCriteria ? <Button variant="secondary" onClick={() => setEntry({ ...entry, enabled: true, mode: "replacement", anyOf: structuredClone(original.released!.releasedCriteria!) })}>Use actual released criteria as replacement</Button> : null}</details>
        <PresetCriteriaEditor value={entry} onChange={setEntry} />
        <label className="block">Reference description<textarea className={field} maxLength={4000} rows={4} value={entry.description || ""} onChange={event => setEntry({ ...entry, description: event.target.value })} /></label>
        <PresetSteps value={entry} onChange={setEntry} />
        <details><summary className="min-h-11 cursor-pointer py-2">Preview against raw extracted events</summary><p className="text-caption">Synthetic or raw events only; no player IDs or replay tokens. Up to 5,000 events. This preview saves nothing.</p><label className="block">Preview events (JSON)<textarea className={`${field} font-mono text-caption`} rows={7} value={events} onChange={event => setEvents(event.target.value)} /></label><Button variant="secondary" onClick={() => void doPreview()}>Run unsaved preview</Button><p role="status" className="break-words text-caption">{preview}</p></details>
      </> : <>
        {original.removed ? <p className="text-warning">Removed community listing. Editing this snapshot keeps it removed.</p> : null}
        <p className="text-caption text-text-muted">Revision {original.revision}. {original.mode === "rule-only" ? "Rule-only definition: no authored build-order steps exist." : "All authored steps and detection rules appear below."} Private notes and replay references are excluded. Community edits affect this public snapshot independently of its private source.</p>
        {original.scope === "community" ? <><label className="block">Listing title<input className={field} required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></label><label className="block">Listing description<textarea className={field} maxLength={4000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label></> : null}
        <label className="block">Complete definition (JSON)<textarea className={`${field} font-mono text-caption`} spellCheck={false} rows={22} value={build} onChange={event => setBuild(event.target.value)} /></label>
        <p className="text-caption text-text-dim">Edit existing name, race, steps, signature or v3 rules in their stored format. Empty steps are valid. Owner, source, private notes and publication state are immutable here; the server validates every field.</p>
        {original.scope === "custom" ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={reclassify} onChange={event => setReclassify(event.target.checked)} /> Reclassify this owner&apos;s games after saving</label> : null}
      </>}
      <div className="flex flex-wrap gap-2"><Button type="submit">Review changes</Button>{preset && original.replacement ? <Button variant="secondary" onClick={() => setReview({ title: "Restore released preset", before: original.replacement, after: null, payload: { expectedHash: original.expectedHash, replacement: null } })}>Review restore to released</Button> : null}</div>
      {!preset && original.history?.length ? <div className="space-y-2"><h3 className="font-semibold">Previous definitions</h3>{original.history.map(row => <Button key={row.revision} variant="secondary" onClick={() => reviewVersion(row)}>Review revision {row.revision}</Button>)}</div> : null}
    </fieldset></form>
    <Modal open={Boolean(review)} onClose={() => { if (!busy) setReview(null); }} title={review?.title} size="xl" disableScrimClose={busy} footer={<><Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>Keep editing</Button><Button loading={busy} onClick={() => void save()}>Confirm save</Button></>}>
      <p className="mb-4 text-caption">{preset ? "This updates the global active policy. Private custom matches retain priority. A tightened or disabled released label cannot bypass these replacement criteria; it becomes Unclassified when no replacement matches." : "This saves a new version for the owner shown above. Current owner edits and account erasure exclude this save through version checks and an owner write lease."}</p>
      <p className="mb-3 text-caption">{reclassify && !preset && original.scope === "custom" ? "This also queues reclassification for this owner." : "Existing game labels are unchanged by this save."}</p>
      <div className="grid min-w-0 gap-3 md:grid-cols-2"><JsonPanel label="Before" value={review?.before} /><JsonPanel label="After" value={review?.after} /></div>
    </Modal>
  </section>;
}
function JsonPanel({ label, value }: { label: string; value: unknown }) { return <div className="min-w-0"><h3 className="font-semibold">{label}</h3><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-elevated p-3 text-caption">{json(value)}</pre></div>; }
function PresetSteps({ value, onChange }: { value: PresetEntry; onChange: (next: PresetEntry) => void }) {
  const steps = value.steps || [];
  return <fieldset className="min-w-0 space-y-2"><legend>Authored reference steps</legend><p className="text-caption text-text-muted">Reference steps do not create detection criteria. {steps.length === 0 ? "No authored steps; this definition is rule-only." : "All authored steps are listed."}</p>
    {steps.map((step, index) => <div key={index} className="grid min-w-0 gap-2 sm:grid-cols-[6rem_6rem_1fr_auto]"><label>Seconds<input className={field} type="number" min={0} max={86400} required value={step.timeSeconds} onChange={event => onChange({ ...value, steps: steps.map((row, i) => i === index ? { ...row, timeSeconds: Number(event.target.value) } : row) })} /></label><label>Supply<input className={field} type="number" min={0} max={200} value={step.supply ?? ""} onChange={event => onChange({ ...value, steps: steps.map((row, i) => i === index ? { ...row, supply: event.target.value === "" ? undefined : Number(event.target.value) } : row) })} /></label><label>Action<input className={field} required maxLength={280} value={step.action} onChange={event => onChange({ ...value, steps: steps.map((row, i) => i === index ? { ...row, action: event.target.value } : row) })} /></label><Button variant="ghost" onClick={() => onChange({ ...value, steps: steps.filter((_, i) => i !== index) })}>Remove step {index + 1}</Button></div>)}
    <Button variant="secondary" disabled={steps.length >= 200} onClick={() => onChange({ ...value, steps: [...steps, { timeSeconds: 0, action: "" }] })}>Add reference step</Button>
  </fieldset>;
}

export function BuildStudioDetail({ scope, id, onChanged, onDirtyChange }: { scope: BuildDetail["scope"]; id: string; onChanged: () => void; onDirtyChange?: (value: boolean) => void }) {
  const { getToken } = useAuth();
  const swr = useApi<BuildDetail>(resource(scope, id), { revalidateOnFocus: false });
  const [generation, setGeneration] = useState(0); const [notice, setNotice] = useState("");
  const [committed, setCommitted] = useState<BuildDetail | null>(null);
  if (swr.error) return <RequestError error={swr.error} onRetry={() => void swr.mutate()} />;
  if (!swr.data) return <p role="status">Loading definition…</p>;
  return <>{notice ? <p role="status">{notice}</p> : null}<BuildStudioEditor key={`${scope}:${id}:${generation}`} detail={committed || swr.data} onDirtyChange={onDirtyChange} onSaved={value => { onDirtyChange?.(false); setCommitted(value); void swr.mutate(value, { revalidate: false }); setGeneration(value => value + 1); setNotice("Definition saved as a new version."); onChanged(); }} onReload={async () => { try { const latest = await apiCall<BuildDetail>(getToken, resource(scope, id)); await swr.mutate(latest, { revalidate: false }); onDirtyChange?.(false); setCommitted(latest); setGeneration(value => value + 1); setNotice("Loaded the latest definition."); } catch (caught) { setNotice(errorText(caught)); } }} /></>;
}
