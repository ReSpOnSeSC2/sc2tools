"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
import { Sheet } from "@/components/ui/Sheet";
import { useConfirm } from "@/components/ui/useConfirm";
import { useToast } from "@/components/ui/Toast";

type Overlay = "modal" | "bottom" | "right" | "confirm" | null;

export function OverlaySamples() {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [popover, setPopover] = useState(false);
  const [notice, setNotice] = useState("");
  const anchor = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const popoverId = useId();
  const decision = useConfirm("design-gallery");
  const { toast } = useToast();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = () => setOverlay(null);
  const finish = () => { setNotice("Example confirmation accepted. No data was changed."); close(); };
  const previewConfirm = async () => {
    const approved = await decision.confirm({ title: "Confirm this example?", description: "This preview does not change any saved data.", confirmLabel: "Accept example", focusCancel: true });
    if (!mounted.current) return;
    setNotice(approved ? "Promise example accepted. No data was changed." : "Promise example canceled.");
  };
  return <Card title="Overlay and feedback examples" headingLevel={3} padded>
    <div className="space-y-5">
      <div className="flex flex-wrap gap-3"><Button variant="secondary" onClick={() => setOverlay("modal")}>Open Modal</Button><Button variant="secondary" onClick={() => setOverlay("bottom")}>Open bottom Sheet</Button><Button variant="secondary" onClick={() => setOverlay("right")}>Open right Sheet</Button>
        <Button ref={anchor} variant="secondary" aria-expanded={popover} aria-controls={popoverId} aria-haspopup="dialog" onClick={() => setPopover(value => !value)}>Open Popover</Button>
        <Button variant="secondary" onClick={() => setOverlay("confirm")}>Open ConfirmDialog</Button><Button variant="secondary" onClick={() => { void previewConfirm(); }}>Try useConfirm</Button>
      </div>
      <div className="flex flex-wrap gap-3"><CopyButton text="Design gallery: example text" scopeKey="design-gallery">Copy example text</CopyButton>
        <Button variant="ghost" onClick={() => toast.success("Example saved", { description: "Local preview only. No data was changed." })}>Success Toast</Button>
        <Button variant="ghost" onClick={() => toast.info("Example notice")}>Info Toast</Button>
        <Button variant="ghost" onClick={() => toast.error("Example error", { description: "A preview of the error state." })}>Error Toast</Button>
      </div>
      <p className="text-caption text-text-muted">Copy uses your clipboard only when selected. If the browser denies access, the selected text remains available for manual copying.</p>
      <p role="status" className="text-caption">{notice}</p>
    </div>
    <Modal open={overlay === "modal"} onClose={close} title="Modal example" description="A modal keeps keyboard focus inside until it closes." footer={<Button onClick={close}>Close example</Button>}><OverlayBody /></Modal>
    <Sheet open={overlay === "bottom"} onClose={close} side="bottom" title="Bottom Sheet example" footer={<Button onClick={close}>Close example</Button>}><OverlayBody /></Sheet>
    <Sheet open={overlay === "right"} onClose={close} side="right" title="Right Sheet example" footer={<Button onClick={close}>Close example</Button>}><OverlayBody /></Sheet>
    <Popover open={popover} onClose={() => setPopover(false)} anchorRef={anchor} id={popoverId} label="Popover example"><div className="space-y-4"><p className="text-caption">This is nonmodal. Tab can continue to the page; Escape closes this example.</p><Button onClick={() => setPopover(false)}>Close Popover</Button></div></Popover>
    <ConfirmDialog open={overlay === "confirm"} onClose={close} onConfirm={finish} title="Confirm an example?" description="Nothing will be deleted or saved." intent="danger" confirmLabel="Accept example" focusCancel />
    {decision.dialog}
  </Card>;
}

function OverlayBody() {
  return <div className="space-y-4"><Field label="Example dialog input"><Input placeholder="Try Tab and Shift+Tab" /></Field><details><summary className="cursor-pointer text-caption">Example details</summary><p className="mt-2 text-caption text-text-muted">Hidden controls stay outside the Tab order until this disclosure opens.</p><Button variant="secondary" size="sm">Inside disclosure</Button></details></div>;
}
