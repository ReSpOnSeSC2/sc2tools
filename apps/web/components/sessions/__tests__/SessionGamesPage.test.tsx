import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProfileGame } from "@/components/analyzer/Last5GamesTimeline";
import { SessionGamesPage } from "../SessionGamesPage";
import { historyDetail, historyGame } from "./sessionHistoryFixtures";

const table = vi.hoisted(() => ({ props: undefined as undefined | { games: ProfileGame[]; pageLocalSort: boolean; opponentContext?: unknown; targetGameId?: unknown; rowKey: (row: ProfileGame, index: number) => string } }));
vi.mock("@/components/analyzer/AllGamesTable", () => ({ AllGamesTable: (props: NonNullable<typeof table.props>) => { table.props = props; return <div role="table" aria-label="Delivered session games">{props.games.map((game, index) => <div key={props.rowKey(game, index)} role="row">{game.id ?? "Unlinked recorded game"}</div>)}</div>; } }));
vi.mock("@/components/analyzer/GameAnalysisLink", () => ({ GameSourceLabelProvider: ({ children }: { children: ReactNode }) => children }));
afterEach(() => { cleanup(); table.props = undefined; });

it("mounts only the delivered page, retains duplicate/null public IDs and real metadata, and never fabricates dossier context", () => {
  const games = Array.from({ length: 50 }, (_, index) => historyGame({ position: index + 51, id: index < 2 ? "duplicate-real-id" : null, gameId: index < 2 ? "duplicate-real-id" : null, recordedEndGapSec: 900 }));
  render(<SessionGamesPage data={historyDetail({ games, gamePage: { limit: 50, count: 50, total: 5000 } })} id="opaque-session" query={new URLSearchParams({ tz: "UTC", gamesBefore: "old-page" })} />);
  expect(screen.getAllByRole("row")).toHaveLength(50);
  expect(table.props?.pageLocalSort).toBe(true);
  expect(table.props?.games[0].id).toBe("duplicate-real-id"); expect(table.props?.games[1].id).toBe("duplicate-real-id"); expect(table.props?.games[2].id).toBeNull();
  expect(table.props).not.toHaveProperty("opponentContext"); expect(table.props).not.toHaveProperty("targetGameId");
  const keys = table.props?.games.map((game, index) => table.props?.rowKey(game, index)); expect(new Set(keys).size).toBe(50);
  expect(screen.getByRole("link", { name: "Next games in this session" }).getAttribute("href")).toContain("gamesBefore=next-game-page");
  expect(screen.getByText(/These gaps include game time/)).toBeTruthy();
});
