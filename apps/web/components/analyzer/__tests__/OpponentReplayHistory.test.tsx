import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  appendReplayPageQuery,
  OpponentReplayHistory,
} from "../OpponentReplayHistory";

const useApiMock = vi.fn();

vi.mock("@/lib/clientApi", () => ({
  useApi: (...args: unknown[]) => useApiMock(...args),
}));

vi.mock("../AllGamesTable", () => ({
  AllGamesTable: ({ games }: { games: Array<{ id?: string | null }> }) => (
    <div data-testid="replay-rows">
      {games.length}:{games.map((game) => game.id).join(",")}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  useApiMock.mockReset();
});

const BASE_PROPS = {
  path: "/v1/opponents/opp-a/games?map_pool=ladder",
  initialGames: [{ id: "fallback", opponent: "Rival" }],
  profileTruncated: true,
  opponentContext: { pulseId: "opp-a", displayName: "Rival" },
};

describe("OpponentReplayHistory", () => {
  it("replaces bounded pages and walks back with Newer/Older controls", () => {
    const mutate = vi.fn();
    useApiMock.mockImplementation((path: string) => {
      const secondPage = path.includes("cursor=cursor%2Ftwo");
      return {
        data: secondPage
          ? { items: [{ id: "older-1" }], nextCursor: null }
          : {
              items: [{ id: "new-1" }, { id: "new-2" }],
              nextCursor: "cursor/two",
            },
        error: null,
        isLoading: false,
        isValidating: false,
        mutate,
      };
    });

    render(<OpponentReplayHistory {...BASE_PROPS} />);

    expect(useApiMock).toHaveBeenCalledWith(
      "/v1/opponents/opp-a/games?map_pool=ladder&limit=200",
      { revalidateOnFocus: false },
    );
    expect(screen.getByTestId("replay-rows").textContent).toBe(
      "2:new-1,new-2",
    );

    fireEvent.click(screen.getByRole("button", { name: "Older replays" }));
    expect(useApiMock).toHaveBeenLastCalledWith(
      "/v1/opponents/opp-a/games?map_pool=ladder&limit=200&cursor=cursor%2Ftwo",
      { revalidateOnFocus: false },
    );
    expect(screen.getByTestId("replay-rows").textContent).toBe("1:older-1");
    expect(screen.getByText("Showing 201–201")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Newer replays" }));
    expect(screen.getByTestId("replay-rows").textContent).toBe(
      "2:new-1,new-2",
    );
  });

  it("bounds the existing profile fallback to 200 rows while page one loads", () => {
    useApiMock.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
      isValidating: true,
      mutate: vi.fn(),
    });
    const initialGames = Array.from({ length: 205 }, (_, i) => ({
      id: `g-${i}`,
    }));

    render(
      <OpponentReplayHistory {...BASE_PROPS} initialGames={initialGames} />,
    );

    expect(screen.getByTestId("replay-rows").textContent?.startsWith("200:"))
      .toBe(true);
    expect(screen.getByText("Latest 200 replays · loading full history…"))
      .toBeTruthy();
    expect(screen.getByText("Loading the compact replay-history page…"))
      .toBeTruthy();
  });

  it("resets to page one when the query-scoped component key changes", () => {
    useApiMock.mockImplementation((path: string) => ({
      data: path.includes("cursor=")
        ? { items: [{ id: "old-page" }], nextCursor: null }
        : { items: [{ id: "page-one" }], nextCursor: "older" },
      error: null,
      isLoading: false,
      isValidating: false,
      mutate: vi.fn(),
    }));
    const firstPath = "/v1/opponents/opp-a/games?map=Alcyone";
    const { rerender } = render(
      <OpponentReplayHistory
        {...BASE_PROPS}
        key={firstPath}
        path={firstPath}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Older replays" }));
    expect(screen.getByTestId("replay-rows").textContent).toBe("1:old-page");

    const nextPath = "/v1/opponents/opp-a/games?map=Ghost+River";
    rerender(
      <OpponentReplayHistory
        {...BASE_PROPS}
        key={nextPath}
        path={nextPath}
      />,
    );

    expect(useApiMock).toHaveBeenLastCalledWith(
      "/v1/opponents/opp-a/games?map=Ghost+River&limit=200",
      { revalidateOnFocus: false },
    );
    expect(screen.getByTestId("replay-rows").textContent).toBe("1:page-one");
    expect(
      (screen.getByRole("button", { name: "Newer replays" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("keeps fallback rows usable and offers retry when page one fails", () => {
    const mutate = vi.fn();
    useApiMock.mockReturnValue({
      data: undefined,
      error: { status: 503, message: "unavailable" },
      isLoading: false,
      isValidating: false,
      mutate,
    });

    render(<OpponentReplayHistory {...BASE_PROPS} />);

    expect(screen.getByTestId("replay-rows").textContent).toBe("1:fallback");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("can return to a newer page after an older-page request fails", () => {
    useApiMock.mockImplementation((path: string) => {
      if (path.includes("cursor=")) {
        return {
          data: undefined,
          error: { status: 503, message: "unavailable" },
          isLoading: false,
          isValidating: false,
          mutate: vi.fn(),
        };
      }
      return {
        data: { items: [{ id: "newest" }], nextCursor: "older" },
        error: null,
        isLoading: false,
        isValidating: false,
        mutate: vi.fn(),
      };
    });

    render(<OpponentReplayHistory {...BASE_PROPS} />);
    fireEvent.click(screen.getByRole("button", { name: "Older replays" }));

    expect(screen.getByText("Page unavailable")).toBeTruthy();
    const newer = screen.getByRole("button", { name: "Newer replays" });
    expect((newer as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(newer);
    expect(screen.getByTestId("replay-rows").textContent).toBe("1:newest");
  });
});

describe("appendReplayPageQuery", () => {
  it("adds a bounded limit and URL-encodes the opaque cursor", () => {
    expect(appendReplayPageQuery("/feed", "a/b+c=")).toBe(
      "/feed?limit=200&cursor=a%2Fb%2Bc%3D",
    );
  });
});
