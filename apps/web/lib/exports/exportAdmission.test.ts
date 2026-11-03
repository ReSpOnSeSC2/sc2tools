import { describe, expect, it, vi } from "vitest";
import { exportBusy, subscribeExportBusy, withExportAdmission } from "./exportAdmission";

describe("actual browser export admission", () => {
  it("keeps another owner out while cancellation cleanup is held", async () => {
    let release!: () => void;
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    const observations: boolean[] = [], detach = subscribeExportBusy(() => { observations.push(exportBusy()); });
    const failObserver = subscribeExportBusy(() => { throw new Error("disposable view"); });
    const attemptB = vi.fn(async () => "b");
    const workA = withExportAdmission(async () => { await cleanup; return "a"; });
    try {
      expect(exportBusy()).toBe(true);
      await expect(withExportAdmission(attemptB)).rejects.toMatchObject({ code: "busy" });
      expect(attemptB).not.toHaveBeenCalled();
      release(); expect(await workA).toBe("a");
      expect(exportBusy()).toBe(false);
      expect(await withExportAdmission(attemptB)).toBe("b");
      expect(observations).toEqual([true, false, true, false]);
    } finally { release(); await workA.catch(() => {}); detach(); failObserver(); }
  });

  it("releases only after an actually rejected operation settles", async () => {
    await expect(withExportAdmission(async () => { throw new Error("private transport detail"); })).rejects.toThrow();
    expect(exportBusy()).toBe(false);
    expect(await withExportAdmission(async () => true)).toBe(true);
  });
});
