import type { Metadata } from "next";
import { LazyWidgetPlayground } from "@/components/stream-studio/LazyWidgetPlayground";
export const metadata: Metadata = { title: "Widget playground", description: "Try every Stream Studio widget and theme with local sample data, without sending anything to OBS.", robots: { index: false, follow: true } };
export default async function WidgetPlaygroundPage({ searchParams }: { searchParams: Promise<{ widget?: string }> }) {
  const query = await searchParams;
  return <article className="mx-auto max-w-7xl space-y-5 p-3 sm:p-6"><h1 className="font-display text-h1">Widget playground</h1><p className="text-body text-text-muted">Choose a widget, theme and scenario. These are illustrative samples; your real stream data and timing may differ.</p><LazyWidgetPlayground initialWidget={typeof query.widget === "string" ? query.widget : "opponent"} autoLoad /></article>;
}
