import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { OverlayCreditToggle } from "../OverlayCreditToggle";
import { OVERLAY_CREDIT_TEXT } from "@/lib/overlayCredit";

afterEach(cleanup);

describe("OverlayCreditToggle", () => {
  it("names the credit and reflects the current choice", () => {
    render(<OverlayCreditToggle checked onChange={vi.fn()} />);

    const toggle = screen.getByRole("switch", { name: `Show “${OVERLAY_CREDIT_TEXT}” on stream` });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/changes apply to connected Browser Sources/i)).toBeTruthy();
  });

  it("flips the choice from the switch and from its explanation", () => {
    const onChange = vi.fn();
    render(<OverlayCreditToggle checked={false} onChange={onChange} />);

    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByText(/changes apply to connected Browser Sources/i));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
