import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PlayerIdentityPicker, type IdentityPlayer } from "../PlayerIdentityPicker";
import { OpponentIdentitySubmission, type IdentityProposal } from "../OpponentIdentitySubmission";
import AdminPlayerIdentitiesPage from "@/app/admin/player-identities/page";

const useApiMock = vi.fn();
const apiCallMock = vi.fn();
const mutateMock = vi.fn();
const getToken = vi.fn();
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: (...args: unknown[]) => useApiMock(...args), apiCall: (...args: unknown[]) => apiCallMock(...args) }));

const SOURCE: IdentityPlayer = { key: "toon:1-S2-1-123", pulseId: "1-S2-1-123", toonHandle: "1-S2-1-123", displayName: "IIIIllll", race: "Protoss", region: "US" };
const TARGET: IdentityPlayer = { key: "pulse:994428", pulseId: "994428", pulseCharacterId: "994428", toonHandle: "2-S2-1-456", displayName: "KnownPlayer", race: "Protoss", region: "EU" };
const OTHER: IdentityPlayer = { ...TARGET, key: "pulse:777", pulseId: "777", pulseCharacterId: "777", toonHandle: "1-S2-1-789", region: "US" };
const PROPOSAL: IdentityProposal = { id: "submission1", source: SOURCE, target: TARGET, reason: "The player showed this account on their stream.", status: "pending", createdAt: "2026-09-07T10:00:00Z", submitterUserId: "user_a", evidenceCount: 2, revision: 4 };
type Context = { isAdmin: boolean; eligible: boolean; source: IdentityPlayer; confirmed: { groupKey: string; displayName: string; target: IdentityPlayer; revision: number } | null; submission: IdentityProposal | null; replayCount: number; revision: number };
let context: Context;
let searchError: { message: string } | undefined;
let detailError: { message: string } | undefined;
let listError: { status: number; message: string } | undefined;
let proposal: IdentityProposal;

beforeEach(() => {
  useApiMock.mockReset(); apiCallMock.mockReset(); mutateMock.mockReset();
  context = { isAdmin: false, eligible: true, source: SOURCE, confirmed: null, submission: null, replayCount: 2, revision: 0 };
  searchError = undefined; detailError = undefined; listError = undefined; proposal = { ...PROPOSAL };
  mutateMock.mockImplementation(async (data) => { if (data?.source && typeof data.isAdmin === "boolean") context = data; return data; });
  useApiMock.mockImplementation((path: string | null) => {
    if (path?.includes("/identity-submissions")) return { data: context, isLoading: false, mutate: mutateMock };
    if (path?.startsWith("/v1/player-identities/search")) return { data: { items: path.includes("cursor=") ? [OTHER] : [TARGET, OTHER], nextCursor: path.includes("cursor=") ? null : "page2" }, error: searchError, isLoading: false, mutate: mutateMock };
    if (path?.startsWith("/v1/admin/player-identities?")) return { data: { items: [proposal], nextCursor: "queue2" }, error: listError, isLoading: false, mutate: mutateMock };
    if (path?.startsWith("/v1/admin/player-identities/submission1")) return { data: { submission: proposal, evidence: [{ gameId: "game1", date: "2026-09-06T18:30:00Z", map: "Acropolis LE", result: "Win", durationSec: 612, opponentName: SOURCE.displayName, hasReplay: true }], nextCursor: path.includes("cursor=") ? null : "evidence2" }, error: detailError, isLoading: false, mutate: mutateMock };
    return { isLoading: false, mutate: mutateMock };
  });
});
afterEach(cleanup);

async function chooseKnownPlayer(label = "Known player") {
  fireEvent.change(screen.getByLabelText(label), { target: { value: "Known" } });
  const radio = await screen.findByRole("radio", { name: /KnownPlayer Protoss · EU/ });
  fireEvent.click(radio);
}

