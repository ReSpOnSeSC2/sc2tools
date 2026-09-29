import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { OverlayCredit } from "../OverlayCredit";
import { OVERLAY_CREDIT_TEXT } from "@/lib/overlayCredit";

afterEach(cleanup);

describe("OverlayCredit", () => {
  it("renders the credit at the requested placement without catching clicks", () => {
    render(<OverlayCredit placement="bottom-center" />);

    const credit = screen.getByTestId("overlay-credit");
    expect(credit.textContent).toBe(OVERLAY_CREDIT_TEXT);
    expect(credit.getAttribute("data-placement")).toBe("bottom-center");
    expect(credit.style.pointerEvents).toBe("none");
  });

  it("renders nothing when the caller hides it", () => {
    render(<OverlayCredit visible={false} />);

    expect(screen.queryByTestId("overlay-credit")).toBeNull();
  });
});
