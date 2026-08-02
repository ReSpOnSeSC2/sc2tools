"use client";

/**
 * OverlayScenesSection — the full-canvas backdrop scenes.
 *
 * Distinct from the widget list above it: widgets are small
 * transparent panels the streamer positions individually, whereas
 * these fill the whole canvas and sit *behind* everything else. The
 * OBS setup advice is different enough (add at canvas size, pin to the
 * back, don't let it reload on activate) that mixing them into the
 * widget rows would bury it.
 */

import { useState } from "react";
import { Layers, Monitor } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { appendOverlayThemeToUrl, type OverlayTheme } from "@/lib/overlayTheme";
import { UrlRow } from "./OverlayUrlRow";

type SceneMeta = {
  id: string;
  label: string;
  hint: string;
};

const SCENES: ReadonlyArray<SceneMeta> = [
  {
    id: "between-games",
    label: "Between Games backdrop",
    hint: "Sits behind your camera, chat and game inset during downtime. Keeps its middle calm on purpose and tints to your opponent's race while a match is live.",
  },
  {
    id: "starting-soon",
    label: "Starting Soon",
    hint: "Full-canvas card with a headline and countdown. Driven by the Stream Dock's Starting soon button.",
  },
  {
    id: "brb",
    label: "Be Right Back",
    hint: "Same card, BRB wording. Driven by the Stream Dock's BRB button.",
  },
  {
    id: "intermission",
    label: "Intermission",
    hint: "Neutral full-canvas card for breaks between series or segments.",
  },
];

export function OverlayScenesSection({
  token,
  origin,
  theme,
}: {
  token: string;
  origin?: string;
  theme: OverlayTheme;
}) {
  const [preview, setPreview] = useState<string>("between-games");
  const base = origin ?? "";
  const previewUrl = `${base}/overlay/${token}/scene/${preview}?demo=1`;

  return (
    <Section
      title="Full-screen scenes"
      description="Animated StarCraft II backdrops for your Between Games, Starting Soon and BRB scenes. Add one as a full-canvas Browser Source and send it to the back."
    >
      <Card>
        <div className="flex items-start gap-3 px-2 py-2 text-caption text-text-muted">
          <Monitor
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan"
            aria-hidden
          />
          <p>
            The desktop{" "}
            <a
              href="/devices"
              className="text-accent-cyan underline-offset-2 hover:underline"
            >
              agent
            </a>{" "}
            can build the whole Between Games scene for you — big camera,
            chat column, game inset and this backdrop — and switch to it
            automatically when a game ends. Look for{" "}
            <strong className="text-text">OBS scene switching</strong> in
            the agent&apos;s Settings tab.
          </p>
        </div>
      </Card>

      <Card padded={false}>
        <ul className="min-w-0 divide-y divide-border">
          {SCENES.map((scene) => {
            const url = appendOverlayThemeToUrl(
              `${base}/overlay/${token}/scene/${scene.id}`,
              theme,
            );
            return (
              <li
                key={scene.id}
                className="grid min-w-0 grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center sm:gap-3"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Layers
                    className="mt-0.5 h-4 w-4 flex-shrink-0 text-accent-cyan"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => setPreview(scene.id)}
                      className="text-left text-body font-medium text-text underline-offset-2 hover:underline"
                    >
                      {scene.label}
                    </button>
                    <div className="break-words text-caption text-text-dim">
                      {scene.hint}
                    </div>
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <UrlRow url={url} compact />
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card>
        <div className="min-w-0 space-y-2">
          <div className="text-caption font-medium text-text">
            Preview — {SCENES.find((s) => s.id === preview)?.label}
          </div>
          <div className="relative w-full overflow-hidden rounded-lg border border-border bg-black pt-[56.25%]">
            <iframe
              key={previewUrl}
              src={previewUrl}
              title="Scene preview"
              className="absolute inset-0 h-full w-full"
              /* Sample values only — the ?demo=1 flag. A real preview
                 would need this tab to hold an overlay socket open. */
              sandbox="allow-scripts"
            />
          </div>
          <p className="text-caption text-text-muted">
            Preview shows sample values. On stream the accent follows your
            live opponent&apos;s race and the countdown comes from the
            Stream Dock.
          </p>
        </div>
      </Card>

      <Card>
        <div className="min-w-0 space-y-1.5 text-caption text-text-muted">
          <div className="text-caption font-medium text-text">
            Adding it in OBS
          </div>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Add a <strong className="text-text">Browser Source</strong> and
              paste the URL.
            </li>
            <li>
              Set Width and Height to your{" "}
              <strong className="text-text">canvas resolution</strong> (1920 ×
              1080 for most setups) so it fills the scene exactly.
            </li>
            <li>
              Untick{" "}
              <strong className="text-text">
                Shutdown source when not visible
              </strong>{" "}
              and{" "}
              <strong className="text-text">
                Refresh browser when scene becomes active
              </strong>
              . A source that reloads on activate flashes on air every time
              your scene changes.
            </li>
            <li>
              Right-click the source →{" "}
              <strong className="text-text">Order → Send to Back</strong> so
              your camera and chat sit on top of it.
            </li>
          </ol>
          <p className="pt-1">
            Running on a low-spec machine? Add{" "}
            <code className="rounded bg-bg-elevated px-1">?static=1</code> to
            the URL to freeze the animation to a still image.
          </p>
        </div>
      </Card>
    </Section>
  );
}
