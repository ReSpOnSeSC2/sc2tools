"use client";
import dynamic from "next/dynamic";

import { OverlayPreviewContext } from "@/lib/overlayPreviewContext";
import type { OverlayLayout } from "@/lib/overlayLayout";
import { OverlayPlacement } from "./OverlayPlacement";
import type { LiveGamePayload } from "./types";
import type { WidgetId } from "./widgetLifecycle";
import type { RandomizerConfig } from "@/lib/randomizer/types";
import { OpponentWidget } from "./widgets/OpponentWidget";
import { MatchResultWidget } from "./widgets/MatchResultWidget";
import { PostGameWidget } from "./widgets/PostGameWidget";
import { MmrDeltaWidget } from "./widgets/MmrDeltaWidget";
import { StreakWidget } from "./widgets/StreakWidget";
import { CheeseWidget } from "./widgets/CheeseWidget";
import { RematchWidget } from "./widgets/RematchWidget";
import { RivalWidget } from "./widgets/RivalWidget";
import { RankWidget } from "./widgets/RankWidget";
import { MetaWidget } from "./widgets/MetaWidget";
import { TopBuildsWidget } from "./widgets/TopBuildsWidget";
import { FavOpeningWidget } from "./widgets/FavOpeningWidget";
import { BestAnswerWidget } from "./widgets/BestAnswerWidget";
import { ScoutingWidget } from "./widgets/ScoutingWidget";
import { SessionWidget, type SessionSummary } from "./widgets/SessionWidget";
import { RandomizerWidget } from "./widgets/RandomizerWidget";

export const CompositeSeriesWidget = dynamic(() => import("./widgets/SeriesWidget").then(module => module.SeriesWidget), { ssr: false });

// Live and test layers share these payload-only cards and their slot order.
export const COMPOSITE_PAYLOAD_WIDGETS = [
  ["match-result", MatchResultWidget],
  ["post-game", PostGameWidget],
  ["mmr-delta", MmrDeltaWidget],
  ["streak", StreakWidget],
  ["cheese", CheeseWidget],
  ["rematch", RematchWidget],
  ["rival", RivalWidget],
  ["rank", RankWidget],
  ["meta", MetaWidget],
  ["topbuilds", TopBuildsWidget],
  ["fav-opening", FavOpeningWidget],
  ["best-answer", BestAnswerWidget],
] as const;

/** A separate tree keeps practice/randomizer/animation state in the real
 * widgets mounted while sample content temporarily covers their slots. */
export function CompositeTestWidgets({ live, session, randomizer, targets, layout }: {
  live: LiveGamePayload | null; session: SessionSummary | null; randomizer: RandomizerConfig | null; targets: (id: WidgetId) => boolean; layout?: OverlayLayout;
}) {
  const cards = [
    { id: "opponent", card: <OpponentWidget live={live} liveGame={null} /> },
    ...COMPOSITE_PAYLOAD_WIDGETS.map(([id, Widget]) => ({ id, card: <Widget live={live} /> })),
    { id: "scouting", card: <ScoutingWidget live={live} liveGame={null} /> },
    { id: "session", card: <SessionWidget live={live} session={session} /> },
    { id: "randomizer", card: <RandomizerWidget live={live} liveGame={null} config={randomizer} visible /> },
    { id: "series", card: <CompositeSeriesWidget rawSeries={null} preview composite /> },
  ] as const;
  const visible = cards.filter(({ id }) => targets(id));
  if (!visible.length) return null;
  return <OverlayPreviewContext.Provider value={true}><div data-overlay-layer="test" className="absolute inset-0 z-40">
    {visible.map(({ id, card }) => <div key={id} data-layout-widget={id} className="contents">
      <OverlayPlacement placement={layout?.[id]}>{card}</OverlayPlacement>
    </div>)}
  </div></OverlayPreviewContext.Provider>;
}
