// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createZipWorkerProtocol, type ZipOutput } from "./zipWorkerProtocol";

const job = "synthetic-zip-job-01";
const tick = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };

describe("owned ZIP worker output protocol", () => {
  it("admits only one output until its exact job/sequence ACK and abort settles the held input", async () => {
    const messages: ZipOutput[] = [];
    const protocol = createZipWorkerProtocol((message, transfer) => messages.push(structuredClone(message, { transfer })));
    await protocol.receive({ job, type: "start" });
    const work = protocol.receive({ job, type: "entry", id: 1, name: "one.SC2Replay", kind: "replay", bytes: new Uint8Array(70000).buffer });
    await tick(); expect(messages.filter(message => message.type === "chunk")).toHaveLength(1);
    await protocol.receive({ job: "different-zip-job-02", type: "ack", seq: 1 }); await tick();
    expect(messages.filter(message => message.type === "chunk")).toHaveLength(1);
    await protocol.receive({ job, type: "ack", seq: 1 }); await tick();
    expect(messages.filter(message => message.type === "chunk")).toHaveLength(2);
    await protocol.receive({ job, type: "abort" }); await work;
    expect(messages.at(-1)).toEqual({ job, type: "settled", status: "aborted" });
    expect(messages.some(message => message.type === "entry-done")).toBe(false);
    const count = messages.length;
    await protocol.receive({ job, type: "entry", id: 2, name: "two.SC2Replay", kind: "replay", bytes: new Uint8Array(4).buffer });
    expect(messages).toHaveLength(count);
  });

  it.each(["nack", "fatal", "wrong-ack"])("%s rejects the outstanding output wait and settles admitted input without a success ACK", async kind => {
    const messages: ZipOutput[] = [], protocol = createZipWorkerProtocol(message => { messages.push(message); });
    await protocol.receive({ job, type: "start" });
    const work = protocol.receive({ job, type: "entry", id: 1, name: "one.SC2Replay", kind: "replay", bytes: new Uint8Array(4).buffer });
    await tick();
    if (kind === "fatal") protocol.fatal();
    else await protocol.receive({ job, type: kind === "nack" ? "nack" : "ack", seq: kind === "wrong-ack" ? 2 : 1 });
    await work;
    expect(messages.filter(message => message.type === "chunk")).toHaveLength(1);
    expect(messages.at(-1)).toEqual({ job, type: "settled", status: "failed" });
  });

  it("pre-job message deserialization failure throws only a fixed worker error and cannot later report ready", async () => {
    const messages: ZipOutput[] = [], protocol = createZipWorkerProtocol(message => { messages.push(message); });
    expect(() => protocol.fatal()).toThrow("zip_job_failed");
    await protocol.receive({ job, type: "start" }); expect(messages).toHaveLength(0);
  });
});
