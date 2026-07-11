"use client";

import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { AlertTriangle, Paintbrush } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Button } from "@/components/ui/Button";
import type { LiveGamePayload } from "@/components/overlay/types";
import { MatchResultWidget } from "@/components/overlay/widgets/MatchResultWidget";
import { MmrDeltaWidget } from "@/components/overlay/widgets/MmrDeltaWidget";
import {
  SessionWidget,
  type SessionSummary,
} from "@/components/overlay/widgets/SessionWidget";
import {
  DEFAULT_OVERLAY_ACCENT,
  DEFAULT_OVERLAY_OPACITY,
  OVERLAY_THEME_PRESETS,
  OVERLAY_THEME_SCALES,
  accentContrastOnPanel,
  expandHex,
  isValidThemeHex,
  normalizeOverlayTheme,
  themeToCssVars,
  type OverlayTheme,
  type OverlayThemeFont,
  type OverlayThemeRadius,
  type OverlayThemeScale,
} from "@/lib/overlayTheme";

/**
 * Settings · Overlay tab · Theme section.
 *
 * Restyles the OBS widgets without any server round-trip: the chosen
 * theme is encoded into the copyable overlay URLs (``?theme=…``) by the
 * parent SettingsOverlay, so an OBS Browser Source needs no re-auth —
 * just a re-copied URL. The live preview renders real widget components
 * with static sample data (no sockets) over a checkerboard so streamers
 * can judge compositing before touching OBS.
 */

/** Canonical identity for "is this exactly that preset?" checks —
 * normalize builds keys in a fixed order, so stringify is stable. */
function themeKey(theme: OverlayTheme): string {
  return JSON.stringify(normalizeOverlayTheme(theme));
}

