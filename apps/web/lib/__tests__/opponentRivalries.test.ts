import { describe, expect, it } from "vitest";
import { chooseRivalries, opponentRowWindow, rivalryWilson } from "../opponentRivalries";
const now = Date.parse("2026-10-25T12:00:00Z");
const row = (pulseId: string, wins: number, losses: number, extra = {}) => ({ pulseId, name: pulseId, wins, losses, games: wins + losses, lastPlayed: "2026-10-24T12:00:00Z", ...extra });
describe("filtered rivalry choices", () => {
  it("uses Wilson uncertainty instead of ranking tiny perfect records first", () => {
    expect(rivalryWilson(60,100)).toEqual({ low: .502, high: .6906 });
    const result = chooseRivalries([row("one-off loss",0,1), row("nemesis",1,19), row("one-off win",1,0), row("favourite",18,2)], now);
    expect(result.nemesis?.pulseId).toBe("nemesis"); expect(result.favourite?.pulseId).toBe("favourite");
    expect(result["most-played"]?.games).toBe(20);
  });
  it("requires four decided games for Nemesis and two recorded meetings in the last seven days for Hot rematch", () => {
    const result = chooseRivalries([row("small",0,3), row("lifetime-many",30,30), row("hot",1,1,{ weekGames: 2 }), row("future",1,1,{ weekGames: 2,lastPlayed:"2026-10-26" }), row("old",1,1,{ weekGames: 2,lastPlayed:"2026-10-01" })], now);
    expect(result.nemesis?.pulseId).toBe("lifetime-many"); expect(result["hot-rematch"]?.pulseId).toBe("hot");
    expect(chooseRivalries([row("lifetime",10,10)],now)["hot-rematch"]).toBeNull();
  });
  it("returns no invented statistic for empty, tied-only or invalid samples", () => {
    expect(chooseRivalries([],now)).toEqual({ nemesis:null,favourite:null,"most-played":null,"hot-rematch":null });
    expect(chooseRivalries([row("ties",0,0,{games:4})],now).favourite).toBeNull();
    expect(rivalryWilson(-1,2)).toBeNull(); expect(rivalryWilson(1,0)).toBeNull();
  });
});

it("renders100 then200 logical rows out of1500, counting expanded identities against the same budget", () => {
  type Row = { pulseId: string; identities: Row[] };
  const rows: Row[] = Array.from({length:1500},(_,i) => ({ pulseId:String(i),identities:[] }));
  rows[0].identities = [{ pulseId:"a",identities:[] },{ pulseId:"b",identities:[] }];
  const first = opponentRowWindow(rows,new Set(["0"]),100), next = opponentRowWindow(rows,new Set(["0"]),200);
  expect(first.window).toHaveLength(100); expect(first.total).toBe(1502); expect(first.window[1].parent).toBe(rows[0]);
  expect(first.window.at(-1)?.row.pulseId).toBe("97"); expect(next.window).toHaveLength(200);
});
