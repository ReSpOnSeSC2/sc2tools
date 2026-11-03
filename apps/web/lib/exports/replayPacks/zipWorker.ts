import { createZipWorkerProtocol, type ZipOutput } from "./zipWorkerProtocol";

interface ZipWorkerScope {
  postMessage(message: ZipOutput, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: (() => void) | null;
}
// Local worker-only global shape avoids mixing DOM and webworker lib declarations.
const scope = globalThis as unknown as ZipWorkerScope;
const protocol = createZipWorkerProtocol((message, transfer) => scope.postMessage(message, transfer));
scope.onmessage = event => {
  void protocol.receive(event.data).catch(() => { setTimeout(() => { throw new Error("zip_job_failed"); }, 0); });
};
scope.onmessageerror = () => protocol.fatal();
