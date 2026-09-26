"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { useSWRConfig } from "swr";
import { apiCall, useApi } from "@/lib/clientApi";
import { botSessionActive, readSavedBotSession, type BotLabCatalog, type BotLabSession,
  type BotLabStart, type BotRace, type SavedBotSession } from "@/lib/botLab";

const inputClass = "mt-1 w-full rounded-lg border border-border bg-bg-surface px-3 py-2 text-text";
const buttonClass = "rounded-lg border border-border px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50";
const storageKey = (userId: string) => `sc2tools:bot-lab:${userId}`;
const messageOf = (failure: unknown) => (failure as { message?: string })?.message || "The desktop agent could not be reached.";

export function BotLab() {
  const { userId, getToken } = useAuth();
  const { mutate: mutateCache } = useSWRConfig();
  const [device, setDevice] = useState("");
  const [bot, setBot] = useState("");
  const [map, setMap] = useState("");
  const [race, setRace] = useState<BotRace>("Protoss");
  const [saved, setSaved] = useState<SavedBotSession | null>(null);
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const [stopError, setStopError] = useState("");
  const [acknowledgement, setAcknowledgement] = useState<BotLabSession | null>(null);
  const userRef = useRef(userId);
  userRef.current = userId;
  const inFlight = useRef(false);
  const catalog = useApi<BotLabCatalog>(`/v1/bot-lab/catalog${device ? `?deviceId=${encodeURIComponent(device)}` : ""}`,
    { revalidateOnFocus: false, revalidateOnReconnect: false, refreshInterval: 0 });
  const data = catalog.data;
  const current = restoredFor === userId ? saved : null;
  const status = useApi<BotLabSession>(current && !submitting
    ? `/v1/bot-lab/sessions/${encodeURIComponent(current.id)}?deviceId=${encodeURIComponent(current.deviceId)}` : null,
    { revalidateOnFocus: false, refreshInterval: (value?: BotLabSession) => current && botSessionActive(value?.status) ? 4000 : 0 });
  const matchesCurrent = (value?: BotLabSession | null) => value?.id === current?.id && value?.deviceId === current?.deviceId;
  const session = matchesCurrent(status.data) ? status.data : matchesCurrent(acknowledgement) ? acknowledgement : undefined;
  const active = !!current && botSessionActive(session?.status);

  useEffect(() => {
    setSaved(null);
    setLaunchError("");
    setStopError("");
    setAcknowledgement(null);
    setSubmitting(false);
    setStopping(false);
    inFlight.current = false;
    if (!userId) { setRestoredFor(null); return; }
    try { setSaved(readSavedBotSession(localStorage.getItem(storageKey(userId)))); }
    catch { setLaunchError("Browser storage is unavailable. A launch must be saved before it can start."); }
    setRestoredFor(userId);
  }, [userId]);

  const remember = useCallback((value: SavedBotSession) => {
    if (!userId) throw new Error("Sign in again before starting a game.");
    // Persist before sending: a lost acknowledgement must never create a
    // second launch when the page is reopened or its button is retried.
    localStorage.setItem(storageKey(userId), JSON.stringify(value));
    setSaved(value);
  }, [userId]);

  useEffect(() => {
    if (!data?.activeSessionId || !data.deviceId || restoredFor !== userId || submitting) return;
    if (current && (botSessionActive(session?.status) ||
      (current.id === data.activeSessionId && current.deviceId === data.deviceId))) return;
    try { remember({ id: data.activeSessionId, deviceId: data.deviceId }); }
    catch { setLaunchError("An active game was found, but its status could not be saved in this browser."); }
  }, [data?.activeSessionId, data?.deviceId, current, restoredFor, userId, remember, session?.status, submitting]);

  const selectedDevice = data?.deviceId || device;
  const selectedBot = data?.bots.find(value => value.id === bot) ?? data?.bots[0];
  const selectedMap = data?.maps.find(value => value.id === map) ?? data?.maps[0];
  const ready = data?.agent.ready && selectedDevice && selectedBot && selectedMap && restoredFor === userId && !!userId;

  const sendStart = async (body: BotLabStart) => {
    if (inFlight.current) return;
    const forUser = userId;
    inFlight.current = true;
    setSubmitting(true);
    setLaunchError("");
    try {
      remember({ id: body.requestId, deviceId: body.deviceId, start: body });
      const result = await apiCall<BotLabSession>(getToken, "/v1/bot-lab/sessions", {
        method: "POST", body: JSON.stringify(body),
      });
      if (userRef.current !== forUser) return;
      if (result.id !== body.requestId || result.deviceId !== body.deviceId) throw new Error("The launch acknowledgement did not match this request. Checking its saved status.");
      setAcknowledgement(result);
      // Seed the exact authenticated status key before enabling its GET. A
      // pre-reservation response must not override the accepted launch.
      await mutateCache(["authenticated-api", forUser,
        `/v1/bot-lab/sessions/${encodeURIComponent(body.requestId)}?deviceId=${encodeURIComponent(body.deviceId)}`],
      result, { revalidate: false });
    } catch (failure) {
      if (userRef.current !== forUser) return;
      setLaunchError(`${messageOf(failure)} The same launch request is saved; check its status before retrying.`);
    } finally { if (userRef.current === forUser) { inFlight.current = false; setSubmitting(false); } }
  };

  const start = () => {
    if (!ready || active || submitting || !selectedBot || !selectedMap) return;
    void sendStart({ deviceId: selectedDevice, requestId: crypto.randomUUID().replace(/-/g, ""),
      botId: selectedBot.id, mapId: selectedMap.id, humanRace: race });
  };

  const stop = async () => {
    if (!current || stopping) return;
    const forUser = userId;
    setStopping(true);
    setStopError("");
    try {
      const result = await apiCall<BotLabSession>(getToken, `/v1/bot-lab/sessions/${encodeURIComponent(current.id)}/stop`,
        { method: "POST", body: JSON.stringify({ deviceId: current.deviceId }) });
      if (userRef.current !== forUser) return;
      await status.mutate(result, { revalidate: true });
    } catch (failure) { if (userRef.current === forUser) setStopError(messageOf(failure)); }
    finally { if (userRef.current === forUser) setStopping(false); }
  };

  return <div className="mx-auto max-w-3xl space-y-6">
    <header className="space-y-2">
      <p className="font-mono text-caption text-text-dim">Private development</p>
      <h1 className="text-3xl font-bold">Play against a local bot</h1>
      <p className="text-text-muted">StarCraft II opens on your selected computer. Games start with eight workers. These bots are experimental; no ladder rating is claimed.</p>
    </header>
    <section className="space-y-4 rounded-xl border border-border bg-bg-elevated/40 p-5" aria-label="Local game setup">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Game setup</h2>
        <button className={buttonClass} type="button" onClick={() => void catalog.mutate()} disabled={catalog.isLoading}>Refresh agent</button>
      </div>
      {catalog.isLoading && <p role="status">Checking your desktop agent…</p>}
      {catalog.error && <p role="alert" className="text-danger">{catalog.error.message}</p>}
      {data && <>
        <label className="block text-caption">Computer
          <select aria-label="Computer" className={inputClass} value={selectedDevice} disabled={active || submitting}
            onChange={event => setDevice(event.target.value)}>
            <option value="">Select a computer</option>
            {data.devices.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
          </select>
        </label>
        <p role="status" className={data.agent.ready ? "text-success" : "text-text-muted"}>
          {data.agent.message || (data.agent.ready ? "Desktop agent ready." : "Keep the desktop agent open. Finish other StarCraft II work before starting a game.")}
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-caption">Opponent
            <select aria-label="Opponent" className={inputClass} value={selectedBot?.id ?? ""} onChange={event => setBot(event.target.value)} disabled={active || submitting}>
              {data.bots.map(value => <option key={value.id} value={value.id}>{value.label} ({value.race})</option>)}
            </select>
          </label>
          <label className="block text-caption">Your race
            <select aria-label="Your race" className={inputClass} value={race} onChange={event => setRace(event.target.value as BotRace)} disabled={active || submitting}>
              {["Protoss", "Terran", "Zerg"].map(value => <option key={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-caption">Map
          <select aria-label="Map" className={inputClass} value={selectedMap?.id ?? ""} onChange={event => setMap(event.target.value)} disabled={active || submitting}>
            {data.maps.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
          </select>
        </label>
        {selectedBot && <p className="text-caption text-text-dim">Opponent limit: {selectedBot.maxApm} APM. {selectedBot.cameraRestricted ? "Camera and selection restrictions apply." : "Global own-unit control; enemy fog still applies."}</p>}
      </>}
      <button type="button" className={`${buttonClass} bg-accent text-white`} disabled={!ready || active || submitting} onClick={start}>
        {submitting ? "Starting local game…" : "Start local game"}
      </button>
      {launchError && <p role="alert" className="text-danger">{launchError}</p>}
    </section>
    {current && <section aria-label="Game status" className="space-y-3 rounded-xl border border-border p-5">
      <h2 className="text-lg font-semibold">Current game</h2>
      <p role="status">{session?.status === "unknown" ? "Awaiting confirmation from the desktop agent." : session?.status || "Checking saved launch…"}</p>
      {session?.botLabel && <p>{session.botLabel}{session.map ? ` · ${session.map}` : ""}</p>}
      {session?.result && <p>Result: {session.result}</p>}
      {session?.error && <p role="alert" className="text-danger">{session.error}</p>}
      {status.error && <p role="alert">{status.error.message} The saved launch is retained.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} onClick={() => void status.mutate()}>Check status</button>
        {current.start && (session?.status === "unknown" || (launchError && !session)) && <button type="button" className={buttonClass}
          disabled={submitting} onClick={() => void sendStart(current.start!)}>Retry same start request</button>}
        {active && <button type="button" className={`${buttonClass} text-danger`} disabled={stopping || submitting} onClick={() => void stop()}>
          {stopping ? "Stopping…" : "Stop local game"}
        </button>}
      </div>
      {stopError && <p role="alert" className="text-danger">{stopError}</p>}
    </section>}
  </div>;
}
