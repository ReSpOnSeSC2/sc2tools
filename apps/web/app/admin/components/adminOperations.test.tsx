import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { useState, type ReactNode } from "react";
import { AdminActionCard } from "./AdminActionCard";
import { UserLookupField, type ResolvedAdminUser } from "./UserLookupField";
import { AdminEventRow } from "./AdminEventRow";
import { BackgroundJobs } from "./BackgroundJobs";
const auth = vi.hoisted(() => ({ getToken: vi.fn(async () => "local-test-token") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ ...auth, isLoaded: true, isSignedIn: true, userId: "admin" }) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
const user = { userId: "user-123", email: "player@example.test", gameCount: 12, opponentCount: 4, lastActivity: "2026-10-01" };
let fetcher: ReturnType<typeof vi.fn>;
function view(content: ReactNode) { return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>{content}</SWRConfig>); }
function Lookup() { const [selected, setSelected] = useState<ResolvedAdminUser | null>(null); return <UserLookupField value={selected} onChange={setSelected} />; }
beforeEach(() => { fetcher = vi.fn(async () => Response.json({ items: [user] })); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("debounces five search edits into one request at300ms, then exact pasted userId resolves", async () => {
  vi.useFakeTimers(); view(<Lookup />); const input = screen.getByRole("combobox");
  for (const value of ["u", "us", "use", "user", "user-"]) fireEvent.change(input, { target: { value } });
  await act(async () => { await vi.advanceTimersByTimeAsync(299); }); expect(fetcher).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(fetcher).toHaveBeenCalledOnce(); expect(String(fetcher.mock.calls[0][0])).toContain("search=user-");
  fireEvent.change(input, { target: { value: "user-123" } }); await act(async () => { await vi.advanceTimersByTimeAsync(300); });
  expect(screen.getByRole("button", { name: "Change user" })).toBeTruthy(); expect(screen.queryByRole("combobox")).toBeNull();
});

it("lookup list supports arrows/Enter/Escape and repair is disabled until a real option resolves", async () => {
  view(<AdminActionCard action="rebuild-opponents" />); expect((screen.getByRole("button", { name: "Rebuild opponents" }) as HTMLButtonElement).disabled).toBe(true);
  const input = screen.getByRole("combobox"); fireEvent.change(input, { target: { value: "player" } });
  await screen.findByRole("option"); fireEvent.keyDown(input, { key: "Escape" }); expect(input.getAttribute("aria-expanded")).toBe("false");
  fireEvent.keyDown(input, { key: "ArrowDown" }); fireEvent.keyDown(input, { key: "Enter" });
  expect((screen.getByRole("button", { name: "Rebuild opponents" }) as HTMLButtonElement).disabled).toBe(false);
});

it("wipe names the exact game count, preserves account/builds, and requires the resolved email", async () => {
  fetcher.mockImplementation(async () => Response.json({ games: 12, opponents: 4, macroJobs: 3 }));
  view(<AdminActionCard action="wipe-games" user={user} />); fireEvent.click(screen.getByRole("button", { name: "Wipe games" }));
  expect(screen.getByText(/This deletes exactly 12 games/)).toBeTruthy(); expect(screen.getByText(/The account and custom builds are kept\. This cannot be undone\./)).toBeTruthy();
  const confirm = screen.getByRole("button", { name: "Wipe permanently" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true); fireEvent.change(screen.getByRole("textbox", { name: "Type player@example.test to confirm" }), { target: { value: "wrong" } }); expect(confirm.disabled).toBe(true);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: user.email } }); fireEvent.click(confirm);
  expect(await screen.findByText("Wiped 12 games, 4 opponents, 3 macro jobs.")).toBeTruthy(); expect(screen.getByRole("link", { name: "Open user →" }).getAttribute("href")).toBe("/admin/users/user-123");
});

it("no-email users require the userId; unknown user404 is recoverable and result copy includes all counters", async () => {
  fetcher.mockImplementation(async () => Response.json({ error: { code: "user_not_found" } }, { status: 404 }));
  view(<AdminActionCard action="wipe-games" user={{ ...user, email: null }} />); fireEvent.click(screen.getByRole("button", { name: "Wipe games" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Type user-123 to confirm" }), { target: { value: user.userId } }); fireEvent.click(screen.getByRole("button", { name: "Wipe permanently" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "No user with that ID"); fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.getByRole("button", { name: "Wipe games" })).toBeTruthy();
});

it("rebuild keeps the same success counters on either embedding page and uses an ordinary confirmation", async () => {
  fetcher.mockImplementation(async () => Response.json({ games: 12, opponents: 4, macroJobs: 3, droppedRows: 8 }));
  view(<AdminActionCard action="rebuild-opponents" user={user} />); fireEvent.click(screen.getByRole("button", { name: "Rebuild opponents" }));
  expect(screen.queryByRole("textbox")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "Rebuild" }));
  expect(await screen.findByText("Games kept: 12 · Opponents rebuilt: 4 · Macro jobs kept: 3.")).toBeTruthy();
});

it("job Run now confirms before requesting and retains Retry when the request fails", async () => {
  fetcher.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? Response.json({ error: { code: "job_disabled" } }, { status: 409 }) : Response.json({ jobs: [{ job: "test-job", lastOk: null, lastError: null, durations: [5, 10], nextDue: null, disabled: false, running: false, canRun: true }] }));
  view(<BackgroundJobs />); fireEvent.click(await screen.findByRole("button", { name: "Run now" }));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  fireEvent.click(screen.getAllByRole("button", { name: "Run now" })[1]); expect(await screen.findByRole("alert")).toBeTruthy();
  await waitFor(() => expect((screen.getAllByRole("button", { name: "Run now" })[1] as HTMLButtonElement).disabled).toBe(false));
});

it("overdue job alerts have honest copy and a direct infrastructure link",()=>{
  view(<ul><AdminEventRow event={{eventId:"overdue",type:"job_overdue",payload:{job:"guide-stats",intervalMs:3600000},createdAt:"2026-10-23T12:00:00Z",readAt:null}} unread/></ul>);
  expect(screen.getByText("Background job overdue")).toBeTruthy();expect(screen.getByText(/guide-stats · no OK run for at least 3 intervals/)).toBeTruthy();expect(screen.getByRole("link",{name:"Open Infrastructure →"}).getAttribute("href")).toBe("/admin/health#background-jobs");expect(screen.queryByText(/Agent download/)).toBeNull();
});
