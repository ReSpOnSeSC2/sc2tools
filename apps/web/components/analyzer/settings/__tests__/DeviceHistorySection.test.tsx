import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { idbTransactionOn } from "@/lib/instant/idb";
import { deviceNote, noteDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
import { openDeviceCorpus, resetDeviceCorpus, saveDeviceSnapshot } from "@/lib/analysisCorpus/deviceStore";
import { ToastProvider } from "@/components/ui/Toast";
import { DeviceHistorySection } from "../DeviceHistorySection";

const auth = vi.hoisted(() => ({ isLoaded: true, userId: "user-a" as string | null }));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: auth.isLoaded, userId: auth.userId }),
}));

const MARKS = { corpusVersion: 1, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: "1.0123456789abcdef" };
let factory: IDBFactory;

function game(gameId: string, map = "Ancient Cistern LE") {
  return { gameId, date: "2026-10-31T09:00:00.000Z", result: "Victory", map };
}

async function keepCopy(accountKey: string, rows: ReturnType<typeof game>[]) {
  const db = await openDeviceCorpus(factory, { create: true });
  await saveDeviceSnapshot(db!, accountKey, rows, MARKS, 100);
  db!.close();
  noteDeviceCopy(accountKey);
}

function section(revision = 0) {
  return render(
    <ToastProvider>
      <DeviceHistorySection revision={revision} />
    </ToastProvider>,
  );
}

// The toast is a status too; the row is the section's own.
const row = () => within(document.getElementById("device-history")!).getByRole("status");
const clearButton = () => screen.queryByRole("button", { name: "Clear games stored on this device" });

beforeEach(() => {
  auth.isLoaded = true;
  auth.userId = "user-a";
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DeviceHistorySection", () => {
  it("shows how many games this account keeps here and about how much space, then clears only this device", async () => {
    await keepCopy("user-a", [game("a1"), game("a2"), game("a3")]);
    section();
    expect(row().textContent).toBe("Checking this device…");
    await waitFor(() => expect(row().textContent).toBe("Games stored on this device: 3 (under 0.1 MB)"));
    expect(screen.getByRole("link", { name: "Your history on this device" }).getAttribute("href")).toBe("/help/history-on-this-device");

    fireEvent.click(clearButton()!);
    expect(row().textContent).toBe("No games are stored on this device.");
    expect(clearButton()).toBeNull();
    expect(screen.getByText("Cleared from this device")).toBeTruthy();
    expect(screen.getByText("Your games are still in your account.")).toBeTruthy();
    expect(deviceNote()).toBeNull();
    await waitFor(async () => expect(await factory.databases()).toEqual([]));
  });

  it("rounds a larger copy to a tenth of a megabyte", async () => {
    await keepCopy("user-a", ["a1", "a2", "a3", "a4"].map((id) => game(id, "x".repeat(60_000))));
    section();
    await waitFor(() => expect(row().textContent).toBe("Games stored on this device: 4 (about 0.2 MB)"));
  });

  it("never opens the database for an account this browser doesn't keep, or when signed out", async () => {
    await keepCopy("user-b", [game("b1")]);
    const open = vi.spyOn(factory, "open");
    const view = section();
    await waitFor(() => expect(row().textContent).toBe("No games are stored on this device."));
    expect(clearButton()).toBeNull();
    view.unmount();

    auth.userId = null;
    section();
    await waitFor(() => expect(row().textContent).toBe("No games are stored on this device."));
    expect(open).not.toHaveBeenCalled();
  });

  it("waits for sign-in to load before checking", async () => {
    auth.isLoaded = false;
    await keepCopy("user-a", [game("a1")]);
    const view = section();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(row().textContent).toBe("Checking this device…");

    auth.isLoaded = true;
    view.rerender(
      <ToastProvider>
        <DeviceHistorySection revision={0} />
      </ToastProvider>,
    );
    await waitFor(() => expect(row().textContent).toBe("Games stored on this device: 1 (under 0.1 MB)"));
  });

  it("never creates the database when the copy this browser notes is gone", async () => {
    noteDeviceCopy("user-a");
    section();
    await waitFor(() => expect(row().textContent).toBe("No games are stored on this device."));
    expect(await factory.databases()).toEqual([]);
  });

  it("says when this browser refuses storage, with nothing to clear", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const view = section();
    await waitFor(() => expect(row().textContent).toBe("This browser isn’t letting us store data, so no games are kept here."));
    expect(clearButton()).toBeNull();
    view.unmount();

    vi.stubGlobal("indexedDB", factory);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    section();
    await waitFor(() => expect(row().textContent).toBe("This browser isn’t letting us store data, so no games are kept here."));
  });

  it("lets a kept choice with no games, or a copy it can't read, be cleared too", async () => {
    await keepCopy("user-a", [game("a1")]);
    const db = await openDeviceCorpus(factory, { create: false });
    await resetDeviceCorpus(db!, "user-a");
    const view = section();
    await waitFor(() => expect(row().textContent).toBe("Your history is set to be kept here, but no games are stored."));
    expect(clearButton()).toBeTruthy();
    view.unmount();

    await idbTransactionOn(db!, "accounts", "readwrite", (tx) => {
      tx.objectStore("accounts").put({ accountKey: "user-a", savedAt: "", marks: MARKS, count: 2, schema: 99 });
    });
    db!.close();
    section();
    await waitFor(() => expect(row().textContent).toBe("Couldn’t check this device."));
    expect(clearButton()).toBeTruthy();
  });

  it("reads again when the page restores a snapshot or wipes history", async () => {
    await keepCopy("user-a", [game("a1")]);
    const view = section(0);
    await waitFor(() => expect(row().textContent).toBe("Games stored on this device: 1 (under 0.1 MB)"));

    await keepCopy("user-a", [game("a1"), game("a2")]);
    view.rerender(
      <ToastProvider>
        <DeviceHistorySection revision={1} />
      </ToastProvider>,
    );
    await waitFor(() => expect(row().textContent).toBe("Games stored on this device: 2 (under 0.1 MB)"));
  });

  it("shows nothing of this account's when it was cleared while reading", async () => {
    await keepCopy("user-a", [game("a1")]);
    const open = factory.open.bind(factory);
    vi.spyOn(factory, "open").mockImplementation((...args: Parameters<IDBFactory["open"]>) => {
      // Another tab clears the copy while this one opens it.
      window.localStorage.clear();
      return open(...args);
    });
    section();
    await waitFor(() => expect(row().textContent).toBe("No games are stored on this device."));
  });
});
