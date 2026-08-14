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
    fireEvent.click(screen.getByRole("button", { name: "Publish build" }));

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
    fireEvent.click(screen.getByRole("button", { name: "Publish build" }));

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
        name: "Publish build",
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
    fireEvent.click(screen.getByRole("button", { name: "Publish build" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter the name");

    fireEvent.change(screen.getByLabelText("Name shown publicly"), {
      target: { value: "Corrected Author" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publish build" }));
    await waitFor(() => expect(harness.apiCall).toHaveBeenCalledTimes(2));
    expect(JSON.parse(harness.apiCall.mock.calls[1][2].body).authorName).toBe(
      "Corrected Author",
    );
  });
});
