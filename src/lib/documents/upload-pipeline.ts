// The hand-off between the dropzone's upload workers and its processing
// workers: uploads push each document the moment its row registers, and
// processing takes documents as they arrive instead of waiting for the
// whole batch to land. Pure — no IO — so the hand-off is testable alone.

export type Channel<T> = {
  /** Hand an item to a waiting consumer, or queue it for the next take. */
  push(item: T): void;
  /** Nothing more is coming: once the queue drains, takes resolve
   *  undefined. Idempotent. */
  close(): void;
  /** The next item, or undefined once the channel is closed and empty. */
  take(): Promise<T | undefined>;
  readonly closed: boolean;
};

export function createChannel<T>(): Channel<T> {
  const items: T[] = [];
  const waiters: Array<(item: T | undefined) => void> = [];
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    push(item) {
      if (closed) throw new Error("Channel is closed.");
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else items.push(item);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter(undefined);
    },
    take() {
      if (items.length > 0) return Promise.resolve(items.shift());
      if (closed) return Promise.resolve(undefined);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

/** Runs `worker` over everything the channel delivers, at most
 *  `concurrency` at a time, and resolves once the channel is closed and
 *  every item has been worked. A worker that throws rejects the drain;
 *  callers that want per-item failure containment catch inside the
 *  worker. */
export async function drain<T>(
  channel: Channel<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      for (
        let item = await channel.take();
        item !== undefined;
        item = await channel.take()
      ) {
        await worker(item);
      }
    }),
  );
}
