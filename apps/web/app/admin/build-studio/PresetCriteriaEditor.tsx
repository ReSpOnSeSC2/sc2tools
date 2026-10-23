"use client";
import { Button } from "@/components/ui/Button";
import type { PolicyCondition, PresetEntry } from "./studioTypes";

const input = "min-h-11 w-full min-w-0 rounded border border-border bg-bg px-3 py-2 text-caption";
const count = (): PolicyCondition => ({ kind: "count", name: "WarpPrism", category: "unit", clock: "completion", min: 1, beforeSeconds: 360 });
export function secondsText(value: number) { return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`; }
export function parseSeconds(value: string): number | null {
  if (!/^\d{1,4}:[0-5]\d$/.test(value)) return null;
  const [minutes, seconds] = value.split(":").map(Number); const total = minutes * 60 + seconds;
  return total <= 86400 ? total : null;
}

export function PresetCriteriaEditor({ value, onChange }: { value: PresetEntry; onChange: (next: PresetEntry) => void }) {
  const replace = (group: number, index: number, rule: PolicyCondition) => onChange({ ...value, anyOf: value.anyOf.map((rows, at) => at === group ? rows.map((old, i) => i === index ? rule : old) : rows) });
  return <div className="space-y-4">
    <label className="block">Detection behavior<select className={input} value={!value.enabled ? "disabled" : value.mode || "replacement"} onChange={event => {
      const mode = event.target.value;
      onChange({ ...value, enabled: mode !== "disabled", mode: mode === "released" ? "released" : "replacement", anyOf: mode === "released" ? [] : value.anyOf.length ? value.anyOf : [[count()]] });
    }}><option value="released">Keep released decision tree</option><option value="replacement">Replace detection criteria</option><option value="disabled">Disable this preset label</option></select></label>
    {value.mode === "released" ? <p className="text-caption text-text-muted">Reference text and steps can change while the released decision tree keeps detecting this label.</p> : !value.enabled ? <p className="text-caption text-warning">This label will no longer match. A released match for it becomes Unclassified.</p> : <>
      <p className="text-caption text-text-muted">All conditions in one alternative must pass; any alternative can match. Completion uses recorded real-unit completion. Structure completion is unavailable. Raw structure presence accepts an observed start or completion; construction-start counts exclude duplicate completion observations.</p>
      {value.anyOf.map((group, groupIndex) => <fieldset key={groupIndex} className="min-w-0 space-y-3 rounded border border-border p-3"><legend>Alternative {groupIndex + 1}</legend>
        {group.map((rule, index) => <ConditionRow key={index} value={rule} label={`Alternative ${groupIndex + 1} condition ${index + 1}`} onChange={next => replace(groupIndex, index, next)} onRemove={() => onChange({ ...value, anyOf: value.anyOf.map((rows, at) => at === groupIndex ? rows.filter((_, i) => i !== index) : rows) })} />)}
        <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={group.length >= 30} onClick={() => onChange({ ...value, anyOf: value.anyOf.map((rows, at) => at === groupIndex ? [...rows, count()] : rows) })}>Add condition</Button><Button variant="ghost" onClick={() => onChange({ ...value, anyOf: value.anyOf.filter((_, at) => at !== groupIndex) })}>Remove alternative {groupIndex + 1}</Button></div>
      </fieldset>)}
      <Button variant="secondary" disabled={value.anyOf.length >= 8} onClick={() => onChange({ ...value, anyOf: [...value.anyOf, [count()]] })}>Add alternative</Button>
      <label className="block">Priority (lower matches first)<input className={input} type="number" min={0} max={1000000} value={value.priority} onChange={event => onChange({ ...value, priority: Number(event.target.value) })} /></label>
    </>}
  </div>;
}

function ConditionRow({ value, onChange, onRemove, label }: { value: PolicyCondition; onChange: (next: PolicyCondition) => void; onRemove: () => void; label: string }) {
  const isCount = value.kind === "count" || value.kind === "exists";
  return <fieldset className="min-w-0 space-y-2 rounded bg-bg-elevated p-3"><legend className="text-caption">{label}</legend>
    <div className="grid min-w-0 gap-2 sm:grid-cols-2">
      <label>Test<select className={input} value={value.kind} onChange={event => {
        const kind = event.target.value as PolicyCondition["kind"];
        const common = { kind, category: value.category, clock: value.clock };
        onChange(kind === "count" || kind === "exists" ? { ...common, name: value.name || value.names?.[0] || "WarpPrism", beforeSeconds: value.beforeSeconds || 360, ...(kind === "count" ? { min: 1 } : {}) } : { ...common, names: value.names || [value.name || "Stargate", "TwilightCouncil"] });
      }}><option value="count">Count by deadline</option><option value="exists">Exists by deadline</option><option value="order">All in strict order</option><option value="first">First before alternatives</option></select></label>
      <label>Category<select className={input} value={value.category} onChange={event => onChange({ ...value, category: event.target.value as PolicyCondition["category"], clock: event.target.value === "building" ? "start" : value.clock })}><option value="unit">Real unit</option><option value="building">Structure</option><option value="upgrade">Upgrade</option></select></label>
      <label>Entity {isCount ? "name" : "names, in order"}<input className={input} value={isCount ? value.name : value.names?.join(", ")} onChange={event => onChange(isCount ? { ...value, name: event.target.value } : { ...value, names: event.target.value.split(",").map(name => name.trim()) })} /></label>
      <label>Clock<select className={input} value={value.clock} onChange={event => onChange({ ...value, clock: event.target.value as PolicyCondition["clock"] })}><option value="start">Construction / production start</option>{value.category !== "building" ? <option value="completion">Recorded completion</option> : null}<option value="recorded">Raw recorded observation</option></select></label>
      {isCount ? <label>Deadline (m:ss)<Deadline value={value.beforeSeconds || 0} onChange={beforeSeconds => onChange({ ...value, beforeSeconds })} /></label> : null}
      {value.kind === "count" ? <><label>Minimum<input className={input} type="number" min={0} max={1000} value={value.min ?? ""} onChange={event => onChange({ ...value, min: event.target.value === "" ? undefined : Number(event.target.value) })} /></label><label>Maximum (optional)<input className={input} type="number" min={0} max={1000} value={value.max ?? ""} onChange={event => onChange({ ...value, max: event.target.value === "" ? undefined : Number(event.target.value) })} /></label></> : null}
    </div>
    {isCount && value.category === "building" ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={value.proxy === true} onChange={event => { const next = { ...value }; if (event.target.checked) next.proxy = true; else delete next.proxy; onChange(next); }} />Canonical proxy only (eligible structures)</label> : null}
    {value.kind === "first" ? <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={value.allowTies === true} onChange={event => onChange({ ...value, allowTies: event.target.checked })} />Allow tied first observations</label> : null}
    <Button variant="ghost" size="sm" onClick={onRemove}>Remove condition</Button>
  </fieldset>;
}
function Deadline({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return <input className={input} key={value} defaultValue={secondsText(value)} onBlur={event => { const parsed = parseSeconds(event.target.value); event.target.setCustomValidity(parsed === null ? "Use m:ss, up to 1440:00." : ""); if (parsed !== null) onChange(parsed); }} required pattern="[0-9]{1,4}:[0-5][0-9]" />;
}
