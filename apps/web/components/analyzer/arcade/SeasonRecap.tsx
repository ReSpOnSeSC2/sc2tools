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

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Share2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyStatePanel } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/ui/Card";
import { useToast } from "@/components/ui/Toast";
import { useArcadeData } from "./hooks/useArcadeData";
import {
  computeSeasonRecap,
  MIN_RECAP_GAMES,
  resolveRecapWindow,
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
  wrapText,
} from "./ShareCard";
import { buildRecapSlides, type RecapSlide } from "./seasonRecapSlides";

export function SeasonRecap() {
  const { data, loading } = useArcadeData();
  const games = useMemo(() => data?.games ?? [], [data?.games]);

  const window = useMemo<RecapWindow>(() => resolveRecapWindow(games), [games]);
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
              {recap.mmrJourney
                ? `, ${recap.mmrJourney.delta >= 0 ? "+" : ""}${recap.mmrJourney.delta} MMR`
                : ""}
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
  const slides = useMemo<RecapSlide[]>(
    () => buildRecapSlides(recap, recapWindow),
    [recap, recapWindow],
  );
  const [idx, setIdx] = useState(0);
  const last = slides.length - 1;
  const clampedIdx = Math.min(idx, last);

  const go = useCallback(
    (delta: number) => setIdx((i) => Math.max(0, Math.min(last, i + delta))),
    [last],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go]);

  const slide = slides[clampedIdx];

  return (
    <Modal
      open
      onClose={onClose}
      title="Season Recap"
      description={recapWindow.label}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <div
          className="relative flex min-h-[320px] flex-col items-center justify-center rounded-xl border border-line bg-bg-elevated px-5 py-8 text-center motion-safe:transition-opacity"
          role="group"
          aria-roledescription="slide"
          aria-label={`${clampedIdx + 1} of ${slides.length}: ${slide.headline}`}
        >
          <RecapSlideView slide={slide} />
        </div>

        <div className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => go(-1)}
            disabled={clampedIdx === 0}
            iconLeft={<ChevronLeft className="h-4 w-4" aria-hidden />}
          >
            Back
          </Button>

          <div
            className="flex items-center gap-1.5"
            role="tablist"
            aria-label="Recap slides"
          >
            {slides.map((s, i) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={i === clampedIdx}
                aria-label={`Slide ${i + 1}: ${s.headline}`}
                onClick={() => setIdx(i)}
                className={`h-2.5 w-2.5 rounded-full transition-colors ${
                  i === clampedIdx ? "bg-accent-cyan" : "bg-line hover:bg-border-strong"
                }`}
              />
            ))}
          </div>

          {clampedIdx < last ? (
            <Button
              variant="primary"
              onClick={() => go(1)}
              iconRight={<ChevronRight className="h-4 w-4" aria-hidden />}
            >
              Next
            </Button>
          ) : (
            <ShareRecapButton recap={recap} window={recapWindow} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function RecapSlideView({ slide }: { slide: RecapSlide }) {
  return (
    <div className="space-y-2">
      {slide.eyebrow ? (
        <p className="text-caption font-semibold uppercase tracking-wider text-accent-cyan">
          {slide.eyebrow}
        </p>
      ) : null}
      {slide.big ? (
        <p className="font-display text-display-lg font-bold tabular-nums text-text">
          {slide.big}
        </p>
      ) : null}
      <p className="text-h3 font-semibold text-text">{slide.headline}</p>
      {slide.sub ? (
        <p className="mx-auto max-w-md text-body text-text-muted">{slide.sub}</p>
      ) : null}
    </div>
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
      const wr =
        recap.totals.winrate !== null
          ? `${Math.round(recap.totals.winrate * 100)}% WR`
          : "";
      const text = [
        `My SC2 ${recapWindow.label} recap: ${recap.totals.games} games${
          wr ? `, ${wr}` : ""
        }${
          recap.mmrJourney
            ? `, ${recap.mmrJourney.delta >= 0 ? "+" : ""}${recap.mmrJourney.delta} MMR`
            : ""
        }.`,
        "",
        SHARE_LINK_URL,
      ].join("\n");
      const { shared } = await deliverShareCard({
        blob,
        title: "SC2 Season Recap",
        text,
        filename: "sc2-season-recap.png",
      });
      toast.success(shared ? "Recap shared" : "Recap saved");
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
    [
      "MMR",
      recap.mmrJourney
        ? `${recap.mmrJourney.delta >= 0 ? "+" : ""}${recap.mmrJourney.delta} (peak ${recap.mmrJourney.peak})`
        : "—",
    ],
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

  // Story line: nemesis / signature opener.
  const story: string[] = [];
  if (recap.topOpener) {
    story.push(
      `Signature opener: ${recap.topOpener.name} (${recap.topOpener.games} games).`,
    );
  }
  if (recap.nemesis) {
    story.push(
      `Nemesis: ${recap.nemesis.name} (${recap.nemesis.record} against you).`,
    );
  }
  if (recap.biggestUpset) {
    story.push(
      `Biggest upset: beat +${recap.biggestUpset.mmrGap} MMR${
        recap.biggestUpset.opponentName ? ` (${recap.biggestUpset.opponentName})` : ""
      }.`,
    );
  }
  ctx.fillStyle = "#c7d0dc";
  ctx.font = `400 24px ${FONT_STACK}`;
  let sy = 190;
  for (const s of story.slice(0, 4)) {
    sy = wrapText(ctx, s, CARD_W / 2 + 20, sy, CARD_W / 2 - CARD_PAD - 20, 32, 3) + 14;
  }

  drawCardFooter(ctx, { brand: "SC2 Tools · Season Recap" });

  return await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
}
