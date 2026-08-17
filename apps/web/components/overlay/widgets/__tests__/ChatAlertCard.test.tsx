import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import {
  ALERT_VISUAL_PRESETS,
  ALERT_VISUAL_PRESET_BY_ID,
  type AlertVisualMotion,
  type AlertVisualPreset,
} from "@/lib/multichat/alerts";
import type { ChatEvent } from "@/lib/multichat/events";
import {
  EMPTY_ALERT_MEDIA_GRANT,
  setAlertMediaGrant,
} from "@/lib/multichat/mediaBase";
import { ChatAlertCard } from "../ChatAlertCard";

const SEMANTIC_EVENT: ChatEvent = {
  platform: "youtube",
  id: "renderer-contract",
  kind: "superchat",
  user: "SemanticSupporter",
  detail: "sent a carefully preserved Super Chat",
  amount: "$123.45",
  atMs: 1_765_000_000_000,
};

const SC2_3D_PRESET_IDS = [
  "zealot-dance-3d",
  "marine-skyfire-3d",
  "archon-merge-3d",
  "archon-backflip-3d",
  "stalker-blink-3d",
  "carrier-interceptors-3d",
  "zergling-zoomies-3d",
  "baneling-bowling-3d",
  "overlord-party-balloon-3d",
  "battlecruiser-warp-in-3d",
  "mule-money-drop-3d",
] as const;

// The SC2 3D media is admin-gated: it resolves only through a presigned grant.
// These tests assert the rendering contract, so they install a grant that maps
// each catalog path to itself -- the existing src/poster assertions then read
// exactly as before. The ungranted path (non-admin) is covered separately.
function grantEveryPresetPath(): void {
  const urls: Record<string, string> = {};
  for (const preset of ALERT_VISUAL_PRESETS) {
    if (preset.animationUrl) urls[preset.animationUrl] = preset.animationUrl;
    if (preset.animationPosterUrl) {
      urls[preset.animationPosterUrl] = preset.animationPosterUrl;
    }
  }
  setAlertMediaGrant({ urls, expiresAt: Date.now() + 300_000 });
}

const MEDIA_PRESET = ALERT_VISUAL_PRESET_BY_ID["zealot-dance-3d"];

let reducedMotionMatches = false;
const reducedMotionListeners = new Set<() => void>();

beforeEach(() => {
  grantEveryPresetPath();
  reducedMotionMatches = false;
  reducedMotionListeners.clear();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    get matches() {
      return reducedMotionMatches;
    },
    media: query,
    onchange: null,
    addListener: (listener: () => void) => reducedMotionListeners.add(listener),
    removeListener: (listener: () => void) => {
      reducedMotionListeners.delete(listener);
    },
    addEventListener: (_type: string, listener: () => void) => {
      reducedMotionListeners.add(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      reducedMotionListeners.delete(listener);
    },
    dispatchEvent: () => true,
  }) as unknown as MediaQueryList));
});

afterEach(() => {
  setAlertMediaGrant(EMPTY_ALERT_MEDIA_GRANT);
  cleanup();
  vi.unstubAllGlobals();
});

function setReducedMotion(matches: boolean) {
  reducedMotionMatches = matches;
  for (const listener of reducedMotionListeners) listener();
}

