"use client";
import { Suspense, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { RequestError } from "@/components/ui/RequestError";
import { useApi } from "@/lib/clientApi";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { ForbiddenCard, LoadingRows } from "../components/AdminFragments";
import { useAdminQueryState } from "../components/useAdminQueryState";
import { BuildStudioDetail } from "./BuildStudioEditor";
import { PolicyHistory } from "./PolicyHistory";
import { STUDIO_ROOT, type BuildRow, type Scope } from "./studioTypes";

export function BuildStudioBody() {
  const [view, setView] = useAdminQueryState({ scope: "preset", before: "", owner: "" }, { allowed: { scope: ["preset", "custom", "community"] } });
  const scope = view.scope as Scope;
  const [selected, setSelected] = useState<BuildRow | null>(null);
  const [owner, setOwner] = useState(view.owner);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const closeEditor = () => { if (dirty) setDiscard(true); else setSelected(null); };
  const [generation, setGeneration] = useState(0);
  const params = new URLSearchParams({ scope });
  if (view.before) params.set("after", view.before);
  if (view.owner && scope !== "preset") params.set("owner", view.owner);
  const swr = useApi<{ items: BuildRow[]; nextAfter: string | null }>(`${STUDIO_ROOT}?${params}`, { keepPreviousData: false });
  if (swr.error?.status === 403 || swr.error?.status === 401) return <ForbiddenCard />;
  const changed = () => { void swr.mutate(); setGeneration(value => value + 1); };
  const chooseScope = (value: Scope) => { setSelected(null); setView({ scope: value, before: "" }); };
  return <>
    <AdminPageHeader anchor="build-studio" title="Build Studio" description="Every released preset, private custom definition and community snapshot. Review and version edits with their actual source and owner." />
    <div className="flex flex-wrap gap-2" role="group" aria-label="Build source">{(["preset", "custom", "community"] as Scope[]).map(value => <Button key={value} variant={scope === value ? "primary" : "secondary"} aria-pressed={scope === value} onClick={() => chooseScope(value)}>{value === "preset" ? "Released presets" : value === "custom" ? "All private custom builds" : "All community snapshots"}</Button>)}</div>
    {scope !== "preset" ? <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setSelected(null); setView({ owner: owner.trim(), before: "" }); }}><label className="min-w-0 flex-1">Owner user ID (optional)<input className="min-h-11 w-full rounded border border-border bg-bg px-3" maxLength={200} value={owner} onChange={event => setOwner(event.target.value)} /></label><Button type="submit" variant="secondary">Apply owner filter</Button>{view.owner ? <Button variant="ghost" onClick={() => { setOwner(""); setView({ owner: "", before: "" }); setSelected(null); }}>All owners</Button> : null}</form> : null}
    {swr.error ? <RequestError error={swr.error} onRetry={() => void swr.mutate()} /> : !swr.data ? <LoadingRows /> : <Card padded={false}><ul className="divide-y divide-border">{swr.data.items.map(row => <li key={row.id}><button type="button" className="flex min-h-16 w-full min-w-0 flex-col gap-1 px-4 py-3 text-left hover:bg-bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-pressed={selected?.id === row.id && selected.scope === scope} onClick={() => { setDirty(false); setSelected(row); setGeneration(value => value + 1); }}><span className="break-words font-semibold">{row.name}</span><span className="break-all text-caption text-text-muted">{row.owner ? `Owner ${row.owner}` : "Global released preset"} · {row.mode}{row.replaced ? " · active policy edit" : ""}{row.removed ? " · removed listing" : ""}{row.sourceSlug ? ` · private source ${row.sourceSlug}` : ""}</span></button></li>)}</ul>{!swr.data.items.length ? <p className="p-4 text-text-muted">No definitions in this source/owner selection.</p> : null}</Card>}
    <nav aria-label="Definition pages" className="flex justify-between gap-3"><Button variant="secondary" disabled={!view.before} onClick={() => { setSelected(null); setView({ before: "" }); }}>First page</Button><span className="text-caption">{swr.data?.items.length ?? 0} definitions on this page</span><Button variant="secondary" disabled={!swr.data?.nextAfter} onClick={() => { setSelected(null); setView({ before: swr.data!.nextAfter! }); }}>Next definitions</Button></nav>
    <p className="text-caption text-text-muted">Select a definition to view every stored step and rule, edit it, preview preset criteria or review previous versions.</p>
    <Modal open={Boolean(selected && selected.scope === scope)} onClose={closeEditor} title="Build definition" size="2xl" desktopLayout="side">
      {selected && selected.scope === scope ? <BuildStudioDetail key={`${selected.scope}:${selected.id}:${generation}`} scope={scope} id={selected.id} onDirtyChange={setDirty} onChanged={() => void swr.mutate()} /> : null}
    </Modal>
    <Modal open={discard} onClose={() => setDiscard(false)} title="Discard unsaved definition changes?" footer={<><Button variant="secondary" onClick={() => setDiscard(false)}>Keep editing</Button><Button variant="danger" onClick={() => { setDiscard(false); setDirty(false); setSelected(null); }}>Discard draft</Button></>}>Your changes have not been saved. Closing the editor will discard this draft.</Modal>
    <PolicyHistory onChanged={changed} />
  </>;
}
export default function BuildStudioPage() { return <Suspense fallback={<LoadingRows />}><BuildStudioBody /></Suspense>; }
