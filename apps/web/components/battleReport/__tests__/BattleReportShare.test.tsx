import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { reportFixtures } from "@/lib/battleReport/__tests__/fixtures";
import { battleReportFacts, type BattleReportInput } from "@/lib/battleReport/facts";
import { planBattleReport, reportText } from "@/lib/battleReport/plan";
import { shareSafeReportInput } from "@/lib/sharedGame";
import { BattleReportSection } from "../BattleReportSection";

const image = vi.hoisted(() => ({
  render: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
  download: vi.fn(),
}));
vi.mock("@/lib/battleReportImage", () => ({
  renderBattleReportPng: image.render,
  downloadBlob: image.download,
  battleReportImageFilename: () => "sc2-battle-report-test.png",
}));
vi.mock("@/components/help/LazyHelpLink", () => ({ LazyHelpLink: () => <span>How this is written</span> }));
vi.mock("../MapStill", () => ({ MapStill: () => <div role="img" aria-label="Rendered map still" /> }));

afterEach(() => { cleanup(); image.render.mockClear(); image.download.mockClear(); });

/** An owner input whose private details must never reach a shared report. */
function ownerInput(index: number): BattleReportInput {
  const base = reportFixtures[index];
  return {
    ...base,
    game: { ...base.game, buildPlanned: true, myBuild: "Secret checked-in plan", myMmr: 4130, opponent: { ...base.game.opponent, displayName: "SecretFoe#1234", mmr: 4088 } },
    plannedBuild: "Secret checked-in plan",
  };
}
const SECRETS = ["SecretFoe#1234", "4130", "4088", "Secret checked-in plan", "Replay player", "Replay rival"];
const SECOND_PERSON = /\byou(r|rs)?\b/i;

describe("shared battle reports", () => {
  it.each(reportFixtures.map((_, index) => index))("fixture %i: the shared voice names no one, prints no rating and never says you", (index) => {
    for (const tone of ["battle", "caster", "tactical"] as const) {
      const report = planBattleReport(battleReportFacts(shareSafeReportInput(ownerInput(index))), tone);
      const text = reportText(report, true, (time) => `/g/AbCdEfGhIjKlMnOp?t=${Math.floor(time)}`);
      for (const secret of SECRETS) expect(text).not.toContain(secret);
      expect(text).not.toMatch(SECOND_PERSON);
      expect(text).not.toContain("/app/game/");
    }
  });

  it("keeps the owner's own report text as it was", () => {
    const owner = planBattleReport(battleReportFacts(reportFixtures[2]), "battle");
    expect(reportText(owner)).toMatch(SECOND_PERSON);
    expect(reportText(owner)).toContain("Replay rival");
  });

  it("points time links and copies at the share page and labels the player's side", async () => {
    const seek = vi.fn();
    const view = render(<BattleReportSection input={shareSafeReportInput(ownerInput(2))} onSeek={seek}
      timeHref={(time) => `/g/AbCdEfGhIjKlMnOp?t=${Math.floor(time)}#replay`} />);
    const links = Array.from(view.container.querySelectorAll<HTMLAnchorElement>("[data-report-paragraph] a"));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute("href")).toMatch(/^\/g\/AbCdEfGhIjKlMnOp\?t=\d+#replay$/);
    fireEvent.click(links[0]);
    expect(seek).toHaveBeenCalled();
    expect(view.container.textContent).toContain("Player in cyan");
    expect(view.container.textContent).not.toContain("You in cyan");
    const copy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(copy).toHaveBeenCalled());
    expect(String((copy.mock.calls[0] as unknown[])[0])).toContain("(/g/AbCdEfGhIjKlMnOp?t=");
  });

  it("saves the image from the share-safe report, even on the owner's page", async () => {
    render(<BattleReportSection input={ownerInput(2)} onSeek={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as image" }));
    await waitFor(() => expect(image.download).toHaveBeenCalledWith(expect.any(Blob), "sc2-battle-report-test.png"));
    const [report, samples] = image.render.mock.calls[0] as unknown as [ReturnType<typeof planBattleReport>, { result: string }];
    const text = reportText(report);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toMatch(SECOND_PERSON);
    expect(samples.result).toBe(reportFixtures[2].game.result);
  });
});
