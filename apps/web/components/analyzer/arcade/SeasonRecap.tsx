"use client";

/**
 * Season Recap — the SC2 "Wrapped": a slide-style, shareable summary of
 * the player's ladder season built entirely from their own games (no
 * API route, no per-use cost). Reuses the Arcade share pipeline so the
 * final slide exports a 1200×630 PNG with the sc2tools.com link-back.
 *
 * Entry point is <SeasonRecap />, a card mounted at the top of the
 * Arcade tab; it opens a full-screen slide Modal.
 */

import { useMemo, useState } from "react";
import {
  CalendarRange,
  Share2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Skeleton } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { trackCardShared } from "@/lib/analytics/shareEvents";
import { useFilters } from "@/lib/filterContext";
import { anonymousOpponent, roundedMmrGap } from "@/lib/sharePrivacy";
import { useArcadeData } from "./hooks/useArcadeData";
import {
  computeSeasonRecap,
  MIN_RECAP_GAMES,
  resolveRecapWindow,
  type RecapMmrJourney,
  type RecapWindow,
  type SeasonRecapResult,
} from "@/lib/seasonRecap";
import {
  CARD_H,
  CARD_PAD,
  CARD_W,
  deliverShareCard,
  drawCardBackground,
  drawCardFooter,
  FONT_STACK,
  SHARE_LINK_URL,
  shareOutcome,
  wrapText,
} from "./ShareCard";
import { buildRecapSlides } from "./seasonRecapSlides";
import { RecapSlidesModal } from "./RecapSlidesModal";

