/**
 * TEST FIXTURES ONLY — public Video objects built from the real channel
 * snapshot (apps/api/src/config/guideVideosSnapshot.json source data):
 * titles, dates, excerpts and checklists are the author's own words,
 * verbatim.
 */
import type { GuideChannel, GuideVideo } from "@/lib/guides/types";

function video(
  youtubeId: string,
  title: string,
  publishedAt: string,
  excerpt: string | null,
  checklist: string[] | null,
): GuideVideo {
  return {
    youtubeId,
    title,
    publishedAt,
    url: `https://www.youtube.com/watch?v=${youtubeId}`,
    thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
    excerpt,
    checklist,
  };
}

export const FIXTURE_CHANNEL: GuideChannel = {
  url: "https://www.youtube.com/@ReSpOnSeSC2",
  name: "ReSpOnSe",
};

export const VIDEO_PVZ_STARGATE_GLAIVES = video(
  "YcTMc_Ee11w",
  "PvZ Stargate into Glaive Adept Timing",
  "2026-08-29T00:00:00.000Z",
  "This PvZ build hides an 18-Glaive-Adept timing behind what looks like a normal Stargate opener—and punishes Zerg players who drone too hard.",
  [
    "14 Gateway / 17 Nexus on this four-player map",
    "Two Adepts for early scouting and pressure",
    "Stargate at 150 gas",
    "Void Ray first to disguise the follow-up",
    "Third Nexus → two more Gateways + Twilight Council",
    "Clear nearby Overlords before revealing Glaives",
    "Produce Adepts from four Gateways",
    "Move before Glaives completes",
    "Add the final round: 14 → 18 Adepts",
    "Choose Fleet Beacon, Blink + Forge, or Robo based on the scout",
  ],
);

export const VIDEO_PVZ_CRACKING_8_POOLS = video(
  "A4x6gR7J-AY",
  "PvZ Cracking 8 Pools",
  "2026-08-24T00:00:00.000Z",
  "The 8 Pool is the fastest Zergling rush in StarCraft II—but this 13-Gateway PvZ response turns it into a 10-worker lead. This Protoss vs. Zerg guide shows the complete defense: scout it, wall it, hold it, then punish it with four Adepts.",
  [
    "13 Gateway, then scout immediately with the Gateway Probe",
    "No natural? Enter the main and confirm the early Spawning Pool",
    "Add a second Gateway, Cybernetics Core, and Assimilator ASAP",
    "Chrono Boost the first Zealot and stop at 19 Probes",
    "Pre-build Pylons—without a Nexus, the supply block arrives fast",
    "At the wall: poke, retreat, and never give the Zerglings a surround",
    "Let the first Adepts finish the hold, then make four total",
    "Start the Nexus once 16 Probes are mining minerals",
    "Counterpressure with the Adepts; Recall if mass Lings are waiting",
    "If Zerg drones, punish the mineral line",
  ],
);

export const VIDEO_PVZ_CARRIER_RUSH = video(
  "RYjRs_no8t4",
  "PvZ Carrier Rush: Can Zerg Stop It?",
  "2026-09-19T16:18:32.000Z",
  "I'm rushing Carriers, but I can't give Zerg a free game.",
  null,
);

export const VIDEO_PVT_STARGATE_CHARGE = video(
  "H8PKfSR9u_s",
  "PvT Stargate into Charge!",
  "2026-09-09T00:00:00.000Z",
  "Terran is bringing Marines and tanks. Your Charge is nearly done. Do you wait—or fight before the bunkers finish?",
  null,
);
