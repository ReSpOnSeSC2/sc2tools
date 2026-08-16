"use client";

/**
 * OverlayScenesSection — the full-canvas backdrop scenes.
 *
 * Distinct from the widget list above it: widgets are small
 * transparent panels the streamer positions individually, whereas
 * these fill the whole canvas. Named backdrops sit behind the layout;
 * the transparent-until-selected manual cover sits above it. The OBS
 * setup advice is different enough that mixing them into the widget
 * rows would bury it.
 */

import { useState } from "react";
import { Clapperboard, Layers, Monitor } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { appendOverlayThemeToUrl, type OverlayTheme } from "@/lib/overlayTheme";
import {
  STREAM_BACKGROUNDS,
  type StreamBackgroundId,
} from "@/lib/streamBackgrounds";
import { UrlRow } from "./OverlayUrlRow";

type LegacySceneId =
  | "between-games"
  | "starting-soon"
  | "brb"
  | "intermission"
  | "manual";

type SceneMeta = {
  id: LegacySceneId | StreamBackgroundId;
  label: string;
  hint: string;
  kind: "animated-scene" | "virtual-set";
};

const CORE_SCENES: ReadonlyArray<SceneMeta> = [
  {
    id: "between-games",
    label: "Between Games backdrop",
    hint: "Sits behind your camera, chat and game inset during downtime. Keeps its middle calm on purpose and tints to your opponent's race while a match is live.",
    kind: "animated-scene",
  },
  {
    id: "starting-soon",
    label: "Starting Soon",
    hint: "Full-canvas card with a headline and countdown. Driven by the Stream Dock's Starting soon button.",
    kind: "animated-scene",
  },
  {
    id: "brb",
    label: "Be Right Back",
    hint: "Same card, BRB wording. Driven by the Stream Dock's BRB button.",
    kind: "animated-scene",
  },
  {
    id: "intermission",
    label: "Intermission",
    hint: "Neutral full-canvas card for breaks between series or segments.",
    kind: "animated-scene",
  },
  {
    id: "manual",
    label: "Stream Dock manual override",
    hint: "Transparent while Live; becomes Starting Soon or BRB when you press it in the Stream Dock. Put this at the very top of every scene your automatic switcher can select.",
    kind: "animated-scene",
  },
];

const SCENES: ReadonlyArray<SceneMeta> = [
  ...CORE_SCENES,
  ...STREAM_BACKGROUNDS.map((background) => ({
    id: background.id,
    label: background.label,
    hint: background.description,
    kind: "virtual-set" as const,
  })),
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
  const selectedScene = SCENES.find((scene) => scene.id === preview);
  const previewUrl = `${base}/overlay/${token}/scene/${preview}${
    selectedScene?.kind === "virtual-set" ? "" : "?demo=1"
  }`;

  return (
    <Section
      title="Full-screen scenes"
      description="Animated broadcast scenes, a transparent Stream Dock cover, and seven static virtual sets you can place behind your camera."
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
            automatically when a game ends. It also puts the Stream Dock
            manual cover above both generated layouts, so Starting Soon and
            BRB stay on screen while the switcher changes scenes underneath.
            Look for{" "}
            <strong className="text-text">OBS scene switching</strong> in
            the agent&apos;s Settings tab.
          </p>
        </div>
      </Card>

      <Card padded={false}>
        <ul className="min-w-0 divide-y divide-border">
          {SCENES.map((scene) => {
            const sceneUrl = `${base}/overlay/${token}/scene/${scene.id}`;
            // A virtual set contains no themed UI, so its permanent OBS URL
            // stays unchanged when the streamer restyles overlay widgets.
            const url =
              scene.kind === "virtual-set"
                ? sceneUrl
                : appendOverlayThemeToUrl(sceneUrl, theme);
            const SceneIcon =
              scene.kind === "virtual-set" ? Clapperboard : Layers;
            return (
              <li
                key={scene.id}
                className="grid min-w-0 grid-cols-1 gap-2 px-3 py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:items-center sm:gap-3"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <SceneIcon
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
                 would need this tab to hold an overlay socket open.

                 `allow-same-origin` is required, not optional. This
                 frames our OWN page; without it the document gets an
                 opaque origin, where reading localStorage, cookies or
                 navigator.serviceWorker throws SecurityError. Any one
                 of those throwing inside the root layout escalates to
                 global-error and the preview renders as "SC2 Tools hit
                 a critical error" instead of a backdrop.

                 The sandbox still earns its place: with only these two
                 flags the frame cannot navigate this tab away, open
                 popups, submit forms, trigger downloads or pop modal
                 dialogs over Settings. */
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
          <p className="text-caption text-text-muted">
            {selectedScene?.kind === "virtual-set"
              ? "This is the clean virtual set: no baked-in text or widgets. Keep it behind your camera and other sources."
              : "Preview shows sample values. On stream the accent follows your live opponent's race and the countdown comes from the Stream Dock."}
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
              For a named backdrop or virtual set, choose{" "}
              <strong className="text-text">Order → Send to Back</strong>.
              For the <strong className="text-text">manual override</strong>,
              add the same source to every automatically selected scene and
              choose <strong className="text-text">Order → Bring to Front</strong>.
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
