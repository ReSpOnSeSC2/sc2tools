import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Tabs } from "../Tabs";
afterEach(cleanup);
function Draft() { const [value, setValue] = useState(""); return <input aria-label="Draft" value={value} onChange={(event) => setValue(event.target.value)} />; }
function Example({ keepMounted = false }: { keepMounted?: boolean }) { const [value, setValue] = useState("a"); return <Tabs value={value} onValueChange={setValue}><Tabs.List ariaLabel="Example"><Tabs.Trigger value="a">Draft</Tabs.Trigger><Tabs.Trigger value="b">Other</Tabs.Trigger></Tabs.List><Tabs.Content value="a" keepMounted={keepMounted}><Draft /></Tabs.Content><Tabs.Content value="b">Other content</Tabs.Content></Tabs>; }
it.each([false, true])("preserves hidden panel state only when keepMounted=%s", (keepMounted) => {
  render(<Example keepMounted={keepMounted} />); fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsaved" } });
  fireEvent.click(screen.getByRole("tab", { name: "Other" })); expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Draft" })); expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(keepMounted ? "Unsaved" : "");
});
