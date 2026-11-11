"use client";

import { useEffect, useId, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { formatDateTime } from "@/lib/i18n/format";
import { LazyHelpLink } from "@/components/help/LazyHelpLink";
import { useSaveSource } from "./SettingsContext";
import { REWARD_ACTIONS, SETTLEMENT_OPTIONS, useTwitchRewardSettings, type Reward, type RewardActivity, type RewardMapping, type RewardSettings } from "./twitchRewardSettingsModel";

const EMPTY: RewardSettings = { enabled: false, target: null, mappings: [] };
const CHECKBOX = "h-5 w-5 shrink-0 accent-accent";
const FIELD = "block min-w-0 space-y-1 text-caption";
const LABELS: Record<string, string> = {
  pending: "Queued", dispatching: "Dispatching", awaiting_game: "Waiting for next game", applied: "Dispatched", skipped: "Unavailable", unknown: "Check the result",
  channel_offline: "Channel offline", viewer_cooldown: "Viewer cooldown", poll_open: "A poll is already open", next_game_unavailable: "No eligible next game",
  next_game_already_queued: "A reroll is already queued", overlay_unavailable: "Overlay unavailable", overlay_source_unavailable: "Browser Source unavailable",
  audio_unavailable: "Audio source unavailable", viewer_input_required: "Viewer input required", viewer_blocked: "Viewer blocked", broll_unavailable: "B-roll cover unavailable",
  builds_unavailable: "Saved builds unavailable", dispatch_unconfirmed: "Dispatch unconfirmed", connection_unavailable: "Twitch permission unavailable",
  mapping_changed: "Mapping changed", randomizer_unavailable: "Randomizer unavailable", redemption_expired: "Redemption expired",
  fulfilled: "Fulfilled on Twitch", refunded: "Refunded on Twitch", unmanaged: "Settle manually on Twitch", already_settled: "Already settled on Twitch", unconfirmed: "Settlement unconfirmed",
};

export function SettingsTwitchRewards() {
  const { isLoaded, userId } = useAuth();
  if (!isLoaded) return <p role="status" className="text-caption">Loading account…</p>;
  return userId ? <RewardEditor key={userId} owner={userId} /> : <p className="text-caption">Sign in to manage reward actions.</p>;
}

function RewardEditor({ owner }: { owner: string }) {
  const id = useId();
  const model = useTwitchRewardSettings(owner);
  const { status, catalog, busy, error, message } = model;
  const [draft, setDraft] = useState<RewardSettings>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [picked, setPicked] = useState("");
  useEffect(() => { if (status && !dirty) setDraft(status.settings); }, [status, dirty]);
  const change = (patch: Partial<RewardSettings>) => { setDraft(previous => ({ ...previous, ...patch })); setDirty(true); };
  const update = (rewardId: string, patch: Partial<RewardMapping>) => change({ mappings: draft.mappings.map(row => row.rewardId === rewardId ? { ...row, ...patch } : row) });
  const available = catalog.filter(row => !draft.mappings.some(mapping => mapping.rewardId === row.id));
  const byId = new Map(catalog.map(reward => [reward.id, reward]));
  const targetValid = status?.targets.some(target => target.id === draft.target);
  const mappingsValid = draft.mappings.every(row => Number.isInteger(row.cooldownSec) && row.cooldownSec >= 5 && row.cooldownSec <= 3600
    && (row.action !== "buildVote" || row.buildIds.length >= 2));
  const blocked = !status ? "Load Twitch reward settings before saving" : !mappingsValid ? "Fix the reward cooldowns or build selections"
    : draft.enabled && (!status.permission || !targetValid || !draft.mappings.some(row => row.enabled)) ? "Connect Twitch, choose an overlay and enable a mapping" : null;
  useSaveSource("chat", {
    label: "Twitch channel points", dirty, blocked, order: 3,
    save: async () => {
      if (!dirty) return true;
      if (!await model.save(draft)) return false;
      setDirty(false); return true;
    },
    reset: () => { setDraft(status?.settings ?? EMPTY); setDirty(false); },
  }, "twitch-rewards");

  return <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-3">
    <h3 id={`${id}-title`} className="text-body font-semibold">Twitch Channel Points rewards</h3>
    <p className="text-caption text-text-muted">Run a Studio action when someone redeems a reward on your live channel. Connect rewards separately, choose an overlay, then turn on the mappings you want and save.</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" disabled={busy || !status?.available} onClick={() => void model.connect()}>{status?.permission ? "Reconnect reward actions" : "Connect reward actions"}</Button>
      <Button variant="secondary" disabled={busy} onClick={() => void model.refresh()}>Refresh permission and activity</Button>
      <Button variant="secondary" disabled={busy || !status?.permission} onClick={() => void model.loadCatalog()}>Load Twitch rewards</Button>
    </div>
    {error ? <p role="alert" className="text-caption text-danger">{error}</p> : null}
    {message ? <p role="status" className="text-caption">{message}</p> : null}
    {!status && !error ? <p role="status" className="text-caption">Loading reward settings…</p> : null}
    <fieldset disabled={busy || !status} className="min-w-0 space-y-3">
      <label className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" className={CHECKBOX} checked={draft.enabled} onChange={event => change({ enabled: event.target.checked })} /> Run mapped reward actions</label>
      <label className={FIELD}>Overlay target<Select value={draft.target ?? ""} onChange={event => change({ target: event.target.value || null })}>
        <option value="">Choose an overlay</option>
        {draft.target && !targetValid ? <option value={draft.target}>Unavailable overlay</option> : null}
        {status?.targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
      </Select></label>
      <div className="grid min-w-0 items-end gap-2 sm:grid-cols-[1fr_auto]">
        <label className={FIELD}>Reward to map<Select value={picked} onChange={event => setPicked(event.target.value)}>
          <option value="">Choose a Twitch reward</option>
          {available.map(reward => <option key={reward.id} value={reward.id}>{reward.title}</option>)}
        </Select></label>
        <Button variant="secondary" disabled={!available.some(reward => reward.id === picked) || draft.mappings.length >= 20} onClick={() => {
          change({ mappings: [...draft.mappings, { rewardId: picked, enabled: false, action: "recap", cooldownSec: 60, settlement: "none", buildIds: [] }] }); setPicked("");
        }}>Add mapping</Button>
      </div>
      {draft.mappings.map(row => <MappingEditor key={row.rewardId} row={row} reward={byId.get(row.rewardId)} builds={status?.builds ?? []}
        update={patch => update(row.rewardId, patch)} remove={() => change({ mappings: draft.mappings.filter(mapping => mapping.rewardId !== row.rewardId) })} />)}
    </fieldset>
    {status?.permission ? <CreateReward busy={busy} create={model.create} /> : null}
    <Activity rows={status?.activity ?? []} rewards={byId} />
    <LazyHelpLink slug="viewer-engagement" anchor="twitch-reward-actions" className="inline-flex min-h-11 items-center underline">Twitch reward actions help</LazyHelpLink>
  </section>;
}

function MappingEditor({ row, reward, builds, update, remove }: {
  row: RewardMapping; reward?: Reward; builds: { id: string; name: string }[];
  update: (patch: Partial<RewardMapping>) => void; remove: () => void;
}) {
  const fieldId = useId();
  const manageable = reward?.manageable && !reward.autoSkipsQueue;
  return <fieldset className="min-w-0 space-y-2 rounded border border-border p-3">
    <legend className="max-w-full break-words px-1 text-caption font-semibold">{reward?.title || "Saved Twitch reward"}</legend>
    <label className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" className={CHECKBOX} checked={row.enabled} onChange={event => update({ enabled: event.target.checked })} /> Enable mapping</label>
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      <label className={FIELD}>Action<Select value={row.action} onChange={event => update({ action: event.target.value as RewardMapping["action"] })}>
        {Object.entries(REWARD_ACTIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </Select></label>
      <label className={FIELD} htmlFor={`${fieldId}-cooldown`}>Viewer cooldown (seconds)<Input id={`${fieldId}-cooldown`} type="number" min={5} max={3600} step={1} value={row.cooldownSec || ""} onChange={event => update({ cooldownSec: Number(event.target.value) })} /></label>
      <label className={FIELD}>Settlement<Select value={row.settlement} onChange={event => update({ settlement: event.target.value as RewardMapping["settlement"] })}>
        {Object.entries(SETTLEMENT_OPTIONS).map(([value, label]) => <option key={value} value={value} disabled={value !== "none" && !manageable && value !== row.settlement}>{label}</option>)}
      </Select></label>
    </div>
    {!manageable ? <p className="text-caption text-text-muted">Automatic settlement needs a reward created here with Twitch’s request queue enabled.</p> : null}
    {row.action === "buildVote" ? <fieldset className="space-y-1"><legend className="text-caption">Choose two or three saved builds</legend>
      <div className="max-h-44 overflow-y-auto">{builds.map(build => <label key={build.id} className="flex min-h-9 items-center gap-2 break-words text-caption">
        <input type="checkbox" className={CHECKBOX} checked={row.buildIds.includes(build.id)} disabled={row.buildIds.length >= 3 && !row.buildIds.includes(build.id)} onChange={event => update({ buildIds: event.target.checked ? [...row.buildIds, build.id] : row.buildIds.filter(id => id !== build.id) })} />{build.name}
      </label>)}</div></fieldset> : null}
    <Button variant="secondary" onClick={remove}>Remove mapping</Button>
  </fieldset>;
}

function CreateReward({ create, busy }: { create: (title: string, cost: number, requiresInput: boolean) => Promise<boolean>; busy: boolean }) {
  const fieldId = useId();
  const [title, setTitle] = useState("");
  const [cost, setCost] = useState(500);
  const [requiresInput, setRequiresInput] = useState(false);
  return <details className="space-y-2 rounded border border-border p-3">
    <summary className="min-h-9 cursor-pointer text-caption font-semibold">Create a Twitch reward</summary>
    <p className="text-caption text-text-muted">Rewards created here support automatic fulfillment or refunds. They start disabled on Twitch.</p>
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      <label className={FIELD} htmlFor={`${fieldId}-title`}>Reward title<Input id={`${fieldId}-title`} value={title} maxLength={45} onChange={event => setTitle(event.target.value)} /></label>
      <label className={FIELD} htmlFor={`${fieldId}-cost`}>Channel Points cost<Input id={`${fieldId}-cost`} type="number" value={cost || ""} min={1} max={1_000_000} step={1} onChange={event => setCost(Number(event.target.value))} /></label>
    </div>
    <label className="flex min-h-11 items-center gap-2 text-caption"><input type="checkbox" className={CHECKBOX} checked={requiresInput} onChange={event => setRequiresInput(event.target.checked)} /> Require viewer text</label>
    <Button variant="secondary" disabled={busy || !title.trim() || !Number.isInteger(cost) || cost < 1 || cost > 1_000_000} onClick={async () => {
      if (await create(title, cost, requiresInput)) setTitle("");
    }}>Create disabled reward on Twitch</Button>
  </details>;
}

function Activity({ rows, rewards }: { rows: RewardActivity[]; rewards: Map<string, Reward> }) {
  return <div className="space-y-1"><h4 className="text-caption font-semibold">Recent reward activity</h4>
    {rows.length ? <ul className="divide-y divide-border">{rows.map((row, index) => <li key={`${row.receivedAt}-${index}`} className="grid min-w-0 gap-1 py-2 text-caption sm:grid-cols-2">
      <span className="break-words">{rewards.get(row.rewardId)?.title || row.rewardTitle || "Twitch reward"} · {REWARD_ACTIONS[row.action]}</span>
      <span className="text-text-muted"><time dateTime={row.receivedAt}>{formatDateTime(row.receivedAt)}</time> · {LABELS[row.state] ?? "Unavailable"}
        {row.reason && LABELS[row.reason] ? ` · ${LABELS[row.reason]}` : ""}{row.settlement && LABELS[row.settlement] ? ` · ${LABELS[row.settlement]}` : ""}</span>
    </li>)}</ul> : <p className="text-caption text-text-muted">No redemptions yet.</p>}
  </div>;
}
