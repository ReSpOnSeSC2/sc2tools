import type { Metadata, Viewport } from "next";
import { HumdingersHost } from "@/components/humdingers/HumdingersHost";

export const metadata: Metadata = {
  title: "Humdingers",
  description: "Humdingers, an original pixel RPG by the creator of SC2 Tools. Your saves follow your SC2 Tools account.",
};

// Like the game itself: no pinch zoom, and room around a phone's notch.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

/** Signed in only (middleware); AppShell draws no site chrome over the game. */
export default function HumdingersPage() {
  return <HumdingersHost />;
}
