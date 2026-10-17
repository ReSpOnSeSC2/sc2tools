import React from "react";
import { createRoot } from "react-dom/client";
import * as Widgets from "../../components/overlay/widgets/PrePostFlow";
import { RandomizerStage } from "../../components/randomizer/RandomizerStage";
import { catalogCandidates } from "../../lib/randomizer/pool";
import { defaultRandomizerConfig } from "../../lib/randomizer/config";
import { spinResult, mulberry32 } from "../../lib/randomizer/engine";
import { WIDGET_GUIDES } from "../../lib/streamStudioLearn";
import { DEFAULT_APPEARANCE } from "../../lib/multichat/appearance";
import { DEFAULT_ALERTS } from "../../lib/multichat/alerts";
import { GHOST, LIVE, LIVE_GAME, NOW, STUDIO } from "./fixtures";
import "../../app/globals.css";
import "./style.css";

// Fixture-backed data only. This harness cannot contact the API, a chat relay,
// a socket, or the streamer's account. Static artwork is served by Vite.
Date.now = () => NOW;
window.fetch = async () => new Response(JSON.stringify({ config: {
  twitch: { enabled: true, channel: "example" }, kick: { enabled: true, chatroomId: "example" },
  youtube: { enabled: true, channel: "example" }, tiktok: { enabled: true, username: "example" },
  appearance: DEFAULT_APPEARANCE, alerts: DEFAULT_ALERTS, sound: { enabled: false }, tts: { enabled: false },
} }), { status: 200, headers: { "content-type": "application/json" } });
window.WebSocket = class extends EventTarget { constructor() { super(); throw new Error("Sockets are disabled in the visual fixture harness"); } } as unknown as typeof WebSocket;

const originalMatchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => query.includes("prefers-reduced-motion")
  ? { ...originalMatchMedia(query), matches: true, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null }
  : originalMatchMedia(query);

const requested = new URLSearchParams(window.location.search).get("widget");
const selected = WIDGET_GUIDES.find((guide) => guide.id === requested) ?? WIDGET_GUIDES[0];
const index = WIDGET_GUIDES.indexOf(selected);
const shared = { token: "public-fixture", live: LIVE, studioEvent: STUDIO };
const randomizer = defaultRandomizerConfig();
randomizer.sound = { enabled: false, volume: 0 };
randomizer.matchups.PvZ = { enabled: true, useCustomWeights: false, unitRandomizerEnabled: false, builds: catalogCandidates("PvZ").slice(0, 4).map(({ suggestedGateCount: _, ...build }) => ({ ...build, weight: 1 })) };
const outcome = { ...spinResult("PvZ", randomizer.matchups.PvZ, mulberry32(42))!, style: "wheel" as const, openingUnits: null };

const registry: Record<string, () => React.ReactNode> = {
  opponent: () => <Widgets.OpponentWidget live={LIVE} />,
  "match-result": () => <Widgets.MatchResultWidget live={LIVE} />,
  "post-game": () => <Widgets.PostGameWidget live={LIVE} />,
  "mmr-delta": () => <Widgets.MmrDeltaWidget live={LIVE} />,
  streak: () => <Widgets.StreakWidget live={LIVE} />,
  cheese: () => <Widgets.CheeseWidget live={LIVE} />,
  rematch: () => <Widgets.RematchWidget live={LIVE} />,
  rival: () => <Widgets.RivalWidget live={LIVE} />,
  rank: () => <Widgets.RankWidget live={LIVE} />,
  meta: () => <Widgets.MetaWidget live={LIVE} />,
  topbuilds: () => <Widgets.TopBuildsWidget live={LIVE} />,
  "fav-opening": () => <Widgets.FavOpeningWidget live={LIVE} />,
  "best-answer": () => <Widgets.BestAnswerWidget live={LIVE} />,
  scouting: () => <Widgets.ScoutingWidget live={LIVE} />,
  session: () => <Widgets.SessionWidget live={LIVE} session={LIVE.session!} />,
  randomizer: () => <RandomizerStage outcome={outcome} spinId={1} />,
  "ghost-build": () => <Widgets.GhostBuildWidget live={null} liveGame={LIVE_GAME} ghostParam={GHOST} voicePrefs={null} />,
  multichat: () => <Widgets.MultiChatWidget token="public-fixture" live={null} session={LIVE.session!} />,
  "chat-highlight": () => <Widgets.ChatHighlightWidget {...shared} />,
  "chat-poll": () => <Widgets.ChatPollWidget {...shared} />,
  "chat-alerts": () => <Widgets.ChatAlertsWidget {...shared} />,
  "stream-goals": () => <Widgets.StreamGoalsWidget {...shared} />,
  "build-profile": () => <Widgets.BuildProfileWidget {...shared} />,
  "session-recap": () => <Widgets.SessionRecapWidget {...shared} session={LIVE.session!} />,
  "countdown-timer": () => <Widgets.CountdownTimerWidget {...shared} />,
  "stats-ticker": () => <Widgets.StatsTickerWidget {...shared} session={LIVE.session!} />,
  "lower-third": () => <Widgets.LowerThirdWidget live={LIVE} />,
  "chat-oracle": () => <Widgets.ChatOracleWidget {...shared} />,
  "supporter-wall": () => <Widgets.SupporterWallWidget {...shared} />,
  "clip-flag": () => <Widgets.ClipFlagWidget {...shared} />,
  "stream-scene": () => <Widgets.StreamSceneWidget {...shared} />,
};

function navigate(id: string) { window.location.href = `/?widget=${encodeURIComponent(id)}`; }

createRoot(document.getElementById("root")!).render(
  <>
    <div className="controls">
      <button onClick={() => navigate(WIDGET_GUIDES[(index - 1 + WIDGET_GUIDES.length) % WIDGET_GUIDES.length].id)}>Previous</button>
      <label>Actual widget <select aria-label="Actual widget" value={selected.id} onChange={(event) => navigate(event.target.value)}>{WIDGET_GUIDES.map((guide) => <option key={guide.id} value={guide.id}>{guide.name}</option>)}</select></label>
      <button onClick={() => navigate(WIDGET_GUIDES[(index + 1) % WIDGET_GUIDES.length].id)}>Next</button>
      <span>{index + 1} / {WIDGET_GUIDES.length} · synthetic fixture · network disabled</span>
    </div>
    <div id="capture" data-widget={selected.id} className={`capture capture--${selected.id}`}>
      <div className="capture-label"><span>SC2 TOOLS · {selected.name.toUpperCase()}</span><span>ACTUAL WIDGET · SAMPLE DATA</span></div>
      <div className={`display-box display-box--${selected.id}`}>{registry[selected.id]?.() ?? <p>Missing fixture: {selected.id}</p>}</div>
      <div className="capture-footer">SC2 Tools Stream Studio <span>Default appearance · example data for learning</span></div>
    </div>
  </>,
);
