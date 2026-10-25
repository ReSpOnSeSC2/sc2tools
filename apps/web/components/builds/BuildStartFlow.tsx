"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Combobox } from "@/components/ui/Combobox";
import { apiCall, boundedApiRequest } from "@/lib/clientApi";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import { coerceRace } from "@/lib/race";
import type { RaceLite, VsRaceLite } from "@/lib/build-rules";
import type { GameBuildOrderResponse } from "@/components/analyzer/game/types";
import type { ReplayLibraryResponse } from "@/components/analyzer/replays/types";
import { BuildEditorModal } from "./editor";
import type { BuildEditorSaveResult } from "./editor/BuildEditor.types";
import { BuildStartCards, type BuildStartChoice } from "./BuildStartCards";
import type { CustomBuild } from "./types";

type Seed = { gameId?: string; events: GameBuildOrderResponse["events"]; race: RaceLite; vsRace: VsRaceLite; name?: string };
type Props = { onClose: () => void; onSaved: (build: CustomBuild, result: BuildEditorSaveResult) => void; initialChoice?: BuildStartChoice; definitionId?: string };
const races = ["Protoss", "Terran", "Zerg", "Random"] as const;
const vsRaces = ["Any", ...races] as const;
const errorText = (error: unknown) => error && typeof error === "object" && "message" in error ? String(error.message) : "The replay could not be loaded. Try again.";

/** Every creation path ends in the same editor; no write happens here. */
export function BuildStartFlow(props: Props) {
  const { userId, isLoaded, isSignedIn } = useAuth();
  if (!isLoaded || !isSignedIn || !userId) return null;
  return <BuildStartBody key={userId} {...props} />;
}

