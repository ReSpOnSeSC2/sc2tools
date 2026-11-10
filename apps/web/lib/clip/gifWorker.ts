import { createGifWorkerProtocol, type GifWorkerOutput } from "./gifWorkerProtocol";

interface GifWorkerScope {
  postMessage(message: GifWorkerOutput, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onmessageerror: (() => void) | null;
}
// Local worker-only global shape avoids mixing DOM and webworker lib declarations.
const scope = globalThis as unknown as GifWorkerScope;
const protocol = createGifWorkerProtocol((message, transfer) => scope.postMessage(message, transfer));
scope.onmessage = (event) => protocol.receive(event.data);
scope.onmessageerror = () => protocol.receive(null);
