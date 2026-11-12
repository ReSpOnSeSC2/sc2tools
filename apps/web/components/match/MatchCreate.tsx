"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { SkeletonBar, SkeletonRegion } from "@/components/ui/Skeleton";
import { currentPool } from "@/lib/currentMapPool";
import { FORMATS, PRESETS, invitePath, isFormat, isPreset, type Format, type Preset, type RoomConfig } from "@/lib/matchRoom";
import { createRoom, newCreationAttempt, RoomRequestError, roomErrorText } from "@/lib/matchRoomClient";
import { useSeasons } from "@/lib/useSeasons";

const SELECT = "min-h-11 w-full rounded-lg border border-line bg-bg-surface px-3 text-body text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";

function LadderPool({ maps, fresh, loading, retry }: {
  maps: string[]; fresh: boolean; loading: boolean; retry: () => void;
}) {
  if (loading) return <SkeletonRegion label="Loading ladder maps" className="min-h-24 space-y-2">
    <SkeletonBar className="h-4 w-40" /><SkeletonBar className="h-4 w-72 max-w-full" />
  </SkeletonRegion>;
  if (!maps.length) return <div className="space-y-2">
    <p className="text-body text-text-muted">Ladder maps are unavailable. Try again or enter a custom pool.</p>
    <Button variant="secondary" className="min-h-11" onClick={retry}>Retry ladder maps</Button>
  </div>;
  return <div className="space-y-2">
    <p className="text-caption text-text-muted">{fresh ? "Current ladder pool" : "Last known ladder pool"} · {maps.length} maps</p>
    <ul className="flex flex-wrap gap-2" aria-label="Ladder maps">
      {maps.map(map => <li key={map} className="max-w-full break-words rounded-full bg-bg-elevated px-3 py-1 text-caption text-text">{map}</li>)}
    </ul>
  </div>;
}

function validMapList(maps: string[], format: Format) {
  return maps.length >= format && maps.length <= 20 && maps.every(map => map.length <= 48);
}

type CreationAttempt = { signature: string; attempt: string };

function prepareCreation(config: RoomConfig, previous: CreationAttempt | null) {
  if (!validMapList(config.maps, config.format)) {
    return "Enter at least " + config.format + " maps and at most 20. Each map name can have up to 48 characters.";
  }
  const signature = JSON.stringify(config);
  const pending = previous?.signature === signature ? previous : { signature, attempt: newCreationAttempt() };
  const input = { ...config, attempt: pending.attempt };
  if (new TextEncoder().encode(JSON.stringify(input)).length > 2048) {
    return "Shorten the custom map names before creating the room.";
  }
  return { input, pending };
}

function MatchOptions({ format, preset, onFormat, onPreset }: {
  format: Format; preset: Preset; onFormat: (format: Format) => void; onPreset: (preset: Preset) => void;
}) {
  const rule = PRESETS.find(item => item.id === preset);
  return <>
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1.5 text-body font-semibold text-text">
        Series format
        <select value={format} className={SELECT} onChange={event => {
          const next = Number(event.target.value);
          if (isFormat(next)) onFormat(next);
        }}>
          {FORMATS.map(value => <option key={value} value={value}>Best of {value}</option>)}
        </select>
      </label>
      <label className="space-y-1.5 text-body font-semibold text-text">
        Veto preset
        <select value={preset} className={SELECT} aria-describedby="match-preset-detail" onChange={event => {
          if (isPreset(event.target.value)) onPreset(event.target.value);
        }}>
          {PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
    </div>
    <p id="match-preset-detail" className="min-h-10 text-caption text-text-muted">{rule?.detail}</p>
  </>;
}

function useCreateRoom(format: Format, preset: Preset, maps: string[]) {
  const [saving, setSaving] = useState<"match" | "practice" | null>(null);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<CreationAttempt | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function start(practice: boolean) {
    if (controller.current) return;
    const draft = prepareCreation({ format, preset, maps, practice }, pending.current);
    if (typeof draft === "string") {
      setError(draft);
      return;
    }
    pending.current = draft.pending;
    const request = new AbortController();
    controller.current = request;
    setSaving(practice ? "practice" : "match");
    setError("");
    try {
      const invite = await createRoom(draft.input, request.signal);
      if (!request.signal.aborted) {
        pending.current = null;
        window.location.assign(invitePath(invite));
      }
    } catch (err) {
      if (err instanceof RoomRequestError && err.creationAttemptEnded) pending.current = null;
      if (!request.signal.aborted) setError(roomErrorText(err, "create"));
    } finally {
      if (!request.signal.aborted) setSaving(null);
      controller.current = null;
    }
  }
  return { start, saving, error };
}

export function MatchCreate() {
  const [format, setFormat] = useState<Format>(3);
  const [preset, setPreset] = useState<Preset>("standard");
  const [custom, setCustom] = useState(false);
  const [rawMaps, setRawMaps] = useState("");
  const seasons = useSeasons();
  const pool = currentPool(seasons.data);
  const maps = custom ? rawMaps.split(/\r?\n/).map(map => map.trim()).filter(Boolean) : pool.maps.slice(0, 20);
  const { start, saving, error } = useCreateRoom(format, preset, maps);
  const ready = custom || maps.length >= format;
  return (
    <form action="/match" onSubmit={event => { event.preventDefault(); void start(false); }}
      className="space-y-5 rounded-xl border border-line bg-bg-surface p-4 sm:p-6" aria-label="Create a match room">
      <MatchOptions format={format} preset={preset} onFormat={setFormat} onPreset={setPreset} />
      <label className="flex min-h-11 items-center gap-3 text-body font-semibold text-text">
        <input type="checkbox" checked={custom} onChange={event => setCustom(event.target.checked)}
          className="h-5 w-5 accent-accent focus-visible:ring-2 focus-visible:ring-accent" />
        Use a custom map pool
      </label>
      {custom ? <label className="block space-y-2 text-body text-text">
        <span className="font-semibold">Map names</span>
        <textarea value={rawMaps} onChange={event => setRawMaps(event.target.value)} rows={5} maxLength={1000}
          aria-describedby="match-map-limit"
          className="block w-full rounded-lg border border-line bg-bg-surface p-3 text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" />
        <span id="match-map-limit" className="block text-caption text-text-muted">Enter one map per line.</span>
      </label> : <LadderPool maps={maps} fresh={pool.fresh} loading={seasons.isLoading} retry={() => { void seasons.mutate(); }} />}
      {error && <p role="alert" className="text-caption text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" className="min-h-11" loading={saving === "match"} disabled={!ready || saving !== null}>Create room</Button>
        <Button variant="secondary" className="min-h-11" loading={saving === "practice"} disabled={!ready || saving !== null}
          onClick={() => { void start(true); }}>Practice solo</Button>
      </div>
    </form>
  );
}