function BuildStartBody({ onClose, onSaved, initialChoice, definitionId }: Props) {
  const { getToken } = useAuth();
  const initialDefinition = BUILD_DEFINITIONS.find(definition => definition.id === definitionId);
  const [step, setStep] = useState<BuildStartChoice | "choose">(initialChoice ?? "choose");
  const [race, setRace] = useState<RaceLite>(initialDefinition?.race ?? "Protoss");
  const [vsRace, setVsRace] = useState<VsRaceLite>(initialDefinition?.matchup ? coerceRace(initialDefinition.matchup[2], "Random") : "Any");
  const [definition, setDefinition] = useState(initialDefinition?.id ?? "");
  const [cursor, setCursor] = useState<string | null>(null), [previous, setPrevious] = useState<Array<string | null>>([]);
  const [pageState, setPage] = useState<{ source: object; data: ReplayLibraryResponse } | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0), [selected, setSelected] = useState<string | null>(null), [seed, setSeed] = useState<Seed | null>(null);
  const selectedDefinition = BUILD_DEFINITIONS.find(item => item.id === definition);
  const query = new URLSearchParams({ limit: "20", sort: "date_desc", race: race[0] });
  if (vsRace !== "Any") query.set("opp_race", vsRace[0]);
  if (step === "detected" && selectedDefinition) query.set("build", selectedDefinition.name);
  if (cursor) query.set("cursor", cursor);
  const path = `/v1/replays?${query}`;
  const scope = `${step}:${path}`;
  const current = useRef<object>({});
  // Changing scope invalidates held callbacks during render, including A→B→A.
  const source = useRef({ scope, epoch: {} });
  if (source.current.scope !== scope) source.current = { scope, epoch: {} };
  current.current = source.current.epoch;
  const page = pageState?.source === current.current ? pageState.data : null;
  const listEnabled = !seed && (step === "games" || (step === "detected" && !!selectedDefinition));
  useEffect(() => {
    if (!listEnabled) return;
    const controller = new AbortController(), epoch = current.current;
    setPage(null); setLoading(true); setError(null); setSelected(null);
    void boundedApiRequest(signal => apiCall<ReplayLibraryResponse>(getToken, path, { signal }), 8000, controller.signal).then(next => {
      if (!controller.signal.aborted && current.current === epoch) setPage({ source: epoch, data: next });
    }).catch(failure => { if (!controller.signal.aborted && current.current === epoch) setError(errorText(failure)); })
      .finally(() => { if (!controller.signal.aborted && current.current === epoch) setLoading(false); });
    return () => controller.abort();
  }, [getToken, path, listEnabled, retry]);
  const activeDetail = useRef<AbortController | null>(null);
  useEffect(() => () => { activeDetail.current?.abort(); }, [scope]);
  function changeScope(next: () => void) { activeDetail.current?.abort(); setSelected(null); setError(null); setPage(null); setCursor(null); setPrevious([]); next(); }
  async function chooseGame(gameId: string) {
    activeDetail.current?.abort(); const controller = new AbortController(); activeDetail.current = controller;
    const epoch = current.current; setSelected(gameId); setError(null);
    try {
      const detail = await boundedApiRequest(signal => apiCall<GameBuildOrderResponse>(getToken, `/v1/games/${encodeURIComponent(gameId)}/build-order`, { signal }), 8000, controller.signal);
      if (controller.signal.aborted || current.current !== epoch) return;
      if (!Array.isArray(detail.events) || detail.events.length === 0) throw new Error("This replay has no extracted build order yet. Choose another replay or start a blank build.");
      setSeed({ gameId, events: detail.events, race: coerceRace(detail.my_race, race), vsRace: coerceRace(detail.opp_race, vsRace === "Any" ? "Random" : vsRace), name: step === "detected" ? selectedDefinition?.name : undefined });
    } catch (failure) { if (!controller.signal.aborted && current.current === epoch) { setError(errorText(failure)); setSelected(null); } }
  }
  const editorSeed = seed ?? (step === "blank" ? { events: [], race, vsRace } : null);
  if (editorSeed) return <BuildEditorModal open onClose={onClose} events={editorSeed.events} gameId={editorSeed.gameId} race={editorSeed.race} vsRace={editorSeed.vsRace} perspective="you" defaultName={editorSeed.name} createOnly
    onSaved={(slug, draft, result) => onSaved({ ...draft, slug, sourceGameId: editorSeed.gameId, perspective: "you" }, result)} />;
  return <Modal open title={step === "choose" ? "Start a new build" : step === "games" ? "Choose one of your games" : "Start from a detected build"} onClose={onClose} size="lg"
    footer={<Button variant="secondary" onClick={onClose}>Cancel</Button>}>
    {step === "choose" ? <BuildStartCards onChoose={setStep} /> : <div className="space-y-4">
      <Button variant="ghost" onClick={() => changeScope(() => setStep("choose"))}>Back to starting points</Button>
      {step === "detected" ? <Combobox label="Detected build" value={definition} options={BUILD_DEFINITIONS.map(item => ({ value: item.id, label: item.name, description: `${item.race}${item.matchup ? ` · ${item.matchup}` : ""}` }))}
        onChange={id => changeScope(() => { const item = BUILD_DEFINITIONS.find(candidate => candidate.id === id); setDefinition(id); if (item) { setRace(item.race); setVsRace(item.matchup ? coerceRace(item.matchup[2], "Random") : "Any"); } })} /> : null}
      <div className="grid grid-cols-2 gap-3"><label className="space-y-1 text-caption">Your race<Select className="min-h-11" value={race} disabled={step === "detected"} onChange={event => changeScope(() => setRace(event.target.value as RaceLite))}>{races.map(item => <option key={item}>{item}</option>)}</Select></label>
        <label className="space-y-1 text-caption">Opponent race<Select className="min-h-11" value={vsRace} onChange={event => changeScope(() => setVsRace(event.target.value as VsRaceLite))}>{vsRaces.map(item => <option key={item}>{item}</option>)}</Select></label></div>
      {step === "detected" ? <p className="text-caption text-text-muted">Choose a label, then a replay with that stored build label (including confirmed check-ins). Your variant starts as a private draft; the analyzer’s rules stay unchanged.</p> : <p className="text-caption text-text-muted">Your latest visible replays for this matchup. Only the selected replay’s build order is loaded.</p>}
      {loading ? <p role="status">Loading replays…</p> : null}
      {error ? <div role="alert" className="space-y-2 text-danger"><p>{error}</p>{!page ? <Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Retry</Button> : null}</div> : null}
      {!loading && page?.items.length === 0 ? <p role="status">No replays match this selection. Try another matchup or <button className="min-h-11 underline" onClick={() => setStep("blank")}>start a blank build</button>.</p> : null}
      {page ? <ul className="space-y-2">{page.items.slice(0, 20).map(game => <li key={game.gameId}><button type="button" disabled={!!selected} className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-line p-3 text-left hover:border-accent disabled:opacity-60" onClick={() => void chooseGame(game.gameId)}>
        <span className="min-w-0 break-words"><span className="block font-semibold">{game.map || "Unknown map"} · {game.opponent?.displayName || "Unknown opponent"}</span><span className="text-caption text-text-muted">{game.date ? new Date(game.date).toLocaleString() : "Date unavailable"} · {game.result || "Result unavailable"}{game.myBuild ? ` · ${game.myBuild}` : ""}</span></span><span className="shrink-0 text-caption">{selected === game.gameId ? "Loading…" : "Use build order"}</span>
      </button></li>)}</ul> : null}
      {page ? <div className="flex flex-wrap justify-between gap-2"><Button variant="secondary" disabled={!previous.length || !!selected} onClick={() => { setCursor(previous.at(-1) ?? null); setPrevious(items => items.slice(0, -1)); }}>Previous replays</Button><Button variant="secondary" disabled={!page.page.hasMore || !page.page.nextCursor || !!selected} onClick={() => { setPrevious(items => [...items, cursor]); setCursor(page.page.nextCursor); }}>Next replays</Button></div> : null}
    </div>}
  </Modal>;
}
