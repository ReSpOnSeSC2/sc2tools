"use client";
import { useId, useMemo } from "react";
import { Combobox } from "@/components/ui/Combobox";
import { Icon } from "@/components/ui/Icon";
import { BUILD_TOKENS } from "@/lib/buildTokens";
import { buildTokenError, pickerRace } from "@/lib/buildTokenSelection";

export function TokenPicker({ value, race, onChange, autoFocus = false, label = "Unit, building or upgrade", disabled = false }: {
  value: string; race?: string; onChange: (value: string) => void; autoFocus?: boolean; label?: string; disabled?: boolean;
}) {
  const id = useId(), selectedRace = pickerRace(race), error = buildTokenError(value, race);
  const options = useMemo(() => BUILD_TOKENS.filter(token => !selectedRace || token.race === selectedRace).map(token => ({
    value: token.token, label: token.label, searchTerms: [token.entity, token.race, token.kind],
    description: `${token.kind[0].toUpperCase()}${token.kind.slice(1)} · ${token.token}${token.proxyEligible ? " · Proxy eligible" : ""}`,
    icon: <Icon name={token.entity} kind={token.kind} decorative size="md" />,
  })), [selectedRace]);
  return <div className="min-w-0 flex-1 space-y-1">
    <Combobox key={selectedRace ?? "all"} label={label} value={value} onChange={onChange} onInputChange={onChange} options={options}
      autoFocus={autoFocus} disabled={disabled} invalid={!!error} describedBy={error ? `${id}-error` : undefined} placeholder="Search actions…" emptyMessage="No known actions match. Try another name." />
    {error ? <p id={`${id}-error`} className="text-caption text-danger">{error}</p> : null}
  </div>;
}
