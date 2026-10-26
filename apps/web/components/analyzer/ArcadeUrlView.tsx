"use client";
import { useUrlState } from "@/lib/useUrlState";
import { ArcadeTab, type ArcadeSub } from "./ArcadeTab";
const options = { defaultValue: "today" as ArcadeSub, parse: (raw: string | null): ArcadeSub => ["quick-play", "collection", "my-stats"].includes(raw || "") ? raw as ArcadeSub : "today", serialize: (value: ArcadeSub) => value === "today" ? "daily" : value };
export function ArcadeUrlView() {
  const tab = useUrlState("tab", options);
  return <ArcadeTab sub={tab.value} onSubChange={tab.setValue} />;
}