describe("ChatAlertCard preset renderer", () => {
  it("preserves event semantics and renderer data for every visual preset", () => {
    expect(ALERT_VISUAL_PRESETS).toHaveLength(57);

    for (const preset of ALERT_VISUAL_PRESETS) {
      const view = render(
        <ChatAlertCard
          event={SEMANTIC_EVENT}
          preset={preset}
          motion="full"
        />,
      );
      const card = view.container.querySelector<HTMLElement>(
        ".chat-alert-visual",
      );
      expect(card, `missing root for ${preset.id}`).not.toBeNull();
      if (!card) throw new Error(`missing root for ${preset.id}`);

      expect(card.dataset.alertPreset).toBe(preset.id);
      expect(card.dataset.alertLayout).toBe(preset.layout);
      expect(card.dataset.alertMotion).toBe("full");
      expect(card.dataset.alertRenderedMedia).toBe(
        preset.animationUrl ? "true" : undefined,
      );
      expect(card.classList.contains("ca-has-rendered-media")).toBe(
        Boolean(preset.animationUrl),
      );
      expect(card.classList.contains(`ca-entry-${preset.entry}`)).toBe(true);
      expect(card.classList.contains(`ca-preset-${preset.id}`)).toBe(true);
      expect(card.getAttribute("aria-label")).toBe(
        "Super Chat from SemanticSupporter",
      );

      const content = within(card);
      expect(content.getByText("SemanticSupporter")).toBeTruthy();
      expect(content.getByText("Super Chat")).toBeTruthy();
      expect(
        content.getByText("sent a carefully preserved Super Chat"),
      ).toBeTruthy();
      expect(content.getByText("$123.45")).toBeTruthy();

      view.unmount();
    }
  });

  it("omits optional detail and amount without losing core semantics", () => {
    const event: ChatEvent = {
      ...SEMANTIC_EVENT,
      id: "minimal-event",
      kind: "follow",
      detail: "",
      amount: undefined,
    };
    const { container } = render(
      <ChatAlertCard
        event={event}
        preset={ALERT_VISUAL_PRESET_BY_ID.classic}
        motion="subtle"
      />,
    );

    const card = container.querySelector<HTMLElement>(".chat-alert-visual");
    expect(card).not.toBeNull();
    if (!card) throw new Error("missing classic alert root");
    expect(within(card).getByText("SemanticSupporter")).toBeTruthy();
    expect(within(card).getByText("Follow")).toBeTruthy();
    expect(card.querySelector(".ca-detail")).toBeNull();
    expect(card.querySelector(".ca-amount")).toBeNull();
  });

  it("uses the licensed local asset for an asset-backed StarCraft preset", () => {
    const preset = ALERT_VISUAL_PRESET_BY_ID["mule-money-drop"];
    const { container } = render(
      <ChatAlertCard
        event={SEMANTIC_EVENT}
        preset={preset}
        motion="maximum"
      />,
    );

    const icon = container.querySelector<HTMLImageElement>("img.ca-sc2-icon");
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute("src")).toBe("/icons/sc2/units/mule.png");
    expect(icon?.getAttribute("alt")).toBe("");
    expect(icon?.closest(".ca-art")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("expands rendered media while preserving the static preset footprint", () => {
    const mediaView = render(
      <ChatAlertCard
        event={SEMANTIC_EVENT}
        preset={MEDIA_PRESET}
        motion="full"
      />,
    );
    const staticView = render(
      <ChatAlertCard
        event={SEMANTIC_EVENT}
        preset={ALERT_VISUAL_PRESET_BY_ID.classic}
        motion="full"
      />,
    );
    const mediaCard = mediaView.container.querySelector<HTMLElement>(
      ".chat-alert-visual",
    );
    const staticCard = staticView.container.querySelector<HTMLElement>(
      ".chat-alert-visual",
    );
    expect(mediaCard?.classList.contains("ca-has-rendered-media")).toBe(true);
    expect(mediaCard?.dataset.alertRenderedMedia).toBe("true");
    expect(staticCard?.classList.contains("ca-has-rendered-media")).toBe(false);
    expect(staticCard?.hasAttribute("data-alert-rendered-media")).toBe(false);

    expect(getComputedStyle(mediaCard as HTMLElement).minHeight).toBe("160px");
    expect(
      getComputedStyle(
        mediaView.container.querySelector(".ca-main") as HTMLElement,
      ).gridTemplateColumns,
    ).toContain("144px");
    expect(
      getComputedStyle(
        mediaView.container.querySelector(".ca-art") as HTMLElement,
      ).width,
    ).toBe("138px");
    expect(getComputedStyle(staticCard as HTMLElement).minHeight).toBe("112px");
    expect(
      getComputedStyle(
        staticView.container.querySelector(".ca-art") as HTMLElement,
      ).width,
    ).toBe("78px");
  });

  it("renders static art for a 3D preset when no grant is held", () => {
    // The non-admin path: the media is admin-gated and lives only in private
    // R2, so without a presigned grant nothing should request it.
    setAlertMediaGrant(EMPTY_ALERT_MEDIA_GRANT);
    const { container } = render(
      <ChatAlertCard event={SEMANTIC_EVENT} preset={MEDIA_PRESET} motion="full" />,
    );
    expect(container.querySelector("video.ca-animation")).toBeNull();
    expect(container.querySelector("img.ca-animation-poster")).toBeNull();
    expect(container.querySelector(".ca-art")).not.toBeNull();
  });

  it("resolves locally hosted licensed media without any grant", () => {
    // Only /alerts/sc2-3d/ is gated. Other presets point at art that ships in
    // the build and must keep working for every viewer.
    setAlertMediaGrant(EMPTY_ALERT_MEDIA_GRANT);
    const preset: AlertVisualPreset = {
      ...ALERT_VISUAL_PRESET_BY_ID.classic,
      animationPosterUrl: "/alerts/rendered/static-only.webp",
    };
    const { container } = render(
      <ChatAlertCard event={SEMANTIC_EVENT} preset={preset} motion="full" />,
    );
    expect(
      container.querySelector("img.ca-animation-poster")?.getAttribute("src"),
    ).toBe("/alerts/rendered/static-only.webp");
  });

  it("renders every 3D SC2 preset with exact media and poster fallback", () => {
    const rendered3d = ALERT_VISUAL_PRESETS.filter(
      (preset) => preset.animationUrl,
    );
    expect(rendered3d.map((preset) => preset.id)).toEqual(SC2_3D_PRESET_IDS);

    for (const preset of rendered3d) {
      const view = render(
        <ChatAlertCard event={SEMANTIC_EVENT} preset={preset} motion="full" />,
      );
      const video = view.container.querySelector<HTMLVideoElement>(
        "video.ca-animation",
      );
      expect(video, `missing animation for ${preset.id}`).not.toBeNull();
      if (!video) throw new Error(`missing animation for ${preset.id}`);
      expect(video.getAttribute("src")).toBe(
        `/alerts/sc2-3d/${preset.id}.webm`,
      );
      expect(video.getAttribute("poster")).toBe(
        `/alerts/sc2-3d/${preset.id}.webp`,
      );

      fireEvent.error(video);
      expect(view.container.querySelector("video.ca-animation")).toBeNull();
      expect(
        view.container.querySelector("img.ca-animation-poster")
          ?.getAttribute("src"),
      ).toBe(`/alerts/sc2-3d/${preset.id}.webp`);
      view.unmount();
    }
  });

  it("renders transparent media with the complete passive video contract", () => {
    const { container } = render(
      <ChatAlertCard
        event={SEMANTIC_EVENT}
        preset={MEDIA_PRESET}
        motion="full"
      />,
    );

    const video = container.querySelector<HTMLVideoElement>("video.ca-animation");
    expect(video).not.toBeNull();
    if (!video) throw new Error("missing rendered alert animation");
    expect(video.getAttribute("src")).toBe(MEDIA_PRESET.animationUrl);
    expect(video.getAttribute("poster")).toBe(MEDIA_PRESET.animationPosterUrl);
    expect(video.dataset.alertMedia).toBe("animation");
    expect(video.autoplay).toBe(true);
    expect(video.loop).toBe(true);
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
    expect(video.preload).toBe("auto");
    expect(container.querySelector(".ca-animation-poster")).toBeNull();
  });

  it("falls back from broken poster-only media to CSS artwork", async () => {
    const preset: AlertVisualPreset = {
      ...ALERT_VISUAL_PRESET_BY_ID.classic,
      animationPosterUrl: "/alerts/rendered/static-only.webp",
    };
    const { container } = render(
      <ChatAlertCard event={SEMANTIC_EVENT} preset={preset} motion="full" />,
    );

    expect(container.querySelector("video.ca-animation")).toBeNull();
    const poster = container.querySelector<HTMLImageElement>(
      "img.ca-animation-poster",
    );
    expect(poster?.getAttribute("src")).toBe(
      "/alerts/rendered/static-only.webp",
    );
    if (!poster) throw new Error("missing poster-only alert artwork");
    fireEvent.error(poster);

    await waitFor(() => {
      expect(container.querySelector("img.ca-animation-poster")).toBeNull();
      expect(container.querySelector(".ca-emoji")?.textContent).toBe("✦");
    });
  });

  it("falls through failed video and poster to its licensed asset", async () => {
    const { container } = render(
      <ChatAlertCard
        event={SEMANTIC_EVENT}
        preset={MEDIA_PRESET}
        motion="full"
      />,
    );

    const video = container.querySelector<HTMLVideoElement>("video.ca-animation");
    expect(video).not.toBeNull();
    if (!video) throw new Error("missing rendered alert animation");
    fireEvent.error(video);

    const poster = await waitFor(() => {
      const candidate = container.querySelector<HTMLImageElement>(
        "img.ca-animation-poster",
      );
      expect(candidate).not.toBeNull();
      return candidate as HTMLImageElement;
    });
    expect(container.querySelector("video.ca-animation")).toBeNull();
    expect(poster.getAttribute("src")).toBe(MEDIA_PRESET.animationPosterUrl);
    expect(poster?.dataset.alertMedia).toBe("poster");
    expect(poster?.getAttribute("alt")).toBe("");
    fireEvent.error(poster);

    await waitFor(() => {
      expect(container.querySelector("img.ca-animation-poster")).toBeNull();
      expect(
        container.querySelector<HTMLImageElement>("img.ca-sc2-icon")
          ?.getAttribute("src"),
      ).toBe("/icons/sc2/units/zealot.png");
    });
  });

  it("falls back to existing preset art when animation has no poster", () => {
    const preset: AlertVisualPreset = {
      ...ALERT_VISUAL_PRESET_BY_ID["mule-money-drop"],
      animationUrl: "/alerts/rendered/mule.webm",
    };
    const { container } = render(
      <ChatAlertCard event={SEMANTIC_EVENT} preset={preset} motion="full" />,
    );

    const video = container.querySelector<HTMLVideoElement>("video.ca-animation");
    expect(video).not.toBeNull();
    if (!video) throw new Error("missing rendered alert animation");
    fireEvent.error(video);

    expect(container.querySelector("video.ca-animation")).toBeNull();
    expect(
      container.querySelector<HTMLImageElement>("img.ca-sc2-icon")
        ?.getAttribute("src"),
    ).toBe("/icons/sc2/units/mule.png");
  });

  it("reacts to a live reduced-motion preference change", () => {
    const { container } = render(
      <ChatAlertCard
        event={SEMANTIC_EVENT}
        preset={MEDIA_PRESET}
        motion="maximum"
      />,
    );
    expect(container.querySelector("video.ca-animation")).not.toBeNull();

    act(() => setReducedMotion(true));
    expect(container.querySelector("video.ca-animation")).toBeNull();
    expect(
      container.querySelector("img.ca-animation-poster")?.getAttribute("src"),
    ).toBe(MEDIA_PRESET.animationPosterUrl);

    act(() => setReducedMotion(false));
    expect(container.querySelector("video.ca-animation")).not.toBeNull();
    expect(container.querySelector("img.ca-animation-poster")).toBeNull();
  });

  it("falls through a broken reduced-motion poster to static art", async () => {
    reducedMotionMatches = true;
    const { container } = render(
      <ChatAlertCard
        event={SEMANTIC_EVENT}
        preset={MEDIA_PRESET}
        motion="subtle"
      />,
    );

    expect(container.querySelector("video.ca-animation")).toBeNull();
    const poster = container.querySelector<HTMLImageElement>(
      "img.ca-animation-poster",
    );
    expect(poster).not.toBeNull();
    if (!poster) throw new Error("missing reduced-motion poster");
    fireEvent.error(poster);

    await waitFor(() => {
      expect(container.querySelector("img.ca-animation-poster")).toBeNull();
      expect(
        container.querySelector<HTMLImageElement>("img.ca-sc2-icon")
          ?.getAttribute("src"),
      ).toBe("/icons/sc2/units/zealot.png");
    });
  });

  it.each(["subtle", "full", "maximum"] as const)(
    "uses the media poster for reduced motion at the %s level",
    (motion: AlertVisualMotion) => {
      reducedMotionMatches = true;
      const { container } = render(
        <ChatAlertCard
          event={SEMANTIC_EVENT}
          preset={MEDIA_PRESET}
          motion={motion}
        />,
      );

      expect(container.querySelector("video.ca-animation")).toBeNull();
      expect(
        container.querySelector("img.ca-animation-poster")?.getAttribute("src"),
      ).toBe(MEDIA_PRESET.animationPosterUrl);
      expect(
        container.querySelector(".chat-alert-visual")?.getAttribute(
          "data-alert-motion",
        ),
      ).toBe(motion);
    },
  );

  it.each(["subtle", "full", "maximum"] as const)(
    "exposes the %s motion contract to CSS and visual tests",
    (motion: AlertVisualMotion) => {
      const { container } = render(
        <ChatAlertCard
          event={SEMANTIC_EVENT}
          preset={ALERT_VISUAL_PRESET_BY_ID["frog-party"]}
          motion={motion}
        />,
      );
      const card = container.querySelector<HTMLElement>(".chat-alert-visual");
      expect(card?.dataset.alertMotion).toBe(motion);
      expect(card?.classList.contains(`ca-motion-${motion}`)).toBe(true);
    },
  );
});
