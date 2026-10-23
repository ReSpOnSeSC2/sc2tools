import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

const harness = vi.hoisted(() => ({
  handlers: null as Record<string, (payload: unknown) => void> | null,
  calls: 0,
}));

vi.mock("@/lib/useUserSocket", () => ({
  useUserSocket: (handlers: Record<string, (payload: unknown) => void> | null) => {
    harness.handlers = handlers;
    harness.calls += 1;
  },
}));

import {
  BuildCheckInProvider,
  useBuildCheckInPrefsRevision,
  useBuildCheckInRevision,
} from "../BuildCheckInProvider";

function PrefsConsumer() {
  return <span>prefs:{useBuildCheckInPrefsRevision()}</span>;
}

function Consumer({ live = true, label = "consumer" }: { live?: boolean; label?: string }) {
  const { revision, bump } = useBuildCheckInRevision(live);
  return (
    <button type="button" onClick={bump}>
      {label}:{revision}
    </button>
  );
}

function Toggleable() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShown((value) => !value)}>
        toggle
      </button>
      {shown ? <Consumer label="live" /> : null}
    </>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  harness.handlers = null;
  harness.calls = 0;
});

describe("BuildCheckInProvider", () => {
  it("opens the shared socket only while a live consumer is mounted", () => {
    render(
      <BuildCheckInProvider>
        <Consumer live={false} label="passive" />
        <Toggleable />
      </BuildCheckInProvider>,
    );
    expect(harness.handlers).not.toBeNull();
    expect(Object.keys(harness.handlers ?? {})).toEqual([
      "build-intent:changed",
      "games:changed",
    ]);
    fireEvent.click(screen.getByText("toggle"));
    expect(harness.handlers).toBeNull();
  });

  it("bumps the revision shortly after a build-intent ping", () => {
    render(
      <BuildCheckInProvider>
        <Consumer />
      </BuildCheckInProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("consumer:0");
    act(() => {
      harness.handlers?.["build-intent:changed"]({ gameId: "g1" });
    });
    expect(screen.getByRole("button").textContent).toBe("consumer:0");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("button").textContent).toBe("consumer:1");
  });

  it("applies the shared client's already-coalesced game refresh without another delay", () => {
    render(<BuildCheckInProvider><Consumer /></BuildCheckInProvider>);
    act(() => { harness.handlers?.["games:changed"]({ count: 75, inserted: 50, bulk: true }); vi.advanceTimersByTime(0); });
    expect(screen.getByRole("button").textContent).toBe("consumer:1");
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole("button").textContent).toBe("consumer:1");
  });

  it("a coalesced game refresh clears a pending check-in refresh", () => {
    render(
      <BuildCheckInProvider>
        <Consumer />
      </BuildCheckInProvider>,
    );
    act(() => {
      harness.handlers?.["build-intent:changed"]({ gameId: "g1" });
      harness.handlers?.["games:changed"]({ count: 1 });
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("button").textContent).toBe("consumer:1");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("button").textContent).toBe("consumer:1");
  });

  it("refreshes every consumer at once on a local bump", () => {
    render(
      <BuildCheckInProvider>
        <Consumer label="a" />
        <Consumer label="b" live={false} />
      </BuildCheckInProvider>,
    );
    fireEvent.click(screen.getByText("a:0"));
    expect(screen.getByText("a:1")).toBeTruthy();
    expect(screen.getByText("b:1")).toBeTruthy();
  });

  it("counts preference pings separately and keeps the socket open for them", () => {
    render(
      <BuildCheckInProvider>
        <PrefsConsumer />
        <Consumer live={false} />
      </BuildCheckInProvider>,
    );
    expect(harness.handlers).not.toBeNull();
    act(() => {
      harness.handlers?.["build-intent:changed"]({ gameId: "g1" });
      harness.handlers?.["build-intent:changed"]({ prefs: "yes" });
    });
    expect(screen.getByText("prefs:0")).toBeTruthy();
    act(() => {
      harness.handlers?.["build-intent:changed"]({ prefs: true });
    });
    expect(screen.getByText("prefs:1")).toBeTruthy();
    // It also refreshes the chip and queue (pending state follows the switch).
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole("button").textContent).toBe("consumer:1");
  });

  it("degrades to a fixed revision without a provider", () => {
    render(<Consumer />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("consumer:0");
  });
});