function signedMmr(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${delta}`;
}

function inlineMmrSummary(journeys: RecapMmrJourney[]): string {
  if (journeys.length === 0) return "";
  if (journeys.length === 1) {
    const journey = journeys[0];
    return `, ${signedMmr(journey.delta)} MMR on ${journey.accountLabel}`;
  }
  return `, MMR tracked across ${journeys.length} Battle.net accounts`;
}

function cardMmrSummary(journeys: RecapMmrJourney[]): string {
  if (journeys.length === 0) return "—";
  if (journeys.length === 1) {
    const journey = journeys[0];
    return `${journey.accountLabel}: ${signedMmr(journey.delta)}`;
  }
  return `${journeys.length} Battle.net accounts`;
}

export function formatMmrStory(journeys: RecapMmrJourney[]): string | null {
  if (journeys.length === 0) return null;
  const accounts = journeys
    .slice(0, 2)
    .map((journey) => `${journey.accountLabel} ${signedMmr(journey.delta)}`);
  const remaining = journeys.length - accounts.length;
  const more =
    remaining > 0
      ? ` · +${remaining} more account${remaining === 1 ? "" : "s"}`
      : "";
  return `MMR: ${accounts.join(" · ")}${more}.`;
}

/**
 * Story lines drawn on the exported card: per-account MMR first, then up
 * to three season highlights.
 *
 * The card is public once shared, so other players appear by race only,
 * never by name (the in-app slides keep the names and exact figures: that
 * is the player's own private history). The upset is a gap rounded to the
 * nearest 100, the same as on the battle card: an exact gap could be
 * added to the MMR a battle card of that game prints, giving the other
 * player's rating. An upset that rounds to nothing is left off.
 */
export function recapCardStory(recap: SeasonRecapResult): string[] {
  const story: string[] = [];
  const mmrStory = formatMmrStory(recap.mmrJourneys);
  if (mmrStory) story.push(mmrStory);
  if (recap.topOpener) {
    story.push(
      `Signature opener: ${recap.topOpener.name} (${recap.topOpener.games} games).`,
    );
  }
  if (recap.nemesis) {
    story.push(
      `Nemesis: ${anonymousOpponent(recap.nemesis.race)} (you went ${recap.nemesis.record}).`,
    );
  }
  const upsetGap = recap.biggestUpset
    ? roundedMmrGap(recap.biggestUpset.mmrGap)
    : 0;
  if (upsetGap > 0) {
    story.push(`Biggest upset: beat a player about ${upsetGap} MMR above you.`);
  }
  return story.slice(0, 4);
}

/**
 * Text posted alongside the recap card. Totals and the player's own MMR
 * change only; no opponent appears in it.
 */
export function recapShareText(
  recap: SeasonRecapResult,
  recapWindow: RecapWindow,
): string {
  const wr =
    recap.totals.winrate !== null
      ? `${Math.round(recap.totals.winrate * 100)}% WR`
      : "";
  return [
    `My SC2 ${recapWindow.label} recap: ${recap.totals.games} games${
      wr ? `, ${wr}` : ""
    }${inlineMmrSummary(recap.mmrJourneys)}.`,
    "",
    SHARE_LINK_URL,
  ].join("\n");
}

export function SeasonRecap() {
  const { data, loading } = useArcadeData();
  const { seasons } = useFilters();
  const games = useMemo(() => data?.games ?? [], [data?.games]);

  const window = useMemo<RecapWindow>(
    () => resolveRecapWindow(games, new Date(), seasons),
    [games, seasons],
  );
  const recap = useMemo<SeasonRecapResult | null>(() => {
    if (games.length === 0) return null;
    return computeSeasonRecap(games, { since: window.since });
  }, [games, window.since]);

  const [open, setOpen] = useState(false);

  if (loading && games.length === 0) {
    return (
      <Card title="Season Recap">
        <Skeleton rows={2} />
      </Card>
    );
  }

  const enoughGames = recap !== null && recap.totals.games >= MIN_RECAP_GAMES;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-accent-cyan" aria-hidden />
          Season Recap
        </span>
      }
    >
      {enoughGames && recap ? (
        <div className="flex flex-wrap items-center justify-between gap-3 p-1">
          <div className="min-w-0">
            <p className="text-body text-text">
              Your <span className="font-semibold">{window.label}</span> in
              review — {recap.totals.games} games
              {recap.totals.winrate !== null
                ? `, ${Math.round(recap.totals.winrate * 100)}% win rate`
                : ""}
              {inlineMmrSummary(recap.mmrJourneys)}
              .
            </p>
            <p className="text-caption text-text-muted">
              A shareable slide-by-slide wrap-up of your ladder season.
            </p>
          </div>
          <Button
            variant="primary"
            onClick={() => setOpen(true)}
            iconLeft={<CalendarRange className="h-4 w-4" aria-hidden />}
          >
            Open my recap
          </Button>
        </div>
      ) : (
        <EmptyStatePanel
          size="sm"
          icon={<CalendarRange className="h-5 w-5 text-text-muted" aria-hidden />}
          title="Your recap unlocks at 10 games"
          description={`Play a few more ranked games this window (${window.label}) and your Season Recap appears here — nemesis, biggest upset, MMR journey and a shareable card.`}
        />
      )}

      {open && recap ? (
        <SeasonRecapModal
          recap={recap}
          window={window}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Card>
  );
}

function SeasonRecapModal({
  recap,
  window: recapWindow,
  onClose,
}: {
  recap: SeasonRecapResult;
  window: RecapWindow;
  onClose: () => void;
}) {
  const slides = useMemo(() => buildRecapSlides(recap, recapWindow), [recap, recapWindow]);
  return (
    <RecapSlidesModal
      title="Season Recap"
      description={recapWindow.label}
      slides={slides}
      onClose={onClose}
      shareAction={<ShareRecapButton recap={recap} window={recapWindow} />}
    />
  );
}

function ShareRecapButton({
  recap,
  window: recapWindow,
}: {
  recap: SeasonRecapResult;
  window: RecapWindow;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const onShare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const blob = await renderSeasonRecapPng(recap, recapWindow);
      if (!blob) {
        toast.error("Couldn't render the recap image");
        return;
      }
      const { shared, method } = await deliverShareCard({
        blob,
        title: "SC2 Season Recap",
        text: recapShareText(recap, recapWindow),
        filename: "sc2-season-recap.png",
      });
      // Nothing delivered means the player dismissed the share sheet.
      if (!shared || !method) return;
      trackCardShared({ card: "season_recap", method });
      toast.success(shareOutcome("Recap", method));
    } catch {
      toast.error("Share failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="primary"
      onClick={onShare}
      disabled={busy}
      iconLeft={<Share2 className="h-4 w-4" aria-hidden />}
    >
      {busy ? "Preparing…" : "Share recap"}
    </Button>
  );
}

/**
 * Draw the recap onto the standard 1200×630 share canvas, reusing the
 * arcade card's background/footer helpers. Exported for the unit test.
 */
export async function renderSeasonRecapPng(
  recap: SeasonRecapResult,
  recapWindow: RecapWindow,
): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  drawCardBackground(ctx, "#7DC8FF");

  ctx.textBaseline = "top";
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 46px ${FONT_STACK}`;
  ctx.fillText("Season Recap", CARD_PAD, 54);
  ctx.fillStyle = "#8a96a8";
  ctx.font = `500 26px ${FONT_STACK}`;
  ctx.fillText(recapWindow.label, CARD_PAD, 112);

  // Headline stat block.
  const wr =
    recap.totals.winrate !== null
      ? `${Math.round(recap.totals.winrate * 100)}%`
      : "—";
  const lines: Array<[string, string]> = [
    ["Games", String(recap.totals.games)],
    ["Record", `${recap.totals.wins}-${recap.totals.losses}`],
    ["Win rate", wr],
    ["MMR", cardMmrSummary(recap.mmrJourneys)],
  ];
  let y = 190;
  for (const [label, value] of lines) {
    ctx.fillStyle = "#8a96a8";
    ctx.font = `500 24px ${FONT_STACK}`;
    ctx.fillText(label, CARD_PAD, y);
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 34px ${FONT_STACK}`;
    ctx.fillText(value, CARD_PAD + 240, y - 4);
    y += 64;
  }

  ctx.fillStyle = "#c7d0dc";
  ctx.font = `400 24px ${FONT_STACK}`;
  let sy = 190;
  for (const s of recapCardStory(recap)) {
    sy = wrapText(ctx, s, CARD_W / 2 + 20, sy, CARD_W / 2 - CARD_PAD - 20, 32, 3) + 14;
  }

  drawCardFooter(ctx, { brand: "SC2 Tools · Season Recap" });

  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
}