export function OverlayThemeSection({
  theme,
  onChange,
}: {
  theme: OverlayTheme;
  onChange: (next: OverlayTheme) => void;
}) {
  const radioName = useId();
  const activeKey = themeKey(theme);

  // Local draft for the hex text field so partially-typed values don't
  // thrash the theme; only strict #rgb/#rrggbb commits.
  const [hexDraft, setHexDraft] = useState(theme.accent ?? "");
  useEffect(() => {
    setHexDraft(theme.accent ?? "");
  }, [theme.accent]);
  const hexInvalid = hexDraft !== "" && !isValidThemeHex(hexDraft);

  function patch(partial: Partial<OverlayTheme>) {
    // normalizeOverlayTheme is the single validation gate — it drops
    // invalid values and default-valued keys, so the parent always
    // holds the canonical minimal theme.
    onChange(normalizeOverlayTheme({ ...theme, ...partial }));
  }

  function commitHex(value: string) {
    setHexDraft(value);
    if (value === "") {
      patch({ accent: undefined });
    } else if (isValidThemeHex(value)) {
      patch({ accent: value });
    }
  }

  return (
    <Section
      title="Overlay theme"
      description="Restyle every widget — accent colour, panel opacity, corners, size and type. The theme travels inside the URLs above, so after changing it re-copy the URLs into your OBS Browser Sources (no re-auth needed)."
    >
      <Card>
        <div className="space-y-5 px-2 py-2">
          <fieldset>
            <legend className="flex items-center gap-2 text-caption font-medium text-text">
              <Paintbrush className="h-4 w-4 text-accent-cyan" aria-hidden />
              Preset
            </legend>
            <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
              {OVERLAY_THEME_PRESETS.map((preset) => {
                const checked = themeKey(preset.theme) === activeKey;
                return (
                  <label key={preset.id} className="cursor-pointer">
                    <input
                      type="radio"
                      name={radioName}
                      className="peer sr-only"
                      checked={checked}
                      onChange={() => onChange({ ...preset.theme })}
                      aria-label={`${preset.name} preset`}
                    />
                    <span
                      className={[
                        "flex min-h-[44px] flex-col gap-1 rounded-lg border-2 px-3 py-2 transition-colors",
                        "peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-bg",
                        checked
                          ? "border-accent bg-accent/10"
                          : "border-line bg-bg-surface hover:border-border-strong",
                      ].join(" ")}
                    >
                      <span className="flex items-center gap-2 text-body font-medium text-text">
                        <span
                          aria-hidden
                          className="inline-block h-3 w-3 flex-shrink-0 rounded-full border border-border"
                          style={{
                            background:
                              preset.theme.accent ?? DEFAULT_OVERLAY_ACCENT,
                          }}
                        />
                        {preset.name}
                      </span>
                      <span className="text-caption text-text-dim">
                        {preset.description}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-caption font-medium text-text">
                Accent
              </span>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={expandHex(theme.accent ?? DEFAULT_OVERLAY_ACCENT)}
                  onChange={(e) => commitHex(e.target.value)}
                  aria-label="Accent colour picker"
                  className="h-11 w-12 flex-shrink-0 cursor-pointer rounded-md border-2 border-line bg-bg-surface p-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                />
                <Input
                  value={hexDraft}
                  onChange={(e) => commitHex(e.target.value)}
                  invalid={hexInvalid}
                  aria-label="Accent hex value"
                  placeholder={DEFAULT_OVERLAY_ACCENT}
                  maxLength={7}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono lowercase"
                />
              </div>
              {hexInvalid ? (
                <p role="alert" className="text-caption text-danger">
                  Use #rgb or #rrggbb hex.
                </p>
              ) : theme.accent ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => patch({ accent: undefined })}
                >
                  Reset to per-widget accents
                </Button>
              ) : (
                <p className="text-caption text-text-dim">
                  Default: each widget picks its own accent.
                </p>
              )}
            </div>

            <Field
              label="Widget size"
              hint="Scales the whole panel, text included."
            >
              <Select
                value={String(theme.scale ?? 1)}
                onChange={(e) =>
                  patch({
                    scale: Number(e.target.value) as OverlayThemeScale,
                  })
                }
              >
                {OVERLAY_THEME_SCALES.map((s) => (
                  <option key={s} value={String(s)}>
                    {Math.round(s * 100)}%{s === 1 ? " (default)" : ""}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Panel opacity"
              hint={`${Math.round(
                (theme.opacity ?? DEFAULT_OVERLAY_OPACITY) * 100,
              )}% opaque`}
            >
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.05}
                value={theme.opacity ?? DEFAULT_OVERLAY_OPACITY}
                onChange={(e) =>
                  patch({ opacity: Number(e.target.value) })
                }
                className="h-11 w-full cursor-pointer accent-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Corners">
                <Select
                  value={theme.radius ?? "rounded"}
                  onChange={(e) =>
                    patch({
                      radius: e.target.value as OverlayThemeRadius,
                    })
                  }
                >
                  <option value="sharp">Sharp</option>
                  <option value="rounded">Rounded</option>
                  <option value="pill">Pill</option>
                </Select>
              </Field>
              <Field label="Type">
                <Select
                  value={theme.font ?? "default"}
                  onChange={(e) =>
                    patch({ font: e.target.value as OverlayThemeFont })
                  }
                >
                  <option value="default">Default</option>
                  <option value="condensed">Condensed</option>
                  <option value="mono">Mono</option>
                </Select>
              </Field>
            </div>
          </div>

          <OverlayThemePreview theme={theme} />
        </div>
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Live preview
// ---------------------------------------------------------------------------

/** Static sample payload — the preview must NEVER open a socket. */
const SAMPLE_LIVE: LiveGamePayload = {
  isTest: true,
  result: "win",
  myRace: "Protoss",
  oppRace: "Zerg",
  matchup: "PvZ",
  map: "Alcyone LE",
  durationSec: 754,
  mmrDelta: 18,
  myMmr: 4211,
};

/** No sessionStartedAt on purpose — keeps the elapsed-time interval
 * timer out of the preview (and out of component tests). */
const SAMPLE_SESSION: SessionSummary = {
  wins: 5,
  losses: 2,
  games: 7,
  mmrCurrent: 4211,
  region: "NA",
  streak: { kind: "win", count: 3 },
  isTest: true,
};

/**
 * Neutralise WidgetShell's absolute slot positioning inside the preview
 * so the sample widgets flow in a row — the same trick the per-widget
 * OverlayWidgetClient uses for its solo frame. Static CSS only.
 */
const PREVIEW_CSS = `
.ov-theme-preview .widget-shell {
  position: relative !important;
  top: auto !important;
  left: auto !important;
  right: auto !important;
  bottom: auto !important;
  transform: none !important;
  flex-shrink: 0;
}
`;

/** OBS-style transparency checkerboard. Deliberately theme-independent —
 * it stands in for "transparent over gameplay", not for site chrome. */
const CHECKERBOARD: CSSProperties = {
  backgroundColor: "#3d424d",
  backgroundImage:
    "repeating-conic-gradient(#4a505c 0% 25%, #3d424d 0% 50%)",
  backgroundSize: "18px 18px",
};

export function OverlayThemePreview({ theme }: { theme: OverlayTheme }) {
  const vars = useMemo(() => themeToCssVars(theme), [theme]);
  const contrast = theme.accent ? accentContrastOnPanel(theme.accent) : null;
  const lowContrast = contrast !== null && contrast < 3;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-caption font-medium text-text">Live preview</p>
        {lowContrast ? (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 rounded-md bg-warning/15 px-2 py-1 text-caption font-medium text-warning"
          >
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
            Low contrast — accent vs panel is {contrast.toFixed(1)}:1 (aim for
            3:1+)
          </span>
        ) : null}
      </div>
      <div
        data-testid="overlay-theme-preview"
        className="ov-theme-preview relative overflow-x-auto rounded-lg border border-border p-4"
        style={{ ...CHECKERBOARD, ...vars } as CSSProperties}
      >
        <style>{PREVIEW_CSS}</style>
        <div className="flex flex-wrap items-start gap-4">
          <MatchResultWidget live={SAMPLE_LIVE} />
          <MmrDeltaWidget live={SAMPLE_LIVE} />
          <SessionWidget live={null} session={SAMPLE_SESSION} />
        </div>
      </div>
      <p className="text-caption text-text-dim">
        Checkerboard = transparent in OBS. Sample data only — nothing is sent
        to your live overlay.
      </p>
    </div>
  );
}
