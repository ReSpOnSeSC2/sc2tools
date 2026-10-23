/**
 * Sections that used to ignore a failed request (or print its raw
 * message) now show RequestError with Retry. One row per migrated
 * section: the request fails with a 500, the section must offer Retry
 * and must not fall back to its empty or "0 games" copy.
 */
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const harness = vi.hoisted(() => ({ useApi: vi.fn(), mutate: vi.fn() }));

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => harness.useApi(...args),
  apiCall: vi.fn(),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, isSignedIn: true, getToken: async () => "t" }) }));
vi.mock("@/lib/useMyDisplayName", () => ({ useMyDisplayName: () => "Me" }));
vi.mock("@/components/onboarding/PairDeviceForm", () => ({ PairDeviceForm: () => <p>Pairing form</p> }));
vi.mock("@/components/onboarding/useReleaseInfo", () => ({ useReleaseInfo: () => ({ data: undefined }) }));

import { MmrStatsPanel } from "@/components/analyzer/mmr/MmrStatsPanel";
import { BuildAgingCurve } from "@/components/analyzer/mmr/BuildAgingCurve";
import { MmrProgressionByBuild } from "@/components/analyzer/mmr/MmrProgressionByBuild";
import { BuildMatchupHeatmap } from "@/components/analyzer/mmr/BuildMatchupHeatmap";
import { LadderContextCard } from "@/components/analyzer/LadderContextCard";
import { MixOverTimeChart } from "@/components/analyzer/charts/MixOverTimeChart";
import { OppMmrBucketGamesModal } from "@/components/analyzer/charts/OppMmrBucketGamesModal";
import { NetMmrRaceOpponentsModal } from "@/components/analyzer/charts/NetMmrRaceOpponentsModal";
import { ReportGamesModal } from "@/components/analyzer/macro/report/ReportGamesModal";
import { SettingsFoundation } from "@/components/analyzer/settings/SettingsFoundation";
import { ReplayArchiveStatusCard } from "@/components/analyzer/settings/ReplayArchiveStatusCard";
import { DevicesPanel } from "@/components/DevicesPanel";

const SERVER_ERROR = { status: 500, code: "internal_error", message: "x", requestId: "abcdef12-3456" };

beforeEach(() => {
  harness.mutate.mockReset();
  harness.mutate.mockResolvedValue(undefined);
  harness.useApi.mockReset();
  harness.useApi.mockImplementation(() => ({
    data: undefined,
    error: SERVER_ERROR,
    isLoading: false,
    isValidating: false,
    mutate: harness.mutate,
  }));
  window.localStorage.clear();
});

afterEach(cleanup);

const SECTIONS: Array<[string, () => ReactElement, RegExp | null]> = [
  [
    "MMR stats panel",
    () => (
      <MmrStatsPanel
        title="Win rate by MMR"
        endpoint="/v1/mmr-stats/builds"
        seriesKey="build"
        seriesLabel="Builds"
        storageNamespace="test.mmr"
      />
    ),
    null,
  ],
  ["Build mastery curve", () => <BuildAgingCurve />, /No builds with enough plays yet/],
  ["MMR progression by build", () => <MmrProgressionByBuild />, /No MMR-tagged builds yet/],
  ["Build × strategy heatmap", () => <BuildMatchupHeatmap />, /No matchups in this bucket yet|no MMR data yet/],
  ["Ladder context", () => <LadderContextCard pulseId="2-S2-1-1" />, null],
  [
    "Mix over time",
    () => <MixOverTimeChart endpoint="timeseries/my-builds" title="Build mix" caption="Share of games" bucket="week" />,
    /Not enough data to plot a mix yet/,
  ],
  [
    "Opponent MMR band games",
    () => <OppMmrBucketGamesModal band={{ lo: 4000, hi: 4100, wins: 3, losses: 2, total: 5 }} onClose={() => {}} />,
    /No games in this band/,
  ],
  ["Net MMR opponents", () => <NetMmrRaceOpponentsModal race="T" onClose={() => {}} />, /No opponents match|0 opponents/],
  [
    "Macro report games",
    () => <ReportGamesModal drill={{ title: "Low supply", params: { leak: "supply" } }} onClose={() => {}} />,
    /No matching games/,
  ],
  ["Settings account", () => <SettingsFoundation />, /Couldn.t load your account/],
  ["Replay archive status", () => <ReplayArchiveStatusCard />, null],
  ["Devices", () => <DevicesPanel />, /No devices paired yet|Failed to load/],
];

describe("migrated sections offer recovery when their request fails", () => {
  it.each(SECTIONS)("%s", async (_name, renderSection, falseState) => {
    render(renderSection());
    expect(screen.getAllByTestId("request-error").length).toBeGreaterThan(0);
    if (_name === "Settings account") expect(screen.getByText("Couldn't load your Foundation settings")).toBeTruthy();
    if (falseState) expect(screen.queryByText(falseState)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: _name === "Settings account" ? "Try again" : "Retry" })[0]);
    });
    expect(harness.mutate).toHaveBeenCalled();
  });
});

describe("migrated sections keep their skeleton while loading", () => {
  it.each(SECTIONS)("%s", (_name, renderSection) => {
    harness.useApi.mockImplementation(() => ({ data: undefined, error: undefined, isLoading: true, mutate: harness.mutate }));
    render(renderSection());
    expect(screen.queryByTestId("request-error")).toBeNull();
  });
});
