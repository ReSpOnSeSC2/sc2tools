"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { apiCall, useApi } from "@/lib/clientApi";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AdminPageHeader } from "../components/AdminPageHeader";
import { ForbiddenCard } from "../components/AdminFragments";

type Step = { name: string; t: number; kind: string; timing: string };
type Example = {
  id: string; name: string; description: string; matchup: string; map: string | null;
  stepCount: number; publishedAt: string;
};
type Preview = Omit<Example, "id" | "publishedAt"> & {
  previewToken: string; target: { name: string; steps: Step[] };
};
type Replay = { gameId: string; date?: string; map?: string; myBuild?: string; opponent?: { strategy?: string } };
const INPUT = "w-full rounded-lg border border-border bg-bg-elevated px-3 py-2 text-caption text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function message(error: unknown) {
  return error && typeof error === "object" && "message" in error ? String(error.message) : "The request failed. Please try again.";
}

export default function AdminGhostExamplesPage() {
  const { getToken, userId } = useAuth();
  const catalog = useApi<{ items: Example[] }>("/v1/admin/ghost-examples");
  const replays = useApi<{ items: Replay[] }>(catalog.data ? "/v1/replays?limit=50&sort=date_desc" : null);
  const [gameId, setGameId] = useState("");
  const [side, setSide] = useState<"you" | "opponent">("you");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const revision = useRef(0);
  const account = useRef(userId);
  account.current = userId;
  useEffect(() => {
    revision.current += 1;
    setGameId(""); setName(""); setDescription(""); setPreview(null); setBusy(false); setNotice("");
  }, [userId]);

  function edit(update: () => void) {
    revision.current += 1;
    update(); setPreview(null); setNotice("");
  }

  function body() {
    return { gameId: gameId.trim(), side, ...(name.trim() ? { name: name.trim() } : {}), description: description.trim() };
  }

  async function run(action: "preview" | "publish" | "remove", id?: string) {
    const started = revision.current;
    const owner = userId;
    setBusy(true); setNotice("");
    try {
      if (action === "preview") {
        const result = await apiCall<Preview>(getToken, "/v1/admin/ghost-examples/preview", { method: "POST", body: JSON.stringify(body()) });
        if (started === revision.current && owner === account.current) setPreview(result);
      } else if (action === "publish" && preview) {
        await apiCall(getToken, "/v1/admin/ghost-examples", { method: "POST", body: JSON.stringify({ ...body(), previewToken: preview.previewToken }) });
        if (started === revision.current && owner === account.current) { setPreview(null); setNotice("Example published to the Ghost library."); await catalog.mutate(); }
      } else if (action === "remove" && id) {
        await apiCall(getToken, "/v1/admin/ghost-examples/" + encodeURIComponent(id), { method: "DELETE" });
        if (owner === account.current) { setNotice("Example removed from the Ghost library."); await catalog.mutate(); }
      }
    } catch (error) {
      if (started === revision.current && owner === account.current) setNotice(message(error));
    } finally {
      if (owner === account.current) setBusy(false);
    }
  }

  if (catalog.error?.status === 403) return <ForbiddenCard />;
  return <div className="space-y-6">
    <AdminPageHeader anchor="guides" title="Ghost examples" description="Publish a timed opening from one of your own replays. Review the exact shared steps before publishing." />
    {catalog.error ? <p role="alert" className="text-danger">{catalog.error.message}</p> : null}
    {notice ? <p role="status" className="rounded-lg border border-border bg-bg-elevated p-3 text-caption">{notice}</p> : null}
    <Card title="Prepare an example" headingLevel={2}>
      <div className="space-y-4">
        <label className="block space-y-1 text-caption"><span>Choose one of your recent replays</span>
          <select aria-label="Recent replay" className={INPUT} value={replays.data?.items.some((row) => row.gameId === gameId) ? gameId : ""} disabled={busy || !catalog.data} onChange={(event) => edit(() => setGameId(event.target.value))}>
            <option value="">Choose a replay…</option>
            {(replays.data?.items || []).map((row) => <option value={row.gameId} key={row.gameId}>{(row.date || "").slice(0, 10)} · {row.map || "Unknown map"} · {row.myBuild || "Unclassified"}</option>)}
          </select>
        </label>
        {replays.error ? <p role="alert" className="text-caption text-danger">{replays.error.message}</p> : null}
        <label className="block space-y-1 text-caption"><span>Replay game ID</span><input className={INPUT} value={gameId} maxLength={200} disabled={busy || !catalog.data} onChange={(event) => edit(() => setGameId(event.target.value))} /></label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1 text-caption"><span>Build order to share</span><select className={INPUT} value={side} disabled={busy || !catalog.data} onChange={(event) => edit(() => setSide(event.target.value as "you" | "opponent"))}><option value="you">Your build order</option><option value="opponent">Opponent&apos;s build order</option></select></label>
          <label className="block space-y-1 text-caption"><span>Public example name (optional)</span><input className={INPUT} value={name} maxLength={80} disabled={busy || !catalog.data} onChange={(event) => edit(() => setName(event.target.value))} placeholder="Use the replay's build label" /></label>
        </div>
        <label className="block space-y-1 text-caption"><span>Public coaching note (optional)</span><textarea className={INPUT} value={description} maxLength={500} rows={3} disabled={busy || !catalog.data} onChange={(event) => edit(() => setDescription(event.target.value))} /></label>
        <Button disabled={!gameId.trim() || !catalog.data} loading={busy} onClick={() => void run("preview")}>Preview selected opening</Button>
      </div>
    </Card>
    {preview ? <Card title={preview.name} headingLevel={2}>
      <div className="space-y-4">
        <p className="text-caption text-text-muted">{preview.matchup} · {preview.map || "Unknown map"} · {preview.stepCount} timed steps</p>
        {preview.description ? <p className="text-caption">{preview.description}</p> : null}
        <div className="max-h-80 overflow-auto"><table className="w-full text-left text-caption"><thead><tr><th scope="col" className="pb-2">Time</th><th scope="col" className="pb-2">Step</th><th scope="col" className="pb-2">Event</th></tr></thead><tbody>{preview.target.steps.map((step, index) => <tr key={index} className="border-t border-border"><td className="py-2 tabular-nums">{Math.floor(step.t / 60)}:{String(Math.floor(step.t % 60)).padStart(2, "0")}</td><td>{step.name}</td><td>{step.timing}</td></tr>)}</tbody></table></div>
        <Button loading={busy} onClick={() => void run("publish")}>Publish example for users</Button>
      </div>
    </Card> : null}
    <Card title="Your published examples" headingLevel={2}>
      {!catalog.data ? <p className="text-caption text-text-muted">Loading examples…</p> : !catalog.data.items.length ? <p className="text-caption text-text-muted">Publish your first previewed opening to make it available in the Ghost library.</p> : <ul className="divide-y divide-border">{catalog.data.items.map((example) => <li key={example.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="font-semibold">{example.name}</p><p className="text-caption text-text-muted">{example.matchup} · {example.stepCount} steps · {example.map || "Unknown map"}</p></div><Button variant="secondary" size="sm" disabled={busy} onClick={() => void run("remove", example.id)}>Unpublish</Button></li>)}</ul>}
    </Card>
  </div>;
}
