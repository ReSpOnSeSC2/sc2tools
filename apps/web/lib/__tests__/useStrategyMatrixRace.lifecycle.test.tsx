import { Suspense, startTransition, useLayoutEffect, useState, type Provider } from "react";
import * as Clerk from "@clerk/nextjs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStrategyMatrixRace } from "../useStrategyMatrixRace";
import type { MatrixRace } from "../strategyMatrix";

type Auth = { userId: string | null; isLoaded: boolean; isSignedIn: boolean };
vi.mock("@clerk/nextjs", async () => {
  const React = await import("react");
  const context = React.createContext<Auth>({ userId: null, isLoaded: true, isSignedIn: false });
  return { useAuth: () => React.useContext(context), __FixtureAuthProvider: context.Provider };
});
// The only substitute is a real React auth Context. Product hook/storage and
// committed versus suspended React rendering remain actual consumers.
const AuthProvider = (Clerk as unknown as { __FixtureAuthProvider: Provider<Auth> }).__FixtureAuthProvider;
type Commit = { owner: string; choose: (next: MatrixRace) => void; race: MatrixRace | null };
const commits: Commit[] = [], attemptedOwners: string[] = [];
const blocked = new Promise<never>(() => {});
const auth = (owner: string): Auth => ({ userId: owner, isLoaded: true, isSignedIn: true });
const key = (owner: string) => `analyzer.strategies.matrixRace:${encodeURIComponent(owner)}`;
const stored = (owner: string) => localStorage.getItem(key(owner));
function latest(owner: string) {
  const value = commits.filter(row => row.owner === owner).at(-1);
  if (!value) throw new Error("Expected actual committed chooser");
  return value;
}

function Probe({ owner, suspend = false }: { owner: string; suspend?: boolean }) {
  const [race, choose] = useStrategyMatrixRace();
  attemptedOwners.push(owner); // Passive fixture observation of attempted render.
  useLayoutEffect(() => { commits.push({ owner, choose, race }); }, [owner, choose, race]);
  if (suspend) throw blocked;
  return <output aria-label="Committed matrix preference">{owner}:{race ?? "none"}</output>;
}
function ownerTree(owner: string) {
  return <AuthProvider value={auth(owner)}><Probe owner={owner} /></AuthProvider>;
}
function ConcurrentHost() {
  const [owner, setOwner] = useState("owner-a"), [suspended, setSuspended] = useState(false);
  return <>
    <button onClick={() => startTransition(() => { setOwner("owner-b"); setSuspended(true); })}>
      Begin suspended owner B
    </button>
    <button onClick={() => { setOwner("owner-a"); setSuspended(false); }}>Abandon owner B</button>
    <Suspense fallback={<p>Pending replacement</p>}><AuthProvider value={auth(owner)}>
      <Probe owner={owner} suspend={suspended} />
    </AuthProvider></Suspense>
  </>;
}

beforeEach(() => { localStorage.clear(); commits.length = 0; attemptedOwners.length = 0; });
afterEach(cleanup);

it("retires retained choosers on real unmount and owner A to B to A", () => {
  const view = render(ownerTree("owner-a"));
  const originalA = latest("owner-a").choose;
  act(() => originalA("T")); expect(stored("owner-a")).toBe('"T"');
  view.rerender(ownerTree("owner-b"));
  const originalB = latest("owner-b").choose;
  act(() => originalB("P")); expect(stored("owner-b")).toBe('"P"');
  view.rerender(ownerTree("owner-a"));
  const freshA = latest("owner-a").choose;
  act(() => freshA("Z")); expect(stored("owner-a")).toBe('"Z"');
  act(() => { originalA("P"); originalB("Z"); });
  expect(stored("owner-a")).toBe('"Z"'); expect(stored("owner-b")).toBe('"P"');
  view.unmount(); act(() => freshA("T"));
  expect(stored("owner-a")).toBe('"Z"'); expect(stored("owner-b")).toBe('"P"');
});

it("an abandoned concurrent B auth render cannot retire the committed A chooser", async () => {
  render(<ConcurrentHost />);
  const chooseA = latest("owner-a").choose;
  fireEvent.click(screen.getByRole("button", { name: "Begin suspended owner B" }));
  await waitFor(() => expect(attemptedOwners).toContain("owner-b"));
  expect(screen.getByLabelText("Committed matrix preference").textContent).toBe("owner-a:none");
  expect(commits.some(row => row.owner === "owner-b")).toBe(false);
  act(() => chooseA("T"));
  expect(stored("owner-a")).toBe('"T"'); expect(stored("owner-b")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Abandon owner B" }));
  await waitFor(() => expect(screen.getByLabelText("Committed matrix preference").textContent).toBe("owner-a:T"));
  expect(stored("owner-b")).toBeNull();
});
