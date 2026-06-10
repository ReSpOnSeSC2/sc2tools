/**
 * Deterministic min-heap event queue for the simulator. Events are
 * ordered by (time, seq) — the monotonically increasing sequence
 * number guarantees identical pop order across runs regardless of
 * insertion pattern, which is what makes whole-sim determinism cheap.
 */

export interface QueuedEvent<T> {
  time: number;
  seq: number;
  payload: T;
}

export class EventQueue<T> {
  private heap: QueuedEvent<T>[] = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, payload: T): void {
    const event: QueuedEvent<T> = { time, seq: this.seq++, payload };
    this.heap.push(event);
    this.bubbleUp(this.heap.length - 1);
  }

  peek(): QueuedEvent<T> | undefined {
    return this.heap[0];
  }

  pop(): QueuedEvent<T> | undefined {
    const top = this.heap[0];
    if (!top) return undefined;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private less(a: QueuedEvent<T>, b: QueuedEvent<T>): boolean {
    if (a.time !== b.time) return a.time < b.time;
    return a.seq < b.seq;
  }

  private bubbleUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(this.heap[i], this.heap[parent])) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  private sinkDown(index: number): void {
    const n = this.heap.length;
    let i = index;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.less(this.heap[left], this.heap[smallest])) {
        smallest = left;
      }
      if (right < n && this.less(this.heap[right], this.heap[smallest])) {
        smallest = right;
      }
      if (smallest === i) return;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}
