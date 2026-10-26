import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useConfirm } from "../useConfirm";

afterEach(cleanup);
function Example({ scopeKey = "owner-a" }: { scopeKey?: string }) {
  const { confirm, dialog } = useConfirm(scopeKey);
  return <><button onClick={async () => { const accepted = await confirm({ title: "Disconnect account?", intent: "danger", confirmLabel: "Disconnect", focusCancel: true }); document.getElementById("decision")!.textContent = String(accepted); }}>Disconnect provider</button><output id="decision" />{dialog}</>;
}
it("resolves only explicit approval true and returns focus to the original control", async () => {
  render(<StrictMode><Example /></StrictMode>);
  const trigger = screen.getByRole("button", { name: "Disconnect provider" });
  trigger.focus(); fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("true");
  expect(screen.queryByRole("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it.each(["Escape", "Cancel", "scrim"])("resolves %s dismissal false", async mode => {
  render(<Example />); fireEvent.click(screen.getByRole("button", { name: "Disconnect provider" }));
  if (mode === "Escape") fireEvent.keyDown(document, { key: "Escape" });
  else fireEvent.click(screen.getByRole("button", { name: mode === "scrim" ? "Close dialog" : "Cancel" }));
  await act(async () => {});
  expect(screen.getByRole("status").textContent).toBe("false");
});
it("settles concurrency, context changes and unmount without approving an obsolete request", async () => {
  const { result, rerender, unmount } = renderHook(({ scope }) => useConfirm(scope), { initialProps: { scope: "a" }, wrapper: StrictMode });
  let first!: Promise<boolean>, duplicate!: Promise<boolean>;
  act(() => { first = result.current.confirm({ title: "First" }); duplicate = result.current.confirm({ title: "Duplicate" }); });
  await expect(duplicate).resolves.toBe(false);
  const stale = result.current.dialog!;
  rerender({ scope: "b" }); await expect(first).resolves.toBe(false);
  let next!: Promise<boolean>; act(() => { next = result.current.confirm({ title: "Next" }); });
  act(() => { (stale.props as { onConfirm: () => void }).onConfirm(); });
  const settled = vi.fn(); void next.then(settled);
  await act(async () => {}); expect(settled).not.toHaveBeenCalled();
  unmount(); await expect(next).resolves.toBe(false);
});
it("rejects a saved old-context confirm function after an owner change or ABA return", async () => {
  const { result, rerender } = renderHook(({ scope }) => useConfirm(scope), { initialProps: { scope: "a" } });
  const staleConfirm = result.current.confirm;
  const staleCancel = result.current.cancel;
  rerender({ scope: "b" });
  await expect(staleConfirm({ title: "Delete old account" })).resolves.toBe(false);
  expect(result.current.dialog).toBeNull();
  let current!: Promise<boolean>;
  act(() => { current = result.current.confirm({ title: "Current account" }); staleCancel(); });
  expect(result.current.dialog).not.toBeNull();
  act(() => { result.current.cancel(); });
  await expect(current).resolves.toBe(false);
  rerender({ scope: "a" });
  await expect(staleConfirm({ title: "Delete old account" })).resolves.toBe(false);
  expect(result.current.dialog).toBeNull();
});
