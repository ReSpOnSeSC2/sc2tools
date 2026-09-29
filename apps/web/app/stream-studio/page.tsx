import type { Metadata } from "next";
import { StreamStudioPage } from "@/components/landing/StreamStudioPage";
import { getInstantImportMode } from "@/lib/instant/flag";
import { PRODUCT_FACTS } from "@/lib/productFacts";

/**
 * /stream-studio — public landing page for the OBS overlays (see
 * components/landing/StreamStudioPage). Static: every fact on it comes
 * from code, so it rebuilds with each deploy.
 */

const TITLE = "SC2 Overlay for OBS: free StarCraft II Stream Studio | SC2 Tools";
const DESCRIPTION = `Free StarCraft II overlays for OBS and Streamlabs: opponent scouting, MMR, match results, your session record and ${PRODUCT_FACTS.overlayWidgets} copy-and-paste widgets, plus merged Twitch, Kick, YouTube and TikTok chat.`;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/stream-studio" },
  openGraph: {
    type: "website",
    siteName: "SC2 Tools",
    url: "/stream-studio",
    title: TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: "/landing/overlay-live.png",
        width: 2000,
        height: 1124,
        alt: "A StarCraft II stream with the SC2 Tools overlay",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/landing/overlay-live.png"],
  },
};

export default function StreamStudioRoute() {
  return <StreamStudioPage tryEnabled={getInstantImportMode() === "all"} />;
}
