import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefinitionsCatalog } from "./DefinitionsCatalog";
import { BUILD_DEFINITIONS } from "@/lib/build-definitions";
import { parseClassifierTrust } from "@/lib/classifierTrust";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams("") }));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ getToken: vi.fn(), userId: null, isLoaded: true, isSignedIn: false }) }));
vi.mock("@/lib/clientApi", () => ({ useApi: () => ({ data: undefined, isLoading: false }) }));
afterEach(cleanup);

const [first, second] = BUILD_DEFINITIONS.filter((def) => !/Unclassified|Too Short/.test(def.name));

describe("/definitions trust lines", () => {
  it("shows 'Matches N of M player corrections' only on rules with published counts, plus one InfoTip", () => {
    render(<DefinitionsCatalog trust={{ [first.name]: { matches: 1234, corrections: 1500 } }} />);
    const card = document.getElementById(first.id) as HTMLElement;
    expect(within(card).getByText(`Matches ${(1234).toLocaleString()} of ${(1500).toLocaleString()} player corrections`)).toBeTruthy();
    expect(within(document.getElementById(second.id) as HTMLElement).queryByText(/player corrections/)).toBeNull();
    expect(screen.getAllByRole("button", { name: "About player corrections" })).toHaveLength(1);
    expect(document.body.textContent).not.toMatch(/accura|%/i);
  });

  it("renders no trust copy without data", () => {
    render(<DefinitionsCatalog trust={null} />);
    expect(screen.queryByText(/player corrections/)).toBeNull();
    expect(screen.queryByRole("button", { name: "About player corrections" })).toBeNull();
  });

  it("parses only well-formed rows", () => {
    expect(parseClassifierTrust({ labels: [
      { label: "A", matches: 2, corrections: 5 },
      { label: "B", matches: 6, corrections: 5 },
      { label: "C", matches: 1, corrections: 0 },
      { label: "", matches: 1, corrections: 2 },
      { label: "D", matches: -1, corrections: 2 },
      { label: "E", matches: 1.5, corrections: 2 },
      null,
    ] })).toEqual({ A: { matches: 2, corrections: 5 } });
    expect(parseClassifierTrust(null)).toBeNull();
    expect(parseClassifierTrust({ labels: "nope" })).toBeNull();
  });
});