describe("player identity picker", () => {
  it("debounces search and disambiguates names using region and stable IDs", async () => {
    const onChange = vi.fn();
    render(<PlayerIdentityPicker value={null} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Known player"), { target: { value: "Known" } });
    expect(useApiMock.mock.calls.some(([path]) => path?.includes("q=Known"))).toBe(false);
    const choices = await screen.findAllByRole("radio");
    expect(choices).toHaveLength(2);
    expect(screen.getByText(/Pulse 994428/)).toBeTruthy();
    expect(screen.getByText(/Pulse 777/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /KnownPlayer Protoss · US/ }));
    expect(onChange).toHaveBeenCalledWith(OTHER);
  });

  it("pages search results and retries failed searches", async () => {
    searchError = { message: "Service unavailable." };
    const { rerender } = render(<PlayerIdentityPicker value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Known player"), { target: { value: "Known" } });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Service unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Retry search" })); expect(mutateMock).toHaveBeenCalled();
    searchError = undefined; rerender(<PlayerIdentityPicker value={null} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next results" }));
    expect(useApiMock.mock.lastCall?.[0]).toContain("cursor=page2");
    expect(screen.getAllByRole("radio")).toHaveLength(1);
  });

  it("verifies an external SC2Pulse profile then requires explicit selection", async () => {
    const onChange = vi.fn(); apiCallMock.mockResolvedValue({ player: TARGET });
    render(<PlayerIdentityPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByText("Use a SC2Pulse profile that is not listed"));
    fireEvent.change(screen.getByLabelText("SC2Pulse profile URL or character ID"), { target: { value: "994428" } });
    fireEvent.click(screen.getByRole("button", { name: "Find SC2Pulse player" }));
    const select = await screen.findByRole("button", { name: "Select SC2Pulse player" });
    expect(apiCallMock.mock.calls[0][1]).toBe("/v1/player-identities/pulse");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ profile: "994428" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(select); expect(onChange).toHaveBeenCalledWith(TARGET);
  });
});

