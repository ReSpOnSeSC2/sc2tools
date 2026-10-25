"use client";
import { useId } from "react";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { Icon } from "@/components/ui/Icon";
import { BUILD_TOKENS } from "@/lib/buildTokens";
import { buildTokenError, pickerRace } from "@/lib/buildTokenSelection";
const cachedOptions = new Map<string, readonly ComboboxOption[]>();
function optionsFor(race: ReturnType<typeof pickerRace>) {
  const key = race ?? "all", cached = cachedOptions.get(key);
  if (cached) return cached;
  const options = BUILD_TOKENS.filter(token => !race || token.race === race).map(token => ({
    value: token.token, label: token.label, searchTerms: [token.entity, token.race, token.kind],
    description: `${token.kind[0].toUpperCase()}${token.kind.slice(1)} · ${token.token}${token.proxyEligible ? " · Proxy eligible" : ""}`,
    icon: <Icon name={token.entity} kind={token.kind} decorative size="md" />,
  }));
  cachedOptions.set(key, options); return options;
}

export function TokenPicker({ value, race, onChange, autoFocus = false, label = "Unit, building or upgrade", disabled = false, allowUnknown = false }: {
  value: string; race?: string; onChange: (value: string) => void; autoFocus?: boolean; label?: string; disabled?: boolean; allowUnknown?: boolean;
}) {
  const id = useId(), selectedRace = pickerRace(race), error = buildTokenError(value, race);
  const options = optionsFor(selectedRace);
  return <div className="min-w-0 flex-1 space-y-1">
    <Combobox key={selectedRace ?? "all"} label={label} value={value} onChange={onChange} onInputChange={onChange} options={options}
      autoFocus={autoFocus} disabled={disabled} invalid={!!error && !allowUnknown} describedBy={error ? `${id}-error` : undefined} placeholder="Search actions…" emptyMessage={allowUnknown ? "Unknown reference text is kept. You can still save it." : "No known actions match. Try another name."} />
    {error ? <p id={`${id}-error`} className={`text-caption ${allowUnknown ? "text-text-muted" : "text-danger"}`}>{allowUnknown ? "Reference text — not a known action for this race. Saving is allowed." : error}</p> : null}
  </div>;
}
