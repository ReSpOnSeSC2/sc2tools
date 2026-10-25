"use client";
import dynamic from "next/dynamic";
const LazySeriesWidget = dynamic(() => import("./widgets/SeriesWidget").then(module => module.SeriesWidget), { ssr: false });

import { OverlayPreviewContext } from "@/lib/overlayPreviewContext";
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

/** A separate tree keeps practice/randomizer/animation state in the real
 * widgets mounted while sample content temporarily covers their slots. */
export function CompositeTestWidgets({ live, session, randomizer, targets }: {
  live: LiveGamePayload | null; session: SessionSummary | null; randomizer: RandomizerConfig | null; targets: (id: WidgetId) => boolean;
}) {
  const cards = [
    ["opponent", <OpponentWidget key="opponent" live={live} liveGame={null} />],
    ["match-result", <MatchResultWidget key="match-result" live={live} />],
    ["post-game", <PostGameWidget key="post-game" live={live} />],
    ["mmr-delta", <MmrDeltaWidget key="mmr-delta" live={live} />],
    ["streak", <StreakWidget key="streak" live={live} />],
    ["cheese", <CheeseWidget key="cheese" live={live} />],
    ["rematch", <RematchWidget key="rematch" live={live} />],
    ["rival", <RivalWidget key="rival" live={live} />],
    ["rank", <RankWidget key="rank" live={live} />],
    ["meta", <MetaWidget key="meta" live={live} />],
    ["topbuilds", <TopBuildsWidget key="topbuilds" live={live} />],
    ["fav-opening", <FavOpeningWidget key="fav-opening" live={live} />],
    ["best-answer", <BestAnswerWidget key="best-answer" live={live} />],
    ["scouting", <ScoutingWidget key="scouting" live={live} liveGame={null} />],
    ["session", <SessionWidget key="session" live={live} session={session} />],
    ["randomizer", <RandomizerWidget key="randomizer" live={live} liveGame={null} config={randomizer} visible />],
    ["series", <LazySeriesWidget key="series" rawSeries={null} preview composite />],
  ] as const;
  const visible = cards.filter(([id]) => targets(id));
  if (!visible.length) return null;
  return <OverlayPreviewContext.Provider value={true}><div data-overlay-layer="test" className="absolute inset-0 z-10">{visible.map(([, card]) => card)}</div></OverlayPreviewContext.Provider>;
}
