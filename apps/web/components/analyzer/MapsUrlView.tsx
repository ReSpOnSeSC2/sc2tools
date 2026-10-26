"use client";
import { useUrlState } from "@/lib/useUrlState";
import { BattlefieldTab } from "./BattlefieldTab";
const options = { defaultValue: null as string | null, parse: (raw: string | null) => raw && raw.length <= 200 && !/[\u0000-\u001f\u007f]/.test(raw) ? raw : null, serialize: (value: string | null) => value };
export function MapsUrlView() {
  const focus = useUrlState("focus", options);
  return <BattlefieldTab focus={focus.committedValue} />;
}