describe("opponent identity submissions", () => {
  it("submits only the selected identity key and evidence, then shows pending status", async () => {
    apiCallMock.mockImplementation(async () => ({ ...context, submission: PROPOSAL }));
    render(<OpponentIdentitySubmission pulseId={SOURCE.pulseId} />);
    await chooseKnownPlayer();
    fireEvent.change(screen.getByLabelText("Why is this the same player?"), { target: { value: PROPOSAL.reason } });
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ targetKey: TARGET.key, reason: PROPOSAL.reason });
    expect(await screen.findByText("Awaiting review")).toBeTruthy();
    expect(screen.getByRole("status")).toHaveProperty("textContent", expect.stringContaining("submitted for admin review"));
  });

  it("retains a rejected draft for retry when saving fails", async () => {
    apiCallMock.mockRejectedValue({ message: "This suggestion changed. Refresh before editing it." });
    context.submission = PROPOSAL;
    render(<OpponentIdentitySubmission pulseId={SOURCE.pulseId} />);
    fireEvent.click(screen.getByRole("button", { name: "Update submission" }));
    fireEvent.click(screen.getByRole("button", { name: "Update submission" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("suggestion changed"));
    expect(screen.getByLabelText("Why is this the same player?")).toHaveProperty("value", PROPOSAL.reason);
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body).submissionRevision).toBe(4);
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it("hides a new form for ineligible users while keeping confirmed identity visible", () => {
    context.eligible = false;
    context.confirmed = { groupKey: "identity:known", target: TARGET, displayName: TARGET.displayName, revision: 2 };
    render(<OpponentIdentitySubmission pulseId={SOURCE.pulseId} />);
    expect(screen.getByText("Confirmed identity · visible to everyone")).toBeTruthy();
    expect(screen.queryByLabelText("Known player")).toBeNull();
  });

  it("does not offer admin edits on an ineligible canonical player", () => {
    context.isAdmin = true; context.eligible = false;
    context.confirmed = { groupKey: "identity:known", target: TARGET, displayName: TARGET.displayName, revision: 2 };
    render(<OpponentIdentitySubmission pulseId={SOURCE.pulseId} />);
    expect(screen.queryByRole("button", { name: "Change confirmed identity" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove confirmed identity" })).toBeNull();
  });

  it("lets an admin confirm directly using the current tombstone revision", async () => {
    context.isAdmin = true; context.revision = 7;
    const onChanged = vi.fn();
    apiCallMock.mockImplementation(async () => ({ ...context, revision: 8, confirmed: { groupKey: "known", displayName: TARGET.displayName, target: TARGET, revision: 8 } }));
    render(<OpponentIdentitySubmission pulseId={SOURCE.pulseId} onChanged={onChanged} />);
    await chooseKnownPlayer();
    fireEvent.change(screen.getByLabelText("Why is this the same player?"), { target: { value: PROPOSAL.reason } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm identity" }));
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    expect(apiCallMock.mock.calls[0][1]).toBe(`/v1/opponents/${SOURCE.pulseId}/confirmed-identity`);
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body).revision).toBe(7);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("requires an explicit removal reason and safely renders a removed audit", async () => {
    context.isAdmin = true; context.revision = 3;
    context.confirmed = { groupKey: "known", displayName: TARGET.displayName, target: TARGET, revision: 3 };
    apiCallMock.mockImplementation(async () => ({ ...context, revision: 4, confirmed: null, submission: { ...PROPOSAL, target: null, status: "removed" } }));
    render(<OpponentIdentitySubmission pulseId={SOURCE.pulseId} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove confirmed identity" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Remove identity" })).toHaveProperty("disabled", true);
    fireEvent.change(within(dialog).getByLabelText("Reason for removing the identity"), { target: { value: "The original account match was incorrect." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove identity" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(apiCallMock.mock.calls[0][2].method).toBe("DELETE");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body).revision).toBe(3);
    expect(screen.getByText("Identity removed")).toBeTruthy();
  });
});

describe("admin identity review", () => {
  it("loads real replay evidence and links the submitter's full replay history", async () => {
    render(<AdminPlayerIdentitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: `Review submission for ${SOURCE.displayName}` }));
    const history = await screen.findByRole("link", { name: "Inspect full replay history" });
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Choose another player" })).toBeTruthy();
    expect(history.getAttribute("href")).toBe(`/admin/users/user_a/opponents/${SOURCE.pulseId}`);
    expect(screen.getByText("Acropolis LE")).toBeTruthy();
    expect(screen.getByText("Replay file available")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next evidence" }));
    expect(useApiMock.mock.calls.some(([path]) => path === "/v1/admin/player-identities/submission1?cursor=evidence2")).toBe(true);
  });

  it("approves with the original proposal revision and a meaningful default note", async () => {
    apiCallMock.mockResolvedValue({ submission: { ...PROPOSAL, status: "approved" } });
    render(<AdminPlayerIdentitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: `Review submission for ${SOURCE.displayName}` }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve identity" }));
    await waitFor(() => expect(apiCallMock).toHaveBeenCalledTimes(1));
    expect(apiCallMock.mock.calls[0][1]).toBe("/v1/admin/player-identities/submission1/review");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).toEqual({ decision: "approved", targetKey: TARGET.key, reviewNote: "Identity confirmed by administrator.", revision: 4 });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("requires useful rejection feedback and preserves it after a stale review conflict", async () => {
    apiCallMock.mockRejectedValue({ message: "This suggestion has changed or already been reviewed. Refresh the queue." });
    render(<AdminPlayerIdentitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: `Review submission for ${SOURCE.displayName}` }));
    fireEvent.change(await screen.findByLabelText("Review decision"), { target: { value: "rejected" } });
    expect(screen.getByRole("button", { name: "Reject submission" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByLabelText("Review note"), { target: { value: "The replay evidence does not establish this account match." } });
    fireEvent.click(screen.getByRole("button", { name: "Reject submission" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("already been reviewed"));
    expect(screen.getByLabelText("Review note")).toHaveProperty("value", "The replay evidence does not establish this account match.");
    expect(JSON.parse(apiCallMock.mock.calls[0][2].body)).not.toHaveProperty("targetKey");
  });

  it("retains dirty review changes until discard is confirmed", async () => {
    render(<AdminPlayerIdentitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: `Review submission for ${SOURCE.displayName}` }));
    fireEvent.change(await screen.findByLabelText("Review note"), { target: { value: "Review in progress" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Discard your review changes?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep reviewing" }));
    expect(screen.getByLabelText("Review note")).toHaveProperty("value", "Review in progress");
  });

  it("resets queue pagination when switching review status", () => {
    render(<AdminPlayerIdentitiesPage />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(useApiMock.mock.lastCall?.[0]).toContain("cursor=queue2");
    fireEvent.change(screen.getByLabelText("Submission status"), { target: { value: "rejected" } });
    expect(useApiMock.mock.lastCall?.[0]).toBe("/v1/admin/player-identities?status=rejected");
  });

  it("does not render review controls for non-admins", () => {
    listError = { status: 403, message: "Forbidden" };
    render(<AdminPlayerIdentitiesPage />);
    expect(screen.queryByRole("button", { name: /Review submission/ })).toBeNull();
  });
});
