import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsSaveScope } from "../SettingsSaveBar";
import { useSaveSource } from "../SettingsContext";

afterEach(cleanup);

function Draft({ tab, label, save, reset, order }: {
  tab: string; label: string; save: () => Promise<boolean>; reset: () => void; order: number;
}) {
  const [dirty, setDirty] = useState(true);
  useSaveSource(tab, {
    label, dirty, order,
    save: async () => { const saved = await save(); if (saved) setDirty(false); return saved; },
    reset: () => { reset(); setDirty(false); },
  }, label);
  return null;
}

it("saves one tab sequentially, leaves a failed draft, and retries that draft alone", async () => {
  const calls: string[] = [];
  const saveChat = vi.fn(async () => { calls.push("chat"); return true; });
  const saveBot = vi.fn(async () => { calls.push("bot"); return calls.length > 2; });
  render(<SettingsSaveScope tabId="chat">
    <Draft tab="chat" label="chat settings" save={saveChat} reset={vi.fn()} order={0} />
    <Draft tab="chat" label="bot settings" save={saveBot} reset={vi.fn()} order={1} />
  </SettingsSaveScope>);
  expect(screen.getAllByRole("button", { name: "Save all" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Save all" }));
  await screen.findByText("Saved chat settings. Couldn't save bot settings.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
  expect(calls).toEqual(["chat", "bot", "bot"]);
});

it("discards the profile and channels drafts through one bar", () => {
  const profile = vi.fn(), channels = vi.fn();
  render(<SettingsSaveScope tabId="profile">
    <Draft tab="profile" label="profile" save={vi.fn()} reset={profile} order={0} />
    <Draft tab="profile" label="channels" save={vi.fn()} reset={channels} order={1} />
  </SettingsSaveScope>);
  fireEvent.click(screen.getByRole("button", { name: /discard/i }));
  expect(profile).toHaveBeenCalledOnce();
  expect(channels).toHaveBeenCalledOnce();
});
