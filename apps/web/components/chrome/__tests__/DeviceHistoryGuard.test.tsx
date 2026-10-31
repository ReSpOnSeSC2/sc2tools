import { cleanup, render, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ isLoaded: true, isSignedIn: true, userId: "user-a" as string | null }));
const forget = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@clerk/nextjs", () => ({ useAuth: () => auth }));
vi.mock("@/lib/analysisCorpus/deviceNote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysisCorpus/deviceNote")>();
  return {
    ...actual,
    forgetDeviceCopy: (...args: Parameters<typeof actual.forgetDeviceCopy>) => {
      forget.calls += 1;
      actual.forgetDeviceCopy(...args);
    },
  };
});

import { DeviceHistoryGuard } from "../DeviceHistoryGuard";
import { mayHaveDeviceCopy, noteDeviceCopy } from "@/lib/analysisCorpus/deviceNote";
import { openDeviceCorpus, saveDeviceSnapshot } from "@/lib/analysisCorpus/deviceStore";

const MARKS = { corpusVersion: 1, watermark: "2026-10-31T10:00:00.000Z", corpusEpoch: "1.0123456789abcdef" };
let factory: IDBFactory;

beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  window.localStorage.clear();
  forget.calls = 0;
  Object.assign(auth, { isLoaded: true, isSignedIn: true, userId: "user-a" });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function keep(accountKey: string) {
  const db = await openDeviceCorpus(factory, { create: true });
  await saveDeviceSnapshot(db!, accountKey, [{ gameId: "g1" }], MARKS, 10);
  db!.close();
  noteDeviceCopy(accountKey);
}

/** Let a guard that decided to clear load its clearing code and run it. */
async function settle() {
  await import("@/lib/analysisCorpus/deviceNote");
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function untilNoDatabases() {
  for (let tries = 0; tries < 50 && (await factory.databases()).length > 0; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return factory.databases();
}

describe("DeviceHistoryGuard", () => {
  it("keeps the signed-in account's own copy", async () => {
    await keep("user-a");
    render(<DeviceHistoryGuard />);
    await settle();
    expect([forget.calls, mayHaveDeviceCopy("user-a"), (await factory.databases()).length]).toEqual([0, true, 1]);
  });

  it("removes the copy once nobody is signed in", async () => {
    await keep("user-a");
    Object.assign(auth, { isSignedIn: false, userId: null });
    render(<DeviceHistoryGuard />);
    await waitFor(() => expect(mayHaveDeviceCopy("user-a")).toBe(false));
    expect(forget.calls).toBe(1);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("removes the previous account's copy when another account signs in", async () => {
    await keep("user-a");
    const view = render(<DeviceHistoryGuard />);
    await settle();
    expect(forget.calls).toBe(0);
    auth.userId = "user-b";
    view.rerender(<DeviceHistoryGuard />);
    await waitFor(() => expect(forget.calls).toBe(1));
    expect(mayHaveDeviceCopy("user-a")).toBe(false);
    expect(await untilNoDatabases()).toEqual([]);
  });

  it("does nothing before Clerk loads, or when no copy is noted", async () => {
    await keep("user-a");
    Object.assign(auth, { isLoaded: false, isSignedIn: false, userId: null });
    const view = render(<DeviceHistoryGuard />);
    await settle();
    expect([forget.calls, mayHaveDeviceCopy("user-a")]).toEqual([0, true]);

    noteDeviceCopy(null);
    auth.isLoaded = true;
    view.rerender(<DeviceHistoryGuard />);
    await settle();
    expect([forget.calls, (await factory.databases()).length]).toEqual([0, 1]);
  });
});
