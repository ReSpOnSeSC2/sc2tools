import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BuildPublishModal } from "./BuildPublishModal";

const harness = vi.hoisted(() => ({
  apiCall: vi.fn(),
  getToken: vi.fn(async () => "token"),
  onPublished: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ getToken: harness.getToken }),
}));

vi.mock("@/lib/clientApi", () => ({
  apiCall: harness.apiCall,
  useApi: () => ({ mutate: vi.fn() }),
}));

const build = {
  slug: "pvt-three-gate",
  name: "PvT Three Gate",
  race: "Protoss" as const,
  isPublic: true,
};

function renderModal() {
  return render(
    <BuildPublishModal
      open
      build={build}
      onClose={harness.onClose}
      onPublished={harness.onPublished}
    />,
  );
}

async function acknowledge() {
  fireEvent.click(
    await screen.findByRole("checkbox", { name: /Public data acknowledged/i }),
  );
}

beforeEach(() => {
  harness.apiCall.mockReset();
  harness.getToken.mockClear();
  harness.onPublished.mockReset();
  harness.onClose.mockReset();
});

afterEach(() => cleanup());

describe("BuildPublishModal community identity", () => {
  it("offers Unpublish inside an existing listing and uses the same confirmation and owner repair", async () => {
    harness.apiCall.mockResolvedValueOnce({ published: true, publicSlug: "public-three-gate", authorName: "Owner", publishAnonymously: false, mirrorPending: false }).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ published: false, publicSlug: null, mirrorPending: false });
    renderModal();
    expect(await screen.findByRole("heading", { name: "Update your Community listing" })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("button", { name: "Unpublish" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    const buttons = screen.getAllByRole("button", { name: "Unpublish" });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(harness.onClose).toHaveBeenCalledOnce());
    expect(harness.apiCall.mock.calls.slice(1).map((call) => [call[1], call[2]?.method ?? "GET"])).toEqual([["/v1/community/builds/public-three-gate", "DELETE"], ["/v1/community/my-build-publication/pvt-three-gate", "GET"]]);
  });

  it("copies the successful publication's actual public link and names the menu path", async () => {
    const writeText = vi.fn(async () => undefined); Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    harness.apiCall.mockResolvedValueOnce({ published: false, publicSlug: null, authorName: "Owner", publishAnonymously: false }).mockResolvedValueOnce({ slug: "different-public-slug" });
    renderModal();
    await waitFor(() => expect((screen.getByLabelText("Name shown publicly") as HTMLInputElement).value).toBe("Owner"));
    expect(screen.getByText(/unpublish any time from the build's ⋯ menu/)).toBeTruthy();
    await acknowledge(); fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/community/builds/different-public-slug`));
  });
  it("loads the named default and publishes it unless anonymous is explicitly selected", async () => {
    harness.apiCall
      .mockResolvedValueOnce({
        published: false,
        publicSlug: null,
        authorName: "Profile Author",
        publishAnonymously: false,
      })
      .mockResolvedValueOnce({ slug: "public-three-gate" });
    renderModal();

    const name = await screen.findByLabelText("Name shown publicly");
    await waitFor(() => expect((name as HTMLInputElement).value).toBe("Profile Author"));
    expect(
      (screen.getByRole("checkbox", {
        name: /Post anonymously/i,
      }) as HTMLInputElement).checked,
    ).toBe(false);
    await acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(2));
    const body = JSON.parse(harness.apiCall.mock.calls[1][2].body);
    expect(body).toMatchObject({
      slug: build.slug,
      authorName: "Profile Author",
      publishAnonymously: false,
    });
  });

  it("hydrates and preserves an existing anonymous choice", async () => {
    harness.apiCall
      .mockResolvedValueOnce({
        published: true,
        publicSlug: "public-three-gate",
        authorName: "Profile Author",
        publishAnonymously: true,
      })
      .mockResolvedValueOnce({ slug: "public-three-gate" });
    renderModal();

    const anonymous = await screen.findByRole("checkbox", {
      name: /Post anonymously/i,
    });
    await waitFor(() => expect((anonymous as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText("Name shown publicly") as HTMLInputElement).disabled).toBe(true);
    await acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Update listing" }));

    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(2));
    const body = JSON.parse(harness.apiCall.mock.calls[1][2].body);
    expect(body.publishAnonymously).toBe(true);
    expect(body.authorName).toBeUndefined();
  });

  it("keeps a fatal identity-load error visible and blocks a risky update", async () => {
    harness.apiCall.mockRejectedValueOnce(new Error("offline"));
    renderModal();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("current author setting");
    fireEvent.change(screen.getByLabelText(/Public title/i), {
      target: { value: "Edited title" },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "current author setting",
    );
    await acknowledge();
    expect(
      (screen.getByRole("button", {
        name: "Update listing",
      }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(harness.apiCall).toHaveBeenCalledTimes(1);
  });

  it("lets the user correct a blank named choice and retry", async () => {
    harness.apiCall
      .mockResolvedValueOnce({
        published: false,
        publicSlug: null,
        authorName: "",
        publishAnonymously: false,
      })
      .mockResolvedValueOnce({ slug: "public-three-gate" });
    renderModal();
    await screen.findByLabelText("Name shown publicly");
    await acknowledge();
    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter the name");

    fireEvent.change(screen.getByLabelText("Name shown publicly"), {
      target: { value: "Corrected Author" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish…" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(2));
    expect(JSON.parse(harness.apiCall.mock.calls[1][2].body).authorName).toBe(
      "Corrected Author",
    );
  });
});
