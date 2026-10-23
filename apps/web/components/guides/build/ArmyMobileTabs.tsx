"use client";
import { useEffect, useState, type ReactNode } from "react";
import { Tabs } from "@/components/ui/Tabs";

/** Server HTML stacks every snapshot; JavaScript enhances that into a phone tabset. */
export function ArmyMobileTabs({ cards }: { cards: readonly { key: string; label: string; content: ReactNode }[] }) {
  const [enhanced, setEnhanced] = useState(false);
  const [active, setActive] = useState(cards[0]?.key ?? "");
  useEffect(() => setEnhanced(true), []);
  if (!enhanced) return <div className="space-y-4 md:hidden">{cards.map((card) => <div key={card.key}>{card.content}</div>)}</div>;
  const selected = cards.some((card) => card.key === active) ? active : cards[0]?.key ?? "";
  return <div className="md:hidden"><Tabs value={selected} onValueChange={setActive}><Tabs.List ariaLabel="Army snapshots">{cards.map((card) => <Tabs.Trigger key={card.key} value={card.key}>{card.label}</Tabs.Trigger>)}</Tabs.List>{cards.map((card) => <Tabs.Content key={card.key} value={card.key}>{card.content}</Tabs.Content>)}</Tabs></div>;
}
