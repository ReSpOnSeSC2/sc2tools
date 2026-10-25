"use client";
import { useUrlState } from "@/lib/useUrlState";
import { BuildsTab } from "./BuildsTab";
const options = { defaultValue: "", parse: (raw: string | null) => raw && raw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : "", serialize: (value: string) => value || null };
export function BuildsUrlView() {
  const search = useUrlState("q", options);
  return <BuildsTab search={search.value} onSearchChange={search.setValue} />;
}
