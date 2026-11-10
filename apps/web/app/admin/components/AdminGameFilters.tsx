"use client";

import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Select } from "@/components/ui/Select";
import { RESULT_FILTERS, RESULT_FILTER_LABEL, type AdminResultFilter } from "./adminResult";

/**
 * Result chips (All / Wins / Losses / Ties) and a Map select, plus an
 * optional User select on the global player page. The page keeps every
 * value in its URL (useAdminQueryState), where a change also resets the
 * cursor. A selected value missing from the options (an off-page map in a
 * shared link) stays listed so the select never misreports the filter.
 */
export function AdminGameFilters({ result, map, maps, onResult, onMap, user, users, onUser }: {
  result: AdminResultFilter;
  map: string;
  maps: readonly string[];
  onResult: (result: AdminResultFilter) => void;
  onMap: (map: string) => void;
  user?: string;
  users?: ReadonlyArray<{ userId: string; label: string }>;
  onUser?: (userId: string) => void;
}) {
  const mapOptions = map && !maps.includes(map) ? [map, ...maps] : maps;
  const userOptions = users && user && !users.some((row) => row.userId === user) ? [{ userId: user, label: user }, ...users] : users;
  return (
    <div className="space-y-3">
      <div role="group" aria-label="Filter by result" className="flex flex-wrap gap-2">
        {RESULT_FILTERS.map((value) => (
          <Button key={value} size="sm" variant={result === value ? "primary" : "secondary"} aria-pressed={result === value}
            onClick={() => onResult(value)}>{RESULT_FILTER_LABEL[value]}</Button>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Map">
          <Select value={map} onChange={(event) => onMap(event.target.value)}>
            <option value="">All maps</option>
            {mapOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </Select>
        </Field>
        {userOptions && onUser ? (
          <Field label="User">
            <Select value={user || ""} onChange={(event) => onUser(event.target.value)}>
              <option value="">All users</option>
              {userOptions.map((row) => <option key={row.userId} value={row.userId}>{row.label}</option>)}
            </Select>
          </Field>
        ) : null}
      </div>
    </div>
  );
}
