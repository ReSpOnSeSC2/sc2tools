import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LockerContentStudioEditor, type StudioAnnotationProps } from "./LockerContentStudioEditor";
import { studioAnnotatedFile, validateStudioDraft } from "./lockerContentStudioModel";

function Annotation({ onSave }: StudioAnnotationProps) {
  return <button type="button" onClick={() => onSave("data:image/jpeg;base64,/9j/2Q==")}>Save test annotation</button>;
}

const props = { studentName: "Fixture Student", busy: false, revisionChanged: false, Annotation };
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("inserts the editable Classic framework and preserves an unsaved draft through a revision conflict", async () => {
  const close = vi.fn(), review = vi.fn();
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const renderEditor = (revisionChanged: boolean) => <LockerContentStudioEditor {...props} kind="notes" revisionChanged={revisionChanged}
    onReviewLatest={review} onClose={close} onAdd={save} />;
  const { rerender } = render(renderEditor(false));
  const notes = screen.getByRole("textbox", { name: "Session notes" });
  fireEvent.change(notes, { target: { value: "My draft" } });
  fireEvent.click(await screen.findByRole("button", { name: "Insert session structure" }));
  fireEvent.click(screen.getByRole("button", { name: "Add to shelf" }));
  await screen.findByText("The item was not added. Your draft is still here.");
  expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ notes: expect.stringMatching(/^My draft\n\nKEEP/) }));
  expect(close).not.toHaveBeenCalled();
  rerender(renderEditor(true));
  expect((screen.getByRole("button", { name: "Add to shelf" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Use the latest shelf revision" }));
  expect(review).toHaveBeenCalledOnce();
  rerender(renderEditor(false));
  fireEvent.click(screen.getByRole("button", { name: "Add to shelf" }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
});

test("voice file fallback sends the shared note without the private speaking outline", async () => {
  const save = vi.fn(async () => true), close = vi.fn();
  const createObjectURL = vi.fn(() => "blob:fixture-voice"), revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  const { unmount } = render(<LockerContentStudioEditor {...props} kind="voice" onReviewLatest={vi.fn()} onClose={close} onAdd={save} />);
  fireEvent.change(screen.getByLabelText("Private speaking outline"), { target: { value: "Keep this draft private" } });
  fireEvent.change(screen.getByLabelText("Coaching note"), { target: { value: "Share this note" } });
  const file = new File(["fixture"], "memo.webm", { type: "audio/webm" });
  fireEvent.change(screen.getByLabelText("Attach an audio file"), { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Add to shelf" }));
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(save).toHaveBeenCalledWith({ kind: "voice", title: "Voice memo", notes: "Share this note", link: "", file });
  expect(JSON.stringify(save.mock.calls)).not.toContain("Keep this draft private");
  unmount(); expect(revokeObjectURL).toHaveBeenCalledWith("blob:fixture-voice");
});

test("restricts links, replay uploads, PDF files and annotation images to supported formats", async () => {
  const draft = { title: "", notes: "note", link: "" };
  await expect(validateStudioDraft({ ...draft, kind: "video", link: "https://person:secret@example.invalid/" })).rejects.toThrow("credentials");
  await expect(validateStudioDraft({ ...draft, kind: "replay", file: new File(["test"], "bad.txt") })).rejects.toThrow(".SC2Replay");
  await expect(validateStudioDraft({ ...draft, kind: "pdf", file: new File(["renamed HTML"], "bad.pdf") })).rejects.toThrow("valid PDF");
  await expect(validateStudioDraft({ ...draft, kind: "pdf", file: new File(["%PDF-1.7\nFixture"], "good.pdf") })).resolves.toMatchObject({ title: "PDF practice card" });
  expect(studioAnnotatedFile("data:image/jpeg;base64,/9j/2Q==")).toMatchObject({ type: "image/jpeg", size: 4 });
  expect(() => studioAnnotatedFile("data:image/svg+xml;base64,PHN2Zz4=")).toThrow("screenshot");
});
