import { describe, expect, it } from "vitest";

import { createChannel, drain } from "./upload-pipeline";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createChannel", () => {
  it("delivers queued items in order, then undefined once closed", async () => {
    const channel = createChannel<number>();
    channel.push(1);
    channel.push(2);
    channel.close();
    expect(await channel.take()).toBe(1);
    expect(await channel.take()).toBe(2);
    expect(await channel.take()).toBeUndefined();
    expect(channel.closed).toBe(true);
  });

  it("hands a later push to a consumer already waiting", async () => {
    const channel = createChannel<string>();
    const waiting = channel.take();
    channel.push("a");
    expect(await waiting).toBe("a");
  });

  it("releases waiting consumers with undefined on close", async () => {
    const channel = createChannel<string>();
    const first = channel.take();
    const second = channel.take();
    channel.close();
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
  });

  it("refuses a push after close", () => {
    const channel = createChannel<number>();
    channel.close();
    expect(() => channel.push(1)).toThrow("Channel is closed.");
  });
});

describe("drain", () => {
  it("works items as they arrive, never more than `concurrency` at once, and settles only after close", async () => {
    const channel = createChannel<number>();
    const release: Array<() => void> = [];
    const seen: number[] = [];
    let active = 0;
    let maxActive = 0;
    let settled = false;
    const finished = drain(channel, 2, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => release.push(resolve));
      seen.push(n);
      active -= 1;
    });
    void finished.then(() => {
      settled = true;
    });

    // Three arrive at once: two start, one waits for a slot.
    channel.push(1);
    channel.push(2);
    channel.push(3);
    await tick();
    expect(active).toBe(2);

    // Finishing one admits the third.
    release.shift()!();
    await tick();
    expect(active).toBe(2);
    expect(seen).toEqual([1]);

    // An item that arrives mid-drain is picked up too; nothing settles
    // until the producer closes the channel.
    channel.push(4);
    while (release.length > 0) release.shift()!();
    await tick();
    expect(settled).toBe(false);
    channel.close();
    while (!settled) {
      while (release.length > 0) release.shift()!();
      await tick();
    }
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect(maxActive).toBe(2);
  });

  it("resolves immediately on a channel closed empty", async () => {
    const channel = createChannel<number>();
    channel.close();
    let calls = 0;
    await drain(channel, 3, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });
});
